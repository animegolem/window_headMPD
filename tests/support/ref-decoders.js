// @ts-check
// Independent readers the writer tests lean on: macOS `sips` (ImageIO), Pillow, Info-ZIP `unzip` and
// Python's expat. They are the oracle that the fixtures are the shape they claim to be, so each
// helper reports availability and the tests skip, with a reason, where a tool is missing.
// Node only. Python always runs `-I` (isolated: no user site-packages, no cwd on the path), and the
// untrusted bytes are passed as files or stdin, never as code.

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @param {string} cmd @param {string[]} args */
const works = (cmd, args) => {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', timeout: 20000 }).status === 0;
  } catch {
    return false;
  }
};

export const HAS_SIPS = process.platform === 'darwin' && works('sips', ['--version']);
export const HAS_UNZIP = works('unzip', ['-v']);
export const HAS_PYTHON = works('python3', ['-I', '-c', 'pass']);
export const HAS_PIL = HAS_PYTHON && works('python3', ['-I', '-c', 'import PIL']);

/** A fresh temp directory outside the repo. @param {string} [prefix] */
export const makeTempDir = (prefix = 'headmpd-w04-') => mkdtempSync(join(tmpdir(), prefix));

/**
 * `sips -g pixelWidth -g pixelHeight`. Null when sips cannot read the image.
 * @param {string} path @returns {{ width: number, height: number }|null}
 */
export function sipsSize(path) {
  const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8', timeout: 30000 });
  const w = /pixelWidth: (\d+)/.exec(r.stdout)?.[1];
  const h = /pixelHeight: (\d+)/.exec(r.stdout)?.[1];
  return r.status === 0 && w && h ? { width: Number(w), height: Number(h) } : null;
}

/** Convert with sips (ImageIO) so another decoder's pixels can be read. @param {string} src @param {string} dest */
export function sipsToPng(src, dest) {
  return spawnSync('sips', ['-s', 'format', 'png', src, '--out', dest], { encoding: 'utf8', timeout: 60000 }).status === 0;
}

/**
 * Run `unzip`, with stdin closed so a password prompt fails instead of hanging.
 * @param {string[]} args @returns {{ status: number|null, output: string }}
 */
