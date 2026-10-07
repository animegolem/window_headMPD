// @ts-check
// The literal pass (E §5.3 `buildTheme`; E D5 "Build"; E §3.1 step 3). It turns the scanner's raw
// tree into the element model with literal values only: no script has run, so a `jscript:` value
// reads as its default until the layout pass evaluates it, and a `wmpprop:` or `wmpenabled:` value
// waits for the binding engine. Everything a skin can say wrong is a diagnostic and a repair:
// nothing in here throws on skin input.
//
// What it does, in order:
//  1. THEME attributes become `meta`; only VIEW children of the THEME are built (a VIEW is the
//     unit of a realm context), every other child is reported and dropped;
//  2. each VIEW is walked in source order with an explicit stack. Per element it lays the tag's
//     default attributes (G23: PLAYBUTTON is a BUTTON plus four defaults) under the skin's own,
//     resolves each attribute through `attrSpecFor`, classifies its value with `classifyValueDiag`
//     and coerces literals to the attribute's type. An attribute the kind does not know is kept as
//     inert text (G12), and a handler is registered as a handler site;
//  3. a missing `width`/`height` comes from the header probe of the element's size-defining image
//     (spec 5.1); `resizable` follows `titleBar`; a VIEW over 4,096 px clamps;
//  4. an element without an id gets `Unnamed_<kind>_<n>`, numbered per kind in source order across
//     the whole THEME, so the id of a given element never depends on a sidecar. `<kind>` is the
//     base kind (PAUSEBUTTON is a `button`, G23), which keeps the id inside `ElementKind`;
//  5. ids are indexed per VIEW, the last declaration winning;
//  6. sidecar overlays are appended last, under their parent, as trusted TEXT elements.
//
// Structural caps (E §10) clamp rather than fail: 20,000 elements per THEME, depth 64, 256
// attributes of at most 64 KiB, 64 VIEWs, 4,096 px per view axis.
//
// The implicit `<stem>.js` of `scriptsFor` needs the stem of the `.wms` that was picked, which the
// contracted signature does not carry; `pickDefinition` is memoised per VFS and gives it back.

import { attrSpecFor } from './attrs.js';
import { pickDefinition } from './select.js';
import { resolveTag } from './tags.js';
import { classifyValueDiag, coerce } from './values.js';
import { createViewModel } from '../model/elements.js';
import { parseScriptFile, resolveStringAttribute } from '../realm/wmploc.js';

/** @typedef {import('../contracts').RawNode} RawNode */
/** @typedef {import('../contracts').ElementKind} ElementKind */
/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').ViewModel} ViewModel */
/** @typedef {import('../contracts').ThemeModel} ThemeModel */
/** @typedef {import('../contracts').BuildCaps} BuildCaps */
/** @typedef {import('../contracts').AttrValue} AttrValue */
/** @typedef {import('../contracts').AttrSource} AttrSource */
/** @typedef {import('../contracts').HandlerSite} HandlerSite */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../contracts').Origin} Origin */
/** @typedef {import('../contracts').ImageProbe} ImageProbe */
/** @typedef {import('../contracts').SidecarOverlay} SidecarOverlay */
/** @typedef {import('../model/elements.js').BuiltElement} BuiltElement */

/** @type {Readonly<BuildCaps>} */
export const DEFAULT_BUILD_CAPS = Object.freeze({
  maxElements: 20_000, maxDepth: 64, maxAttrs: 256, maxAttrValue: 65_536, maxViews: 64, maxViewAxis: 4096,
});

/** A hostile file could otherwise turn every element into a diagnostic. */
const MAX_PER_CODE = 500;

/** Longest skin-controlled snippet quoted in a diagnostic's `detail`. */
const CLIP = 60;

/** @param {string} s */
const clip = (s) => (s.length > CLIP ? `${s.slice(0, CLIP - 3)}...` : s);

/** @param {Partial<BuildCaps> | undefined} caps @returns {BuildCaps} */
function resolveCaps(caps) {
  const out = { ...DEFAULT_BUILD_CAPS };
  // an explicit `undefined` or NaN must not erase a cap
  if (caps) for (const k of /** @type {Array<keyof BuildCaps>} */ (Object.keys(DEFAULT_BUILD_CAPS))) if (Number.isFinite(caps[k])) out[k] = /** @type {number} */ (caps[k]);
  return out;
}

