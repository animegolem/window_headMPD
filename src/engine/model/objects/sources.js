// @ts-check
// `ObjectGraph.changeSource(path)`: what a `wmpprop:` binding reads and listens to (E D5 bindings,
// E §5.5). A path is the binding grammar of wms/values.js `parseBindPath`, as text:
// `player.settings.getMode('loop')`, `eq.gainLevel3`, `visEffects.currentPresetTitle`. It resolves
// the way D5 says: the root against the host globals (case-insensitively) and then the VIEW's element
// ids, each segment against the class of the object before it, a call segment by calling the method
// with its literal arguments.
//
//   read()       evaluates the whole path now, quietly: it never records a stub per frame
//   subscribe()  listens to the change source of **every object on the path**, so replacing an
//                intermediate object (`currentMedia` on a song change) re-fires the binding
//
// Null means the path does not resolve (an unknown root or member, or a non-object in the middle);
// the binding engine records `unresolved-binding` itself. A constant resolves to a source that never
// fires.

import { parseBindPath } from '../../wms/values.js';
import { apiName, lookupMember } from '../schema.js';
import { isHandle } from './core.js';

/** @typedef {import('../../contracts').BindPath} BindPath */
/** @typedef {import('../../contracts').MemberSpec} MemberSpec */
/** @typedef {import('../../contracts').Wire} Wire */
/** @typedef {import('./core.js').GraphObject} GraphObject */
/** @typedef {{ channel: string, attach?: () => void }} Source */

/**
 * @param {import('./index.js').Env} env
 * @param {{ rootOf(name: string): GraphObject | null, objectOf(handle: number): GraphObject | null }} graph
 * @returns {import('../../contracts').ObjectGraph['changeSource']}
 */
export function createSources(env, graph) {
  /** The change sources of one member of one object. @param {GraphObject} obj @param {MemberSpec} spec @returns {Source[]} */
  function sourcesOf(obj, spec) {
    const key = spec.name.toLowerCase();
    const el = obj.element;
    switch (spec.changeSource) {
      case 'mediacenter': return [{ channel: `mediacenter.${key}` }];
      case 'local': return [{ channel: `local:${obj.className}` }];
      case 'effects':
        if (!el) return [];
        // The control is mounted after the bindings install, so the link to it is made when
        // something first listens (and retried each frame until the slot exists).
        return [{ channel: `effects:${el.handle}`, attach: () => env.watchEffects(el) }, { channel: `el:${el.handle}:${key}` }];
      case undefined:
        // An element attribute changes with the model; a constant never changes.
        return el && spec.kind !== 'method' && spec.impl === 'live' ? [{ channel: `el:${el.handle}:${key}` }] : [];
      default: return [{ channel: spec.changeSource }];
    }
  }

  /**
   * One step down the path: the value of a segment on an object.
   * @param {GraphObject} obj @param {MemberSpec} spec @param {import('../../contracts').BindSegment} seg
   * @returns {Wire | { method: true }}
   */
  const step = (obj, spec, seg) => (spec.kind === 'method' || seg.args ? obj.peekCall(seg.name, /** @type {Wire[]} */ (seg.args ?? [])) : obj.peek(seg.name));

  /** @param {BindPath} path */
  function build(path) {
    const root = graph.rootOf(path.root);
    if (!root) return null;
    /** @type {Source[]} */
    const sources = [];
    let stubbed = null;
    let cur = root;
    for (let i = 0; i < path.segments.length; i++) {
      const seg = path.segments[i];
      const spec = lookupMember(cur.className, seg.name);
      if (!spec) return null;
      sources.push(...sourcesOf(cur, spec));
      if (spec.impl === 'stub') stubbed = apiName(cur.className, spec.name);
      if (i === path.segments.length - 1) break;
      const next = step(cur, spec, seg);
      const target = isHandle(next) ? graph.objectOf(next.__h) : null;
      if (!target) return null;                              // a non-object in the middle of a path
      cur = target;
    }
    if (stubbed) env.ledger.record(stubbed, 'stub', 'bound by a wmpprop: path');

    /** @returns {Wire} */
    function read() {
      let obj = root;
      for (let i = 0; i < path.segments.length; i++) {
        const seg = path.segments[i];
        const spec = lookupMember(obj.className, seg.name);
        if (!spec) return undefined;
        const v = step(obj, spec, seg);
        if (i === path.segments.length - 1) return v !== null && typeof v === 'object' && !isHandle(v) ? undefined : /** @type {Wire} */ (v);
        const next = isHandle(v) ? graph.objectOf(v.__h) : null;
        if (!next) return undefined;
        obj = next;
      }
      return env.ref(obj);
    }

    return {
      read,
      subscribe(/** @type {() => void} */ cb) {
        const unsubs = sources.map((s) => { s.attach?.(); return env.hub.on(s.channel, cb); });
        return () => { for (const u of unsubs) u(); };
      },
    };
  }

  return (path) => {
    const parsed = typeof path === 'string' ? parseBindPath(path) : /** @type {BindPath | null} */ (path);
    if (!parsed || typeof parsed.root !== 'string' || !Array.isArray(parsed.segments)) return null;
    return build(parsed);
  };
}