export function unzip(args) {
  const r = spawnSync('unzip', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/**
 * `unzip -p`: one entry's bytes to stdout, no extraction. Null on a non-zero exit.
 * @param {string} archive @param {string} entry @param {string} [password] @returns {Uint8Array|null}
 */
export function unzipEntry(archive, entry, password) {
  const args = ['-p', ...(password ? ['-P', password] : []), archive, entry];
  const r = spawnSync('unzip', args, { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? new Uint8Array(r.stdout) : null;
}

/** `zipinfo` listing (permissions, sizes, methods). @param {string} archive @returns {string} */
export function zipinfo(archive) {
  return spawnSync('zipinfo', [archive], { encoding: 'utf8', timeout: 60000 }).stdout;
}

/**
 * Run a Python snippet with `input` as JSON on stdin and parse its stdout. One retry on a timeout:
 * this suite runs on a shared machine, and a cold or starved Python start has been seen to stall.
 * @param {string} code @param {unknown} input @returns {any}
 */
function python(code, input) {
  const payload = JSON.stringify(input);
  /** @type {import('node:child_process').SpawnSyncReturns<string>|undefined} */
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    r = spawnSync('python3', ['-I', '-W', 'ignore', '-c', code], { input: payload, encoding: 'utf8', timeout: 45000, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== null) break;
  }
  if (!r || r.status !== 0) throw new Error(`python3 failed (${r?.status ?? `signal ${r?.signal}`}): ${r?.stderr}`);
  return JSON.parse(r.stdout);
}

const b64 = (/** @type {Uint8Array} */ a) => Buffer.from(a).toString('base64');

/**
 * Pillow decodes each image to RGBA and reports the largest per-channel difference from the
 * expected RGB on `written` pixels (alpha is not compared: BMP alpha is forced to 255 by D3).
 * @param {Array<{ id: string, path: string, rgba: Uint8Array, written?: Uint8Array|null }>} items
 * @returns {Record<string, { size?: [number, number], maxdiff?: number, error?: string }>}
 */
export function pilCompareImages(items) {
  const out = python(
    `
import sys, json, base64
from PIL import Image
res = []
for it in json.load(sys.stdin):
    r = {'id': it['id']}
    try:
        im = Image.open(it['path']); im.load(); im = im.convert('RGBA')
        r['size'] = list(im.size)
        exp = base64.b64decode(it['rgba']); wr = base64.b64decode(it['written']) if it.get('written') else None
        px = im.tobytes(); md = 0
        for i in range(len(px) // 4):
            if wr is not None and not wr[i]: continue
            for c in range(3):
                d = abs(px[i*4+c] - exp[i*4+c])
                if d > md: md = d
        r['maxdiff'] = md
    except Exception as e:
        r['error'] = type(e).__name__ + ': ' + str(e)
    res.append(r)
json.dump(res, sys.stdout)
`,
    items.map((i) => ({ id: i.id, path: i.path, rgba: b64(i.rgba), written: i.written ? b64(i.written) : null })),
  );
  return Object.fromEntries(out.map((/** @type {any} */ r) => [r.id, r]));
}

/**
 * Pillow's frame count, and per frame the number of pixels whose alpha-zero-ness or (where visible)
 * RGB differs from the writer's composited canvas.
 * @param {Array<{ id: string, path: string, width: number, height: number, canvases: Uint8Array[] }>} items
 * @returns {Record<string, { frames?: number, bad?: number[], error?: string }>}
 */
export function pilCompareGifs(items) {
  const out = python(
    `
import sys, json, base64
from PIL import Image
res = []
for it in json.load(sys.stdin):
    r = {'id': it['id']}
    try:
        im = Image.open(it['path']); n = getattr(im, 'n_frames', 1); bad = []
        w, h = it['width'], it['height']
        for i in range(min(n, len(it['canvases']))):
            im.seek(i); px = im.convert('RGBA').tobytes(); exp = base64.b64decode(it['canvases'][i]); b = 0
            for k in range(w * h):
                ea = exp[k*4+3]; pa = px[k*4+3]
                if (ea == 0) != (pa == 0): b += 1; continue
                if ea and (exp[k*4] != px[k*4] or exp[k*4+1] != px[k*4+1] or exp[k*4+2] != px[k*4+2]): b += 1
            bad.append(b)
        r['frames'] = n; r['bad'] = bad
    except Exception as e:
        r['error'] = type(e).__name__ + ': ' + str(e)
    res.append(r)
json.dump(res, sys.stdout)
`,
    items.map((i) => ({ id: i.id, path: i.path, width: i.width, height: i.height, canvases: i.canvases.map(b64) })),
  );
  return Object.fromEntries(out.map((/** @type {any} */ r) => [r.id, r]));
}

/**
 * Strict XML check with expat, as the corpus survey did.
 * @param {Array<{ id: string, text: string }>} items
 * @returns {Record<string, { ok: boolean, error?: string }>}
 */
export function expatCheck(items) {
  const out = python(
    `
import sys, json
import xml.parsers.expat as E
res = []
for it in json.load(sys.stdin):
    p = E.ParserCreate()
    try:
        p.Parse(it['text'].encode('utf-8'), True)
        res.append({'id': it['id'], 'ok': True})
    except E.ExpatError as e:
        res.append({'id': it['id'], 'ok': False, 'error': str(e)})
json.dump(res, sys.stdout)
`,
    items,
  );
  return Object.fromEntries(out.map((/** @type {any} */ r) => [r.id, r]));
}

/** @param {Uint8Array} a @param {Uint8Array} b byte equality */
export const bytesEqual = (a, b) => Buffer.compare(a, b) === 0;
