// @ts-check
// Image decoding over the whole corpus (WAVES W1.3 acceptance 2; ENGINE D3, section 10):
// `npm run corpus -- images`. Every image entry of every distinct archive in skins/wmp and skins/wsz
// must decode with no throw and no null. The only allowed failures are the 9 `RESOURCE.FRK/` fork
// files and the 3 PSDs hiding behind bitmap names (survey 3.3). Skips, never fails, without skins/.
//
// The suite also pins the numbers the caps were chosen from: the widest axis, the largest area and
// the most GIF frames, so a cap that stops clearing the corpus shows up here and not in a skin.
// Nothing derived from the art is written anywhere.

import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { expect, it } from 'vitest';
import { decodeImage, decodeImageWithDiagnostics } from '../../src/engine/image/decode/index.js';
import { detectFormat, probeImage } from '../../src/engine/image/probe.js';
import { describeCorpus } from '../support/fixtures.js';

const IMAGE_NAME = /\.(?:bmp|gif|png|jpe?g)$/i;
const FORK = /(?:^|\/)RESOURCE\.FRK\//i;
/** `8BPS`, a Photoshop file saved under a bitmap name. @param {Uint8Array} b */
const isPsd = (b) => b.length >= 4 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53;

/**
 * The image entries of an archive, by name. Three archives have a corrupt first local header
 * (`01 00 01 00`, survey 1.2); patching the signature in memory repairs them.
 * @param {Uint8Array} bytes @returns {Record<string, Uint8Array>}
 */
function imageEntries(bytes) {
  const read = (/** @type {Uint8Array} */ b) => unzipSync(b, { filter: (f) => IMAGE_NAME.test(f.name) });
  try {
    return read(bytes);
  } catch (e) {
    if (bytes[0] === 1 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
      const patched = bytes.slice();
      patched.set([0x50, 0x4b, 0x03, 0x04], 0);
      return read(patched);
    }
    throw e;
  }
}

