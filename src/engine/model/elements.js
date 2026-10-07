// @ts-check
// The element model of one VIEW (E §5.3 `ElementModel`, `ViewModel`; E D5 coercion; E D2 runtime
// z re-sort). `wms/build.js` constructs it; the layout pass, the binding engine, the animator, the
// object model and the renderer read and write it through the contract.
//
// What lives here, and only here:
//  - the typed value store. `set` resolves the attribute through `attrSpecFor` (so an `x-` host
//    attribute accepts writes from a sidecar and from nobody else), coerces to its type (an
//    invalid value keeps the previous one, U-20) and reports whether anything changed;
//  - the dirty set (`takeDirty`) the renderer drains once a frame;
//  - the `<attr>_onchange` queue (`takeQueuedEvents`), FIFO, filled by every change except origin
//    'init' and 'quiet' and only for an element that has such a handler ('quiet' is a post-load
//    write that updates the element and whoever follows it but is not news to the realm);
//  - the id indexes (exact, then case-folded), which are Maps because ids are skin text and
//    `__proto__` and `constructor` are ordinary ids (E §1 rule 6);
//  - the paint-order cache, dropped for one parent when a child's z changes.
//
// Attribute keys are lower case everywhere they leave this module (the dirty sets, `onChange`, the
// handler map), because the attribute tables are keyed that way and every caller may spell an
// attribute in any case. A PLAYER handler is keyed as the markup spelled it (`playstatechange` or
// `onplaystatechange`), not normalised: the dispatcher tries both.
//
// Not contract: `hostStyle` on a sidecar overlay's element, and the internal `put` the builder
// uses to write read-only values (`buttonCount`, `index`) without raising a change.

import { attrSpecFor, isHostOnlyAttr } from '../wms/attrs.js';
import { classifyValueDiag, coerce } from '../wms/values.js';
import { resolveStringAttribute } from '../realm/wmploc.js';
import { paintOrder as computePaintOrder } from '../layout/stack.js';

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').ViewModel} ViewModel */
/** @typedef {import('../contracts').ElementKind} ElementKind */
/** @typedef {import('../contracts').AttrValue} AttrValue */
/** @typedef {import('../contracts').AttrSource} AttrSource */
/** @typedef {import('../contracts').HandlerSite} HandlerSite */
/** @typedef {import('../contracts').Origin} Origin */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */

/**
 * An element as the builder hands it over: every map is already in its final, typed form.
 * @typedef {Object} ElementInit
 * @property {string} tag
 * @property {ElementKind} kind
 * @property {string} id                       declared, or `Unnamed_<kind>_<n>`
 * @property {boolean} declared                false when the id was generated
 * @property {ElementModel | null} parent
 * @property {Map<string, AttrValue>} values   known attributes the markup set, coerced; the rest read as defaults
 * @property {Map<string, string>} unknown     attributes the kind has no behaviour for: inert text
 * @property {Map<string, AttrSource>} sources how the markup spelled each attribute
 * @property {Map<string, HandlerSite>} handlers
 * @property {number} [line]                   source line, for diagnostics
 * @property {{ letterSpacing?: string }} [hostStyle]   sidecar overlays only
 */

/**
 * @typedef {Object} ViewModelOptions
 * @property {'context' | 'flat'} [stacking]   default 'context' (Reading C)
 * @property {number} maxViewAxis              a VIEW's width and height clamp here (E §10)
 * @property {(d: Diagnostic) => void} report
 * @property {() => number} nextHandle         session-unique element handles, > 0
 */

/** The element with its extras. @typedef {ElementModel & { readonly hostStyle?: { letterSpacing?: string } }} BuiltElement */

/**
 * How many `_onchange` events may wait for a drain. A script loop that rewrites an attribute a
 * million times in its budget must not grow the queue without bound; the cap is not in
 * `BuildCaps`, so it is private.
 */
const MAX_QUEUED_EVENTS = 4096;

/** @param {unknown} s */
const lower = (s) => String(s).toLowerCase();

/** @param {string} s */
const clip = (s) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