/** One list for the whole THEME, capped per code. */
function createReporter() {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @param {Diagnostic} d */
  const report = (d) => {
    const n = (counts.get(d.code) ?? 0) + 1;
    counts.set(d.code, n);
    if (n <= MAX_PER_CODE) diagnostics.push(d);
    else if (n === MAX_PER_CODE + 1) {
      diagnostics.push({ code: 'diagnostics-truncated', severity: 'info', detail: `more than ${MAX_PER_CODE} "${d.code}" diagnostics; the rest are dropped` });
    }
  };
  return { diagnostics, report };
}

/**
 * The attributes whose literal image gives an element its default size. A CUSTOMSLIDER is sized by
 * its position map, because each strip frame is exactly that big (spec 6.8); a BUTTONGROUP's
 * images are all the same size, so any of them does.
 * @type {ReadonlyMap<string, readonly string[]>}
 */
const SIZE_IMAGES = new Map([
  ['view', ['backgroundimage']],
  ['subview', ['backgroundimage']],
  ['button', ['image']],
  ['buttongroup', ['image', 'mappingimage']],
  ['slider', ['backgroundimage']],
  ['progressbar', ['backgroundimage']],
  ['customslider', ['positionimage']],
]);

/** Sentinel for "coerce found the value invalid". */
const INVALID = Symbol('invalid');

/**
 * @typedef {Object} RawValue
 * @property {string} raw
 * @property {number} line
 */

/**
 * State shared by every element of one build.
 * @typedef {Object} Context
 * @property {BuildCaps} caps
 * @property {(d: Diagnostic) => void} report
 * @property {(ref: string) => ImageProbe | null} probe
 * @property {() => number} nextHandle
 * @property {number} count                     elements built so far, across the THEME
 * @property {Map<ElementKind, number>} unnamed per-kind counters for generated ids
 * @property {Set<string>} seen                 diagnostics already given once (`code|key`)
 */

/**
 * Report once per key.
 * @param {Context} ctx @param {Diagnostic} d @param {string} key
 */
function reportOnce(ctx, d, key) {
  const k = `${d.code}|${key}`;
  if (ctx.seen.has(k)) return;
  ctx.seen.add(k);
  ctx.report(d);
}

/**
 * What the attribute pass produces for one element.
 * @typedef {Object} Attributes
 * @property {Map<string, AttrValue>} values
 * @property {Map<string, string>} unknown
 * @property {Map<string, AttrSource>} sources
 * @property {Map<string, HandlerSite>} handlers
 */

/**
 * Resolve, classify and coerce one element's attributes.
 * @param {Context} ctx
 * @param {ElementKind} kind
 * @param {string} elementId
 * @param {ReadonlyMap<string, RawValue>} attrs lower-case names, last duplicate already won
 * @param {{ origin: Origin, literalOnly: boolean }} mode
 * @returns {Attributes}
 */
