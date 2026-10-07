// @ts-check
import { describe, expect, it } from 'vitest';
import { createTauriAudio, toAudioFrame } from '../../../src/hosts/tauri/audio.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Tauri's `Channel`, reduced to what the bus uses: an `onmessage` the test can call like Rust does. */
class FakeChannel {
  /** @type {(frame: any) => void} */
  onmessage = () => {};
  static made = /** @type {FakeChannel[]} */ ([]);
  constructor() { FakeChannel.made.push(this); }
}

/** @param {{ failSubscribe?: boolean, slow?: boolean }} [o] */
function setup(o = {}) {
  FakeChannel.made = [];
  /** @type {Array<[string, any]>} */
  const calls = [];
  /** @type {Array<(id: number) => void>} */
  const releaseIds = [];
  /** @type {Array<[string, object | undefined]>} */
  const warnings = [];
  let nextId = 7;
  const invoke = async (/** @type {string} */ cmd, /** @type {any} */ args) => {
    calls.push([cmd, args]);
    if (cmd === 'audio_subscribe') {
      if (o.failSubscribe) throw new Error('no audio engine');
      const id = nextId++;
      if (o.slow) return new Promise((r) => releaseIds.push(() => r(id)));
      return id;
    }
    return undefined;
  };
  const bus = createTauriAudio({ invoke, Channel: /** @type {any} */ (FakeChannel), log: { warn: (m, d) => { warnings.push([m, d]); } } });
  return { bus, calls, warnings, releaseIds, channel: (/** @type {number} */ i = 0) => FakeChannel.made[i] };
}

const rustFrame = (/** @type {object} */ extra = {}) => ({ bands: [0.1, 0.2, 0.3], wave: [-1, 0, 1, 0.5], level: 0.25, ...extra });

describe('subscribe', () => {
  it('calls audio_subscribe with a Channel and the pcm wish, in the call shape Rust takes', async () => {
    const t = setup();
    t.bus.subscribe({}, () => {});
    t.bus.subscribe({ pcm: true }, () => {});
    await settle();
    expect(t.calls).toEqual([
      ['audio_subscribe', { onFrame: t.channel(0), opts: { pcm: false } }],
      ['audio_subscribe', { onFrame: t.channel(1), opts: { pcm: true } }],
    ]);
    expect(t.channel(0)).not.toBe(t.channel(1));                     // one Rust subscriber each: no stolen feed
  });

  it('turns Rust\'s JSON arrays into the contract\'s typed arrays', () => {
    const t = setup();
    /** @type {any[]} */
    const frames = [];
    t.bus.subscribe({}, (f) => frames.push(f));
    t.channel().onmessage(rustFrame());
    expect(frames).toHaveLength(1);
    expect(frames[0].bands).toBeInstanceOf(Float32Array);
    expect(frames[0].wave).toBeInstanceOf(Float32Array);
    expect(Array.from(frames[0].bands)).toEqual(Array.from(new Float32Array([0.1, 0.2, 0.3])));
    expect(Array.from(frames[0].wave)).toEqual([-1, 0, 1, 0.5]);
    expect(frames[0].level).toBe(0.25);
    expect('pcm' in frames[0]).toBe(false);
  });

  it('passes pcm on only to a subscriber that asked for it', () => {
    const t = setup();
    /** @type {any[]} */
    const plain = [];
    /** @type {any[]} */
    const wants = [];
    t.bus.subscribe({}, (f) => plain.push(f));
    t.bus.subscribe({ pcm: true }, (f) => wants.push(f));
    const frame = rustFrame({ pcm: [128, 130, 126] });
    t.channel(0).onmessage(frame);
    t.channel(1).onmessage(frame);
    expect('pcm' in plain[0]).toBe(false);
    expect(wants[0].pcm).toBeInstanceOf(Uint8Array);
    expect(Array.from(wants[0].pcm)).toEqual([128, 130, 126]);
  });

  it('drops a malformed frame rather than delivering half of one', () => {
    const t = setup();
    let heard = 0;
    t.bus.subscribe({}, () => { heard++; });
    for (const bad of [null, undefined, 'x', 5, {}, { bands: [1], wave: [1] }, { bands: 'no', wave: [1], level: 0 }, { bands: [1], wave: [1], level: '0' }]) {
      t.channel().onmessage(bad);
    }
    expect(heard).toBe(0);
  });

  it('a throwing callback is logged and the next frame still arrives', () => {
    const t = setup();
    let n = 0;
    t.bus.subscribe({}, () => { n++; if (n === 1) throw new Error('boom'); });
    t.channel().onmessage(rustFrame());
    t.channel().onmessage(rustFrame());
    expect(n).toBe(2);
    expect(t.warnings.map(([m]) => m)).toEqual(['audio: a frame callback threw: boom']);
  });

  it('counts live subscriptions', async () => {
    const t = setup();
    const off1 = t.bus.subscribe({}, () => {});
    const off2 = t.bus.subscribe({}, () => {});
    expect(t.bus.subscribers()).toBe(2);
    off1();
    off1();                                                          // a second unsubscribe changes nothing
    expect(t.bus.subscribers()).toBe(1);
    off2();
    expect(t.bus.subscribers()).toBe(0);
  });
});