/**
 * The state one view's elements share.
 * @typedef {Object} ViewState
 * @property {ViewModelOptions} opts
 * @property {Element[]} elements
 * @property {Map<number, Element>} byHandle
 * @property {Map<string, Element>} exact
 * @property {Map<string, Element>} folded
 * @property {Set<(el: ElementModel, attr: string, v: AttrValue, origin: Origin) => void>} listeners
 * @property {Map<ElementModel, Set<string>>} dirty
 * @property {Array<{ el: ElementModel, event: string }>} queue
 * @property {Map<ElementModel, ReadonlyArray<ElementModel | 'background'>>} orders
 * @property {'context' | 'flat'} stacking   the mode `orders` was computed in
 * @property {boolean} queueCapReported
 */

/**
 * Forget the cached paint order that a change under `from` can have made stale. In a stacking
 * context a container's list holds only its own children, so only `from` itself is stale. In flat
 * mode a container's list holds every descendant, so every ancestor's list is stale too (a view's
 * depth is capped, so the walk is short).
 * @param {ViewState} state @param {ElementModel} from
 */
function forgetOrders(state, from) {
  state.orders.delete(from);
  if (state.stacking !== 'flat' || state.orders.size === 0) return;
  for (let up = from.parent; up; up = up.parent) state.orders.delete(up);
}

/** @implements {ElementModel} */
class Element {
  /**
   * @param {ViewState} state @param {ElementInit} init @param {number} handle @param {number} docIndex
   */
  constructor(state, init, handle, docIndex) {
    this._state = state;
    this.handle = handle;
    this.docIndex = docIndex;
    this.kind = init.kind;
    this.tag = init.tag;
    this.id = init.id;
    this.parent = init.parent;
    /** @type {Element[]} */
    this._children = [];
    this._values = init.values;
    this._unknown = init.unknown;
    this._sources = init.sources;
    this.handlers = init.handlers;
    if (init.hostStyle) this.hostStyle = init.hostStyle;
  }

  /** @returns {readonly ElementModel[]} */
  get children() { return this._children; }

  /** @param {string} attr @returns {AttrValue} */
  get(attr) {
    const key = lower(attr);
    if (key === 'id') return this.id;
    const stored = this._values.get(key);
    if (stored !== undefined) return stored;
    if (key === 'elementtype') return this.tag.toUpperCase();
    // Resolving as 'sidecar' lets a host-only attribute read back its default; a write still has
    // to come from a sidecar (see `set`).
    const spec = attrSpecFor(this.kind, key, 'sidecar');
    if (spec) return /** @type {AttrValue} */ (spec.default);
    // Inert text is readable by the host, but never under a host-only name: a skin that writes
    // `x-foregroundMode` itself must not be able to reach a host switch that way.
    if (isHostOnlyAttr(key)) return null;
    return this._unknown.get(key) ?? null;
  }