function readAttributes(ctx, kind, elementId, attrs, mode) {
  /** @type {Attributes} */
  const out = { values: new Map(), unknown: new Map(), sources: new Map(), handlers: new Map() };
  for (const [name, { raw, line }] of attrs) {
    if (name === 'id') {
      out.sources.set(name, { kind: 'literal', text: raw });
      continue;
    }
    const spec = attrSpecFor(kind, name, mode.origin);
    if (!spec) {
      // G12: no behaviour, but the text stays readable and a handler-looking value never runs.
      out.unknown.set(name, raw);
      out.sources.set(name, { kind: 'literal', text: raw });
      reportOnce(ctx, { code: 'unknown-attribute', severity: 'info', line, elementId,
        detail: `attribute "${clip(name)}" has no behaviour on a ${kind} (kept as text)` }, `${kind}|${name}`);
      continue;
    }

    /** @type {AttrSource} */
    let source = { kind: 'literal', text: raw };
    if (!mode.literalOnly) {
      const classified = classifyValueDiag(kind, name, raw);
      source = classified.source;
      if (classified.diagnostic) ctx.report({ ...classified.diagnostic, line, elementId });
    }
    out.sources.set(name, source);

    if (spec.type === 'handler') {
      if (raw !== '') {
        out.values.set(name, raw);
        out.handlers.set(name, { event: name, source: raw, params: source.kind === 'handler' ? [...source.params] : [], line });
      }
      continue;
    }

    switch (source.kind) {
      case 'literal': {
        const v = coerce(spec.type, raw, INVALID);
        if (v === INVALID) {
          ctx.report({ code: 'invalid-value', severity: 'warn', line, elementId,
            detail: `${name}="${clip(raw)}" is not a valid ${typeof spec.type === 'string' ? spec.type : 'enum'} value; the default stays` });
        } else {
          out.values.set(name, /** @type {AttrValue} */ (v));
        }
        break;
      }
      case 'res': {
        if (spec.type === 'string') {
          const r = resolveStringAttribute(name, source.url);
          if (r.problem) {
            ctx.report({ code: 'unresolved-res', severity: 'info', line, elementId,
              detail: `${name}="${clip(source.url)}" names no resource in the library (${r.problem})` });
          }
          out.values.set(name, r.value);
        } else {
          // An image: kept as the URL. The image service finds no file for it and supplies the
          // transparent fallback of an RT_IMAGE/RT_BITMAP (wmploc 5.5).
          out.values.set(name, source.url);
          ctx.report({ code: 'unresolved-res', severity: 'info', line, elementId,
            detail: `${name}="${clip(source.url)}" is a library image the engine does not ship` });
        }
        break;
      }
      default:
        // jscript:, wmpprop:, wmpenabled:, wmpdisabled: keep the default until the layout pass or
        // the binding engine writes the attribute.
        break;
    }
  }
  return out;
}

/**
 * Give an element without a width or height the size of its image (spec 5.1). Only a literal image
 * counts, and only an attribute the markup did not set: a `jscript:` size is the layout pass's.
 * @param {Context} ctx @param {ElementKind} kind @param {Attributes} a
 */
function applyProbedSize(ctx, kind, a) {
  const names = SIZE_IMAGES.get(kind);
  if (!names) return;
  /** @param {string} attr */
  const unset = (attr) => {
    if (a.values.has(attr)) return false;
    const s = a.sources.get(attr);
    return s === undefined || s.kind === 'literal';
  };
  const wantW = unset('width');
  const wantH = unset('height');
  if (!wantW && !wantH) return;
  for (const name of names) {
    if (a.sources.get(name)?.kind !== 'literal') continue;
    const ref = a.values.get(name);
    if (typeof ref !== 'string' || ref === '') continue;
    /** @type {ImageProbe | null} */
    let probed = null;
    try { probed = ctx.probe(ref); } catch { probed = null; }
    if (!probed) continue;
    if (wantW) a.values.set('width', probed.width);
    if (wantH) a.values.set('height', probed.height);
    return;
  }
}

/**
 * Per-view builder handles.
 * @typedef {ReturnType<typeof createViewModel>} ViewBuilder
 */

/**
 * Build one element and add it to its view.
 * @param {Context} ctx
 * @param {ViewBuilder} builder
 * @param {ElementModel | null} parent
 * @param {{ tag: string, kind: ElementKind, line: number, attrs: Map<string, RawValue>, hostStyle?: { letterSpacing?: string } }} spec
 * @param {{ origin: Origin, literalOnly: boolean }} mode
 * @returns {BuiltElement}
 */
