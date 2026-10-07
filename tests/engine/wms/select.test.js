// @ts-check
// `pickDefinition` and the reference count it ranks by (E §5.2; survey 1.2 and 3.2; U-17).
import { describe, expect, it } from 'vitest';
import { openVfs } from '../../../src/engine/archive/vfs.js';
import { collectReferences, pickDefinition, REFERENCE_EXTENSIONS, unresolvedReferences } from '../../../src/engine/wms/select.js';
import { scanWms } from '../../../src/engine/wms/scan.js';
import { buildZip } from '../../support/zip-writer.js';

/** @param {string} text @param {string} [name] */
const refsIn = (text, name) => collectReferences(scanWms(text).root);

/** @param {Record<string, string>} files @param {string} [name] */
const vfsOf = (files, name = 'skin.wmz') =>
  openVfs(buildZip(Object.entries(files).map(([n, data]) => ({ name: n, data }))), name);

/** A definition whose images are `images` and whose art is whatever the archive holds. @param {string[]} images */
const wms = (images) =>
  `<THEME><VIEW width="10" height="10">${images.map((f, i) => `<BUTTON id="b${i}" image="${f}"/>`).join('')}</VIEW></THEME>`;

describe('collectReferences', () => {
  it('collects attributes that end in a known extension, in source order', () => {
    const refs = refsIn(`<THEME><VIEW width="1" backgroundImage="bg.BMP"><BUTTON image="a.png" hoverImage="b.gif" cursor="hand.cur"/>
      <SLIDER thumbImage="t.jpg" foo="x.jpeg"/><TEXT value="plain.txt"/></VIEW></THEME>`);
    expect(refs).toEqual(['bg.BMP', 'a.png', 'b.gif', 'hand.cur', 't.jpg', 'x.jpeg']);
    expect([...REFERENCE_EXTENSIONS]).toEqual(['bmp', 'gif', 'jpg', 'jpeg', 'png', 'js', 'cur', 'ani']);
  });

  it('takes each scriptFile entry, tolerates a trailing ;, and skips res:// resources', () => {
    expect(refsIn('<THEME><VIEW scriptFile="a.js; b.js ;res://wmploc.dll/RT_TEXT/#132;"/></THEME>')).toEqual(['a.js', 'b.js']);
    expect(refsIn('<THEME><VIEW scriptFile="headspace.js;res://wmploc/RT_TEXT/#132"/></THEME>')).toEqual(['headspace.js']);
    expect(refsIn('<THEME><VIEW scriptFile=";;"/></THEME>')).toEqual([]);
  });

  it('skips handler text and jscript:/wmpprop: values, which are code and not file names', () => {
    const refs = refsIn(`<THEME><VIEW><BUTTON onclick="x.image='a.png'" value_onchange="f('b.gif')" image="jscript:'c.png'" down="wmpprop:x.d.bmp"
      onMouseOver="d.png" tooltip_onchange="e.png" left="JScript:f.gif" visible="wmpenabled:g.png"/></VIEW></THEME>`);
    expect(refs).toEqual([]);
  });

  it('is empty for no tree', () => {
    expect(collectReferences(null)).toEqual([]);
  });
});

describe('unresolvedReferences', () => {
  it('counts a reference the archive holds under another case or path as resolved', async () => {
    const vfs = await vfsOf({ 'Art/Bass_SliderBG.bmp': 'x', 'b.png': 'y' });
    expect(unresolvedReferences(vfs, ['bass_sliderbg.bmp', 'BASS_SLIDERBG.BMP', 'b.png', 'C:\\skins\\B.PNG'])).toEqual([]);
    expect(unresolvedReferences(vfs, ['pl\\pl_dropdown_wood.png', 'gone.gif', 'b.png'])).toEqual(['pl\\pl_dropdown_wood.png', 'gone.gif']);
  });

  it('does not let __proto__ or constructor resolve to anything', async () => {
    const vfs = await vfsOf({ 'a.bmp': 'x' });
    expect(unresolvedReferences(vfs, ['__proto__', 'constructor', 'toString'])).toEqual(['__proto__', 'constructor', 'toString']);
  });
});