  /** @param {string} attr @param {unknown} v @param {Origin} origin @returns {boolean} */
  set(attr, v, origin) {
    const key = lower(attr);
    // The id is how the element is found; it is fixed when the element is built.
    if (key === 'id') return false;
    const spec = attrSpecFor(this.kind, key, origin);
    if (!spec) return false;
    // Read-only attributes are written by markup and by the host (the renderer's `textWidth`).
    if (spec.access === 'r' && origin !== 'init' && origin !== 'host') return false;
    const state = this._state;
    const prev = this.get(key);

    let input = v;
    if (spec.type === 'string' && typeof v === 'string' && /^\s*res:\/\//i.test(v)) {
      const r = resolveStringAttribute(key, v);
      if (r.problem) {
        state.opts.report({ code: 'unresolved-res', severity: 'info', elementId: this.id,
          detail: `${key}="${clip(v)}" names no resource in the library (${r.problem})` });
      }
      input = r.value;
    }

    let next = coerce(spec.type, input, prev);
    if (this.kind === 'view' && (key === 'width' || key === 'height') && typeof next === 'number' && next > state.opts.maxViewAxis) {
      state.opts.report({ code: 'cap-view-size', severity: 'warn', elementId: this.id,
        detail: `${key}=${next} is over the ${state.opts.maxViewAxis}-px limit and is clamped` });
      next = state.opts.maxViewAxis;
    }
    if (Object.is(prev, next)) return false;

    const value = /** @type {AttrValue} */ (next);
    this._values.set(key, value);
    if (spec.type === 'handler') this.#syncHandler(key, String(value));
    if (key === 'zindex' && this.parent) forgetOrders(state, this.parent);

    let marks = state.dirty.get(this);
    if (!marks) state.dirty.set(this, (marks = new Set()));
    marks.add(key);

    if (origin !== 'init' && origin !== 'quiet') {
      const event = `${key}_onchange`;
      if (this.handlers.has(event)) {
        if (state.queue.length < MAX_QUEUED_EVENTS) state.queue.push({ el: this, event });
        else if (!state.queueCapReported) {
          state.queueCapReported = true;
          state.opts.report({ code: 'cap-onchange-queue', severity: 'warn', elementId: this.id,
            detail: `more than ${MAX_QUEUED_EVENTS} _onchange events waited for a drain; later ones are dropped` });
        }
      }
    }

    for (const cb of [...state.listeners]) {
      try {
        cb(this, key, value, origin);
      } catch (e) {
        state.opts.report({ code: 'listener-error', severity: 'error', elementId: this.id,
          detail: `a change listener threw: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return true;
  }

  /** @param {string} attr @returns {AttrSource | undefined} */
  source(attr) { return this._sources.get(lower(attr)); }

  /**
   * A script that assigns a handler attribute replaces its handler. The params are the attribute's
   * own (a PLAYER event keeps its parameter names).
   * @param {string} key @param {string} text
   */
  #syncHandler(key, text) {
    if (text === '') { this.handlers.delete(key); return; }
    const { source } = classifyValueDiag(this.kind, key, text);
    this.handlers.set(key, { event: key, source: text, params: source.kind === 'handler' ? [...source.params] : [], line: 0 });
  }
}

/**
 * Create the model of one VIEW. The first `add` is the VIEW itself (no parent); every later one
 * names a parent that was added before it. Elements are listed in the order they are added, which
 * the builder makes source order (overlays come last).
 * @param {ViewModelOptions} opts
 * @returns {{ model: ViewModel, add: (init: ElementInit) => BuiltElement, put: (el: ElementModel, attr: string, v: AttrValue) => void }}
 */
export function createViewModel(opts) {
  /** @type {ViewState} */
  const state = {
    opts,
    elements: [],
    byHandle: new Map(),
    exact: new Map(),
    folded: new Map(),
    listeners: new Set(),
    dirty: new Map(),
    queue: [],
    orders: new Map(),
    stacking: opts.stacking === 'flat' ? 'flat' : 'context',
    queueCapReported: false,
  };

  /** @type {ViewModel} */
  const model = {
    get view() { return state.elements[0]; },
    get elements() { return state.elements; },
    byHandle: (h) => state.byHandle.get(h),
    byId(id) {
      if (typeof id !== 'string') return undefined;
      return state.exact.get(id) ?? state.folded.get(lower(id));
    },
    paintOrder(container) {
      let order = state.orders.get(container);
      if (!order) state.orders.set(container, (order = computePaintOrder(container, { stacking: state.stacking })));
      return order;
    },
    onChange(cb) {
      state.listeners.add(cb);
      return () => { state.listeners.delete(cb); };
    },
    takeDirty() {
      const out = state.dirty;
      state.dirty = new Map();
      return out;
    },
    takeQueuedEvents() {
      const out = state.queue;
      state.queue = [];
      return out;
    },
  };

  return {
    model,
    add(init) {
      if (!init.parent && state.elements.length) throw new Error('a view model has one root element');
      const el = new Element(state, init, opts.nextHandle(), state.elements.length);
      state.elements.push(el);
      state.byHandle.set(el.handle, el);
      if (init.parent) {
        /** @type {Element} */ (init.parent)._children.push(el);
        forgetOrders(state, init.parent);
      }

      // Last declaration wins, per VIEW (30 corpus skins repeat an id). The earlier element keeps
      // its own id and handle; only the name lookups move.
      const id = el.id;
      const folded = lower(id);
      if (init.declared) {
        if (state.exact.has(id)) {
          opts.report({ code: 'duplicate-id', severity: 'warn', elementId: id, line: init.line,
            detail: `id "${clip(id)}" is declared more than once in this view; the last declaration wins` });
        } else if (state.folded.has(folded)) {
          opts.report({ code: 'duplicate-id-case', severity: 'info', elementId: id, line: init.line,
            detail: `id "${clip(id)}" differs only in case from an earlier id; the last declaration wins a case-insensitive lookup` });
        }
      }
      state.exact.set(id, el);
      state.folded.set(folded, el);
      return el;
    },
    put(el, attr, v) {
      /** @type {Element} */ (el)._values.set(lower(attr), v);
    },
  };
}