function createElement(ctx, builder, parent, spec, mode) {
  const { kind } = spec;
  const declaredId = spec.attrs.get('id')?.raw.trim() ?? '';
  const declared = declaredId !== '';
  let id = declaredId;
  if (!declared) {
    const n = (ctx.unnamed.get(kind) ?? 0) + 1;
    ctx.unnamed.set(kind, n);
    id = `Unnamed_${kind}_${n}`;
  }

  const a = readAttributes(ctx, kind, id, spec.attrs, mode);
  applyProbedSize(ctx, kind, a);

  if (kind === 'view') {
    // `resizable` defaults to the value of `titleBar` (spec 6.2).
    if (!a.sources.has('resizable') && a.values.get('titlebar') === false) a.values.set('resizable', false);
    for (const axis of /** @type {const} */ (['width', 'height'])) {
      const v = a.values.get(axis);
      if (typeof v === 'number' && v > ctx.caps.maxViewAxis) {
        ctx.report({ code: 'cap-view-size', severity: 'warn', line: spec.line, elementId: id,
          detail: `${axis}=${v} is over the ${ctx.caps.maxViewAxis}-px limit and is clamped` });
        a.values.set(axis, ctx.caps.maxViewAxis);
      }
    }
    const sized = (/** @type {string} */ axis) => a.values.has(axis) || (a.sources.get(axis) !== undefined && a.sources.get(axis)?.kind !== 'literal');
    if (!sized('width') || !sized('height')) {
      ctx.report({ code: 'view-no-size', severity: 'info', line: spec.line, elementId: id,
        detail: 'the view has no width or height and no background image to take one from' });
    }
  }

  if (parent?.kind === 'buttongroup' && kind === 'buttonelement') {
    // `index` is the element's position in its group (0-based); the group counts its elements.
    const index = Number(parent.get('buttoncount'));
    a.values.set('index', index);
    builder.put(parent, 'buttoncount', index + 1);
  }

  ctx.count++;
  return builder.add({
    tag: spec.tag, kind, id, declared, parent, line: spec.line,
    values: a.values, unknown: a.unknown, sources: a.sources, handlers: a.handlers,
    ...(spec.hostStyle ? { hostStyle: spec.hostStyle } : {}),
  });
}

/**
 * The attributes of a raw node: the tag's defaults underneath, the skin's own on top.
 * @param {Context} ctx @param {RawNode} node @param {ReadonlyMap<string, string>} defaults
 * @returns {Map<string, RawValue>}
 */
function gatherAttributes(ctx, node, defaults) {
  /** @type {Map<string, RawValue>} */
  const attrs = new Map();
  for (const [name, raw] of defaults) attrs.set(name, { raw, line: node.line });
  let kept = 0;
  for (const a of node.attrs) {
    if (kept >= ctx.caps.maxAttrs) {
      ctx.report({ code: 'cap-attrs', severity: 'warn', line: node.line,
        detail: `<${clip(node.tag)}> has more than ${ctx.caps.maxAttrs} attributes; the rest are dropped` });
      break;
    }
    kept++;
    if (a.value.length > ctx.caps.maxAttrValue) {
      ctx.report({ code: 'cap-attr-value', severity: 'warn', line: a.line,
        detail: `${clip(a.name)} is ${a.value.length} characters long (limit ${ctx.caps.maxAttrValue}); the attribute is dropped` });
      continue;
    }
    attrs.set(a.name, { raw: a.value, line: a.line });
  }
  return attrs;
}

/**
 * Build one VIEW and everything under it.
 * @param {Context} ctx @param {RawNode} viewNode @param {'context' | 'flat'} stacking
 * @returns {ViewBuilder}
 */
function buildView(ctx, viewNode, stacking) {
  const builder = createViewModel({ stacking, maxViewAxis: ctx.caps.maxViewAxis, report: ctx.report, nextHandle: ctx.nextHandle });
  /** @type {Array<{ node: RawNode, parent: ElementModel | null, depth: number }>} */
  const pending = [{ node: viewNode, parent: null, depth: 0 }];
  while (pending.length) {
    const { node, parent, depth } = /** @type {{ node: RawNode, parent: ElementModel | null, depth: number }} */ (pending.pop());
    if (ctx.count >= ctx.caps.maxElements) {
      reportOnce(ctx, { code: 'cap-elements', severity: 'warn', line: node.line,
        detail: `the theme has more than ${ctx.caps.maxElements} elements; the rest are dropped` }, 'theme');
      break;
    }
    if (depth > ctx.caps.maxDepth) {
      ctx.report({ code: 'cap-depth', severity: 'warn', line: node.line,
        detail: `<${clip(node.tag)}> is nested ${depth} deep (limit ${ctx.caps.maxDepth}); it and its children are dropped` });
      continue;
    }

    const schema = resolveTag(node.tag);
    let kind = schema.kind;
    // A VIEW or THEME inside a VIEW has no place in the model: it stays as an inert node.
    if (depth > 0 && (kind === 'view' || kind === 'theme')) {
      kind = 'unknown';
      ctx.report({ code: 'nested-view', severity: 'warn', line: node.line, detail: `<${clip(schema.tag)}> inside a view is treated as an inert element` });
    } else if (kind === 'unknown') {
      reportOnce(ctx, { code: 'unknown-tag', severity: 'info', line: node.line, detail: `<${clip(schema.tag)}> is not a known element; it is kept as an inert node` }, schema.tag);
    }

    const el = createElement(ctx, builder, parent, {
      tag: schema.tag, kind, line: node.line, attrs: gatherAttributes(ctx, node, schema.defaults),
    }, { origin: 'init', literalOnly: false });

    for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i], parent: el, depth: depth + 1 });
  }
  return builder;
}