describe('unsubscribe', () => {
  it('calls audio_unsubscribe with the id Rust gave, once, and stops the frames at once', async () => {
    const t = setup();
    let heard = 0;
    const off = t.bus.subscribe({}, () => { heard++; });
    await settle();
    t.channel().onmessage(rustFrame());
    expect(heard).toBe(1);
    off();
    off();
    t.channel().onmessage(rustFrame());                              // a frame already in flight
    await settle();
    expect(heard).toBe(1);
    expect(t.calls.filter(([c]) => c === 'audio_unsubscribe')).toEqual([['audio_unsubscribe', { id: 7 }]]);
  });

  it('remembers an unsubscribe that comes before the id and sends it when the id lands', async () => {
    const t = setup({ slow: true });
    let heard = 0;
    const off = t.bus.subscribe({}, () => { heard++; });
    off();
    t.channel().onmessage(rustFrame());
    expect(heard).toBe(0);
    await settle();
    expect(t.calls.filter(([c]) => c === 'audio_unsubscribe')).toEqual([]);
    t.releaseIds[0](7);
    await settle();
    expect(t.calls.filter(([c]) => c === 'audio_unsubscribe')).toEqual([['audio_unsubscribe', { id: 7 }]]);
  });

  it('unsubscribes each subscription by its own id', async () => {
    const t = setup();
    const off1 = t.bus.subscribe({}, () => {});
    const off2 = t.bus.subscribe({}, () => {});
    await settle();
    off2();
    off1();
    expect(t.calls.filter(([c]) => c === 'audio_unsubscribe').map(([, a]) => a)).toEqual([{ id: 8 }, { id: 7 }]);
  });

  it('a failed subscribe is logged, never thrown, and its unsubscribe is harmless', async () => {
    const t = setup({ failSubscribe: true });
    const off = t.bus.subscribe({}, () => {});
    await settle();
    expect(t.warnings.map(([m]) => m)).toEqual(['audio: audio_subscribe failed: no audio engine']);
    expect(() => off()).not.toThrow();
    expect(t.calls.filter(([c]) => c === 'audio_unsubscribe')).toEqual([]);
  });
});

describe('toAudioFrame', () => {
  it('accepts typed arrays too', () => {
    const f = toAudioFrame({ bands: new Float32Array([1]), wave: new Float32Array([2]), level: 3, pcm: new Uint8Array([4]) }, true);
    expect(f && [Array.from(f.bands), Array.from(f.wave), f.level, Array.from(f.pcm ?? [])]).toEqual([[1], [2], 3, [4]]);
  });
});