describeCorpus('corpus images', (corpus) => {
  it('every image entry decodes: 0 throws, 0 nulls beyond the fork files and PSDs', () => {
    const seen = new Set();
    const census = { archives: 0, entries: 0, bmp: 0, png: 0, gif: 0, jpeg: 0, indexedBmp: 0, fork: 0, psd: 0 };
    const extremes = { axis: 0, area: 0, gifFrames: 0 };
    /** @type {Map<string, number>} */
    const diagnostics = new Map();
    /** @type {string[]} */
    const failures = [];
    /** @type {string[]} */
    const unreadable = [];

    for (const kind of /** @type {const} */ (['wmp', 'wsz'])) {
      for (const entry of corpus.archives(kind)) {
        const bytes = corpus.read(entry);
        const sha = createHash('sha256').update(bytes).digest('hex');
        if (seen.has(sha)) continue; // identical archives under different names: decode once
        seen.add(sha);
        census.archives++;
        /** @type {Record<string, Uint8Array>} */
        let files;
        try {
          files = imageEntries(bytes);
        } catch (e) {
          unreadable.push(`${kind}/${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        for (const [name, data] of Object.entries(files)) {
          census.entries++;
          const { image, diagnostics: diags } = decodeImageWithDiagnostics(data);
          for (const d of diags) diagnostics.set(d.code, (diagnostics.get(d.code) ?? 0) + 1);
          const fork = FORK.test(name);
          if (fork) census.fork++;
          if (image) {
            const format = /** @type {'bmp' | 'png' | 'gif' | 'jpeg'} */ (detectFormat(data));
            census[format]++;
            if (image.indexed) census.indexedBmp++;
            extremes.axis = Math.max(extremes.axis, image.width, image.height);
            extremes.area = Math.max(extremes.area, image.width * image.height);
            extremes.gifFrames = Math.max(extremes.gifFrames, image.frames?.length ?? 1);
            // the probe and the decoder must agree about every size in the corpus
            expect(probeImage(data), `${kind}/${entry.name} ${name}`).toEqual({ format, width: image.width, height: image.height });
            if (fork) failures.push(`${kind}/${entry.name} ${name}: a RESOURCE.FRK/ fork file decoded as ${format}`);
          } else if (fork) {
            // allowed
          } else if (isPsd(data)) {
            census.psd++;
          } else {
            failures.push(`${kind}/${entry.name} ${name} (${data.length} bytes): ${JSON.stringify(diags)}`);
          }
        }
      }
    }
    // The numbers, for the gate report.
    console.log(`corpus images: ${JSON.stringify(census)} extremes ${JSON.stringify(extremes)} diagnostics ${JSON.stringify(Object.fromEntries(diagnostics))}`);

    expect(unreadable, 'archives fflate could not open').toEqual([]);
    expect(failures).toEqual([]);
    expect(census.fork).toBe(9);
    expect(census.psd).toBe(3);
    expect(census.entries).toBeGreaterThan(16000);
    // The caps clear the corpus exactly as D3 and section 10 say.
    expect(extremes).toEqual({ axis: 15990, area: 2528 * 3300, gifFrames: 145 });
    for (const code of ['image-over-cap', 'image-gif-frame-cap', 'image-gif-frames-memory', 'image-decode-error', 'image-corrupt', 'image-gif-truncated', 'image-bmp-rle-truncated']) {
      expect(diagnostics.get(code) ?? 0, code).toBe(0);
    }
    // everything unrecognised is a fork file or a PSD
    expect(diagnostics.get('image-unknown-format') ?? 0).toBe(census.fork + census.psd);
  }, 600_000);

  namedSizes(corpus);
});

/** The named sizes from ENGINE D3, found by entry name in their archives. @param {import('../support/fixtures.js').CorpusFixture} corpus */
function namedSizes(corpus) {
  /** @type {Array<[archive: string, entry: RegExp, width: number, height: number, format?: string]>} */
  const FACTS = [
    ['Nautical.wmz', /^vol_slider\.bmp$/i, 9494, 144, 'gif'], // a GIF named .bmp (G7)
    ['microsoft__pharaoh.wmz', /^seek_steps\.bmp$/i, 15990, 20, 'bmp'], // the widest
    ['The_Doobie_Brothers.wmz', /^vol_anim\.bmp$/i, 9152, 45],
    ['The_Doobie_Brothers.wmz', /^pos_anim\.bmp$/i, 4683, 91],
    ['Ice.wmz', /^vid-set\.bmp$/i, 9144, 12],
    ['Gold.wmz', /^progress\.bmp$/i, 6223, 13],
    ['Official_Xbox_XP.wmz', /^vol\.png$/i, 5040, 28],
    ['Official_Xbox_MP71.wmz', /^vol\.png$/i, 5040, 28],
    ['XBOX.wmz', /^seek\.png$/i, 4192, 13],
    ['Raptor.wmz', /^sktechsd\.bmp$/i, 2528, 3300, 'bmp'], // the largest image, unreferenced
  ];
  it.each(FACTS)('%s %s is %i x %i', (archive, entry, width, height, format) => {
    const file = corpus.archives('wmp').find((a) => a.name === archive);
    if (!file) return; // this corpus lacks the archive: nothing to assert
    const files = unzipSync(corpus.read(file), { filter: (f) => entry.test(f.name.split('/').pop() ?? '') });
    const found = Object.entries(files);
    expect(found.length, `${archive} has an entry named ${entry}`).toBeGreaterThan(0);
    for (const [name, data] of found) {
      const img = decodeImage(data);
      expect(img, name).not.toBeNull();
      expect([/** @type {any} */ (img).width, /** @type {any} */ (img).height], name).toEqual([width, height]);
      if (format) expect(detectFormat(data), name).toBe(format);
    }
  });
}