/**
 * Append one sidecar overlay under its parent (D10.6). Trusted data: its values are literals, not
 * script, and a `hostStyle` keeps only the one allowed key.
 * @param {Context} ctx @param {ViewBuilder[]} builders @param {SidecarOverlay} ov
 */
function applyOverlay(ctx, builders, ov) {
  if (!ov || typeof ov !== 'object' || typeof ov.parent !== 'string') {
    ctx.report({ code: 'overlay-invalid', severity: 'warn', detail: 'a sidecar overlay has no parent id; it is skipped' });
    return;
  }
  if (ov.tag !== 'text') {
    ctx.report({ code: 'overlay-invalid', severity: 'warn', detail: `a sidecar overlay for "${clip(ov.parent)}" has tag "${clip(String(ov.tag))}"; only text is supported` });
    return;
  }
  for (const builder of builders) {
    const parent = builder.model.byId(ov.parent);
    if (!parent) continue;
    if (parent.kind !== 'view' && parent.kind !== 'subview') {
      ctx.report({ code: 'overlay-invalid', severity: 'warn', elementId: parent.id, detail: `overlay parent "${clip(ov.parent)}" is a ${parent.kind}, not a view or subview` });
      return;
    }
    if (ctx.count >= ctx.caps.maxElements) {
      reportOnce(ctx, { code: 'cap-elements', severity: 'warn', detail: `the theme has more than ${ctx.caps.maxElements} elements; the rest are dropped` }, 'theme');
      return;
    }
    /** @type {Map<string, RawValue>} */
    const attrs = new Map();
    for (const [name, value] of Object.entries(ov.attrs ?? {})) {
      if (value === null || value === undefined) continue;
      attrs.set(String(name).toLowerCase(), { raw: String(value), line: 0 });
    }
    const letterSpacing = ov.hostStyle?.letterSpacing;
    createElement(ctx, builder, parent, {
      tag: 'text', kind: 'text', line: 0, attrs,
      ...(typeof letterSpacing === 'string' ? { hostStyle: { letterSpacing: letterSpacing.slice(0, 32) } } : {}),
    }, { origin: 'sidecar', literalOnly: true });
    return;
  }
  ctx.report({ code: 'overlay-parent-missing', severity: 'warn', detail: `no element has the id "${clip(ov.parent)}"; its overlay is skipped` });
}

/**
 * THEME attributes. The resource library can supply `author` and `copyright` (RT_STRING #1998).
 * @param {Context} ctx @param {RawNode} root
 */
function readMeta(ctx, root) {
  /** @param {string} name */
  const text = (name) => {
    const raw = root.attrs.find((a) => a.name === name)?.value ?? '';
    const r = resolveStringAttribute(name, raw);
    if (r.problem) ctx.report({ code: 'unresolved-res', severity: 'info', line: root.line, detail: `${name}="${clip(raw)}" names no resource in the library (${r.problem})` });
    return r.value;
  };
  const current = text('currentviewid').trim();
  return Object.freeze({ author: text('author'), title: text('title'), copyright: text('copyright'), currentViewID: current === '' ? null : current });
}

/** @param {string} s */
const fold = (s) => s.toLowerCase();