describe('pickDefinition', () => {
  it('is null for an archive with no .wms', async () => {
    expect(pickDefinition(await vfsOf({ 'a.bmp': 'x' }))).toBeNull();
    expect(pickDefinition(await vfsOf({}))).toBeNull();
  });

  it('answers the only .wms, whatever its references, and counts what is missing', async () => {
    const vfs = await vfsOf({ 'Skin.WMS': wms(['a.bmp', 'missing.bmp']), 'a.bmp': 'x' });
    expect(pickDefinition(vfs)).toEqual({ wms: 'skin.wms', reason: 'only', unresolved: 1 });
  });

  it('prefers the file with the fewest unresolved references (Nautical and Sports, U-17)', async () => {
    const vfs = await vfsOf({
      'real.wms': wms(['a.bmp', 'b.bmp']), 'stale.wms': wms(['a.bmp', 'x1.bmp', 'x2.bmp', 'x3.bmp']),
      'a.bmp': '1', 'b.bmp': '2',
    }, 'Other.wmz');
    expect(pickDefinition(vfs)).toEqual({ wms: 'real.wms', reason: 'fewest-unresolved', unresolved: 0 });
    // the order of the entries does not matter
    const flipped = await vfsOf({ 'stale.wms': wms(['x1.bmp']), 'real.wms': wms(['a.bmp']), 'a.bmp': '1' }, 'Other.wmz');
    expect(pickDefinition(flipped)?.wms).toBe('real.wms');
  });

  it('folds case when it counts: a differently cased reference is a resolved one', async () => {
    const vfs = await vfsOf({ 'one.wms': wms(['A.BMP']), 'two.wms': wms(['b.bmp', 'c.bmp']), 'a.bmp': '1', 'b.bmp': '2' }, 'z.wmz');
    expect(pickDefinition(vfs)).toEqual({ wms: 'one.wms', reason: 'fewest-unresolved', unresolved: 0 });
  });

  it('breaks a tie by the archive\'s own name, then by size', async () => {
    const same = { 'a.bmp': '1' };
    const stem = await vfsOf({ 'other.wms': wms(['a.bmp']), 'mine.wms': wms(['a.bmp']), ...same }, 'Mine.wmz');
    expect(pickDefinition(stem)).toEqual({ wms: 'mine.wms', reason: 'stem', unresolved: 0 });
    const stemCase = await vfsOf({ 'other.wms': wms(['a.bmp']), 'MINE.WMS': wms(['a.bmp']), ...same }, 'C:\\skins\\mine.WMZ');
    expect(pickDefinition(stemCase)?.reason).toBe('stem');

    const small = wms(['a.bmp']);
    const large = `${wms(['a.bmp'])}\r\n<!-- ${'padding '.repeat(50)} -->`;
    const size = await vfsOf({ 'one.wms': small, 'two.wms': large, ...same }, 'neither.wmz');
    expect(pickDefinition(size)).toEqual({ wms: 'two.wms', reason: 'size', unresolved: 0 });
    // equal size: the first in archive order
    const dead = await vfsOf({ 'p.wms': small, 'q.wms': small, ...same }, 'neither.wmz');
    expect(pickDefinition(dead)).toEqual({ wms: 'p.wms', reason: 'size', unresolved: 0 });
  });

  it('counts scriptFile entries too', async () => {
    const withScript = (/** @type {string} */ f) => `<THEME><VIEW width="1" height="1" scriptFile="${f};res://wmploc.dll/RT_TEXT/#132;"/></THEME>`;
    const vfs = await vfsOf({ 'a.wms': withScript('absent.js'), 'b.wms': withScript('present.js'), 'present.js': '//' }, 'z.wmz');
    expect(pickDefinition(vfs)).toEqual({ wms: 'b.wms', reason: 'fewest-unresolved', unresolved: 0 });
  });

  it('lets a file that cannot be read lose to one that can', async () => {
    const vfs = await vfsOf({ 'good.wms': wms(['missing.bmp']), 'bad.wms': 'x' });
    // both read here; make `bad` unreadable by wrapping the VFS
    const wrapped = { ...vfs, read: (/** @type {string} */ r) => (r === 'bad.wms' ? null : vfs.read(r)) };
    expect(pickDefinition(wrapped)).toEqual({ wms: 'good.wms', reason: 'fewest-unresolved', unresolved: 1 });
  });

  it('copes with an empty or unscannable .wms', async () => {
    const vfs = await vfsOf({ 'empty.wms': '', 'real.wms': wms(['a.bmp']), 'a.bmp': '1' }, 'z.wmz');
    expect(pickDefinition(vfs)?.wms).toBe('real.wms');
  });

  it('is memoised per VFS', async () => {
    const vfs = await vfsOf({ 'a.wms': wms([]) });
    expect(pickDefinition(vfs)).toBe(pickDefinition(vfs));
  });
});