/**
 * Extra build option that is not in the contracted signature: the stacking mode a VIEW's
 * `paintOrder` uses (E §5.10 `EngineOptions.stacking`).
 * @typedef {{ stacking?: 'context' | 'flat' }} StackingOption
 */

/** @type {import('../contracts').BuildThemeFn} */
export const buildTheme = (root, vfs, opts) => {
  const { diagnostics, report } = createReporter();
  const caps = resolveCaps(opts?.caps);
  let handleCounter = 0;
  /** @type {Context} */
  const ctx = {
    caps, report, probe: opts?.probe ?? (() => null), nextHandle: () => ++handleCounter,
    count: 0, unnamed: new Map(), seen: new Set(),
  };
  const stacking = /** @type {StackingOption} */ (opts ?? {}).stacking === 'flat' ? 'flat' : 'context';

  /** @type {RawNode[]} */
  const viewNodes = [];
  /** @type {ThemeModel['meta']} */
  let meta = Object.freeze({ author: '', title: '', copyright: '', currentViewID: null });
  const rootTag = root ? String(root.tag).toLowerCase() : '';
  if (!root) {
    report({ code: 'no-root', severity: 'error', detail: 'the definition file has no root element' });
  } else if (rootTag === 'theme') {
    meta = readMeta(ctx, root);
    for (const child of root.children) {
      if (String(child.tag).toLowerCase() !== 'view') {
        reportOnce(ctx, { code: 'unexpected-theme-child', severity: 'warn', line: child.line, detail: `<${clip(child.tag)}> directly under the theme is not a view; it is dropped` }, child.tag);
      } else if (viewNodes.length >= caps.maxViews) {
        reportOnce(ctx, { code: 'cap-views', severity: 'warn', line: child.line, detail: `the theme has more than ${caps.maxViews} views; the rest are dropped` }, 'views');
      } else {
        viewNodes.push(child);
      }
    }
  } else if (rootTag === 'view') {
    report({ code: 'root-not-theme', severity: 'warn', line: root.line, detail: 'the definition file starts with a view, not a theme' });
    viewNodes.push(root);
  } else {
    report({ code: 'root-not-theme', severity: 'error', line: root.line, detail: `the definition file starts with <${clip(root.tag)}>, not a theme` });
  }
  if (root && viewNodes.length === 0) report({ code: 'no-view', severity: 'error', line: root.line, detail: 'the theme has no view' });

  // A VIEW the element budget had no room for even a root of is not a view at all.
  const builders = viewNodes.map((node) => buildView(ctx, node, stacking)).filter((b) => b.model.elements.length > 0);
  for (const ov of opts?.overlays ?? []) applyOverlay(ctx, builders, ov);

  // scriptFile order per VIEW; the implicit <stem>.js last, and only when the archive has it.
  const picked = pickDefinition(vfs);
  const stem = picked ? picked.wms.replace(/\.wms$/i, '') : '';
  /** @type {Map<ElementModel, string[]>} */
  const scripts = new Map();
  for (const { model } of builders) {
    const view = model.view;
    const list = [];
    for (const entry of parseScriptFile(String(view.get('scriptfile') ?? ''), { stem })) {
      if (entry.kind === 'library') {
        list.push(entry.url);
      } else if (entry.kind === 'unknown-res') {
        report({ code: 'unknown-res-script', severity: 'warn', elementId: view.id, detail: `scriptFile entry "${clip(entry.url)}" is not a library the engine ships; it is skipped` });
      } else if (vfs.has(entry.path)) {
        list.push(entry.path);
      } else if (!entry.implicit) {
        report({ code: 'missing-script', severity: 'warn', elementId: view.id, detail: `scriptFile entry "${clip(entry.path)}" is not in the archive` });
        list.push(entry.path);
      }
    }
    scripts.set(view, list);
  }

  const views = Object.freeze(builders.map((b) => b.model));
  return {
    views,
    meta,
    diagnostics,
    scriptsFor(viewId) {
      const id = String(viewId);
      const view = views.find((v) => v.view.id === id) ?? views.find((v) => fold(v.view.id) === fold(id));
      return view ? [...(scripts.get(view.view) ?? [])] : [];
    },
  };
};
