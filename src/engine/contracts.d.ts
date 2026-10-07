// The engine's cross-module contracts: ENGINE.md §5, verbatim, owned by Opus (WAVES W0.1).
//
// Implementing tasks never edit this file. A wrong or missing interface stops the task and goes
// back to O (WAVES global rule 6).
//
// How the file differs from the §5 text, and why:
// - Every `export function f(...)` of §5 is written here as an exported function type named after
//   it (`readZip` -> `ReadZipFn`). The implementing module annotates its export with it, e.g. in
//   `src/engine/archive/zip.js`:
//       /** @type {import('../contracts').ReadZipFn} */
//       export const readZip = (bytes, caps) => { ... };
//   so `tsc --noEmit -p tsconfig.check.json` proves the implementation matches.
// - The constants of §5 (`DEFAULT_ZIP_CAPS`, `SCHEMA`, `FAITHFUL`, `ORACLE_COMPAT`) have no value
//   declaration here, because a declaration without a module behind it would type-check an import
//   that fails at run time. Each is noted where §5 declares it, with the type its module annotates
//   it with; import the value from that module, never from this file.
// - §5.5 writes `animate: Pick<Animator, 'moveTo' | 'alphaBlendTo' | 'cancel'>` with the TypeScript
//   utility `Pick`, but §5.11 exports an interface named `Pick`, which shadows the utility in this
//   module ("TS2315: Type 'Pick' is not generic"). The `animate` member is therefore spelled out as
//   the same three members.
// - One tooling shim at the end of the file, which is not a contract (see there).

// ---------------------------------------------------------------------------------------------
// 5.1 Primitives and archive

export type Rgb = number;                                   // 0xRRGGBB
export interface Rect { x: number; y: number; w: number; h: number }
export type Unsubscribe = () => void;
export interface Diagnostic { code: string; detail: string; severity: 'info' | 'warn' | 'error';
  file?: string; line?: number; elementId?: string }

export interface ZipCaps { maxArchiveBytes: number; maxEntries: number; maxEntryBytes: number;
  maxTotalInflated: number; maxRatio: number; maxNameBytes: number }
// const DEFAULT_ZIP_CAPS: ZipCaps (archive/zip.js)         // 32 MiB, 4096, 32 MiB, 256 MiB, 1024, 255
export interface ZipEntry { name: string; key: string; method: 0 | 8; csize: number; usize: number;
  crc: number; offset: number }
export interface ZipIndex { readonly entries: readonly ZipEntry[]; readonly diagnostics: Diagnostic[];
  read(e: ZipEntry): Uint8Array | null }                    // null = corrupt or over cap; never throws
export interface ArchiveError extends Error { readonly name: 'ArchiveError'; readonly code: 'not-a-zip' | 'zip64' | 'multidisk' | 'archive-cap' }   // G1
export type ReadZipFn = (bytes: Uint8Array, caps?: Partial<ZipCaps>) => ZipIndex;   // throws ArchiveError only for not-a-zip / archive caps
export interface SkinVfs {
  readonly sha: string;                                     // SHA-256 hex of the archive bytes
  readonly name: string;                                    // archive file name, display only
  has(ref: string): boolean;
  read(ref: string): Uint8Array | null;                     // null = missing; never throws
  list(ext?: string): string[];                             // keys, e.g. list('.wms')
  resolve(ref: string): string | null;                      // ref -> key
  readonly diagnostics: readonly Diagnostic[];
}
export type OpenVfsFn = (bytes: Uint8Array, name: string, caps?: Partial<ZipCaps>) => Promise<SkinVfs>;
export type Sha256HexFn = (bytes: Uint8Array) => Promise<string>;
export type DecodeTextFn = (bytes: Uint8Array) => { text: string; encoding: 'utf-16le' | 'utf-16be' | 'utf-8' | 'ascii' | 'cp1252' };

// ---------------------------------------------------------------------------------------------
// 5.2 Parse

export interface RawAttr { name: string; value: string; line: number }      // name lowercased, entities decoded
export interface RawNode { tag: string; attrs: RawAttr[]; children: RawNode[]; line: number }
export type ScanWmsFn = (text: string) => { root: RawNode | null; diagnostics: Diagnostic[] };
export type PickDefinitionFn = (vfs: SkinVfs) => { wms: string; reason: 'only' | 'fewest-unresolved' | 'stem' | 'size'; unresolved: number } | null;

export type ElementKind = 'theme' | 'view' | 'subview' | 'button' | 'buttongroup' | 'buttonelement' | 'slider'
  | 'customslider' | 'progressbar' | 'text' | 'effects' | 'video' | 'playlist' | 'equalizersettings'
  | 'videosettings' | 'player' | 'controls' | 'settings' | 'mediacenter' | 'automenu' | 'listbox' | 'popup'
  | 'item' | 'editbox' | 'unknown';
export interface TagSchema { tag: string; kind: ElementKind; defaults: ReadonlyMap<string, string> }
export type ResolveTagFn = (tag: string) => TagSchema;
export type AttrType = 'int' | 'float' | 'bool' | 'string' | 'color' | 'image' | 'handler' | 'cursor' | { enum: readonly string[] };
export interface AttrSpec { name: string; type: AttrType; default: unknown; access: 'r' | 'rw' }
export type AttrSpecFn = (kind: ElementKind, attr: string) => AttrSpec | undefined;   // never resolves host-only x- names
export type AttrSpecForFn = (kind: ElementKind, attr: string, origin: Origin) => AttrSpec | undefined;   // G1: x- names resolve only for origin 'sidecar'; the builder and ElementModel.set use this
export type AttrSource =
  | { kind: 'literal'; text: string }
  | { kind: 'jscript'; source: string }
  | { kind: 'wmpprop'; path: BindPath }
  | { kind: 'wmpenabled' | 'wmpdisabled'; method: string }
  | { kind: 'res'; url: string }
  | { kind: 'handler'; source: string; params: string[] };
export interface BindSegment { name: string; args?: Array<string | number | boolean> }
export interface BindPath { root: string; segments: BindSegment[] }
export type ClassifyValueFn = (kind: ElementKind, attr: string, raw: string) => AttrSource;
export type ClassifyValueDiagFn = (kind: ElementKind, attr: string, raw: string) => { source: AttrSource; diagnostic: Diagnostic | null };   // G1: the builder uses this (misspelled binding prefixes, bad paths)
export type ParseBindPathFn = (src: string) => BindPath | null;   // G1: the one wmpprop: grammar (wms/values.js); bind/paths.js parsePath delegates to it
export type ParseColorFn = (s: string) => Rgb | 'none' | 'auto' | null;
export type CoerceFn = (type: AttrType, v: unknown, prev: unknown) => unknown;   // U-20: invalid keeps prev

// ---------------------------------------------------------------------------------------------
// 5.3 Element model

// G3: 'quiet' is a post-load write that updates the element (renderer, followers) but queues no
// <attr>_onchange: bindings use it for per-frame host values (the seek thumb at 60 Hz) between the
// realm-rate ticks, and followers inherit the quietness of the write that moved their source.
export type Origin = 'init' | 'layout' | 'script' | 'binding' | 'user' | 'anim' | 'host' | 'sidecar' | 'quiet';
export type AttrValue = string | number | boolean | null;
export interface HandlerSite { event: string; source: string; params: string[]; line: number }
export interface ElementModel {
  readonly handle: number;                                  // > 0, stable for the session
  readonly kind: ElementKind;
  readonly tag: string;
  readonly id: string;                                      // declared id or Unnamed_<type>_<n>
  readonly parent: ElementModel | null;
  readonly children: readonly ElementModel[];
  readonly docIndex: number;
  get(attr: string): AttrValue;                             // attr case-insensitive
  set(attr: string, v: unknown, origin: Origin): boolean;   // coerces; true if changed; queues <attr>_onchange unless origin 'init' or 'quiet'
  source(attr: string): AttrSource | undefined;
  readonly handlers: ReadonlyMap<string, HandlerSite>;      // lowercased event name
}
export interface ViewModel {
  readonly view: ElementModel;
  readonly elements: readonly ElementModel[];               // document order
  byHandle(h: number): ElementModel | undefined;
  byId(id: string): ElementModel | undefined;               // exact, then case-insensitive
  paintOrder(container: ElementModel): ReadonlyArray<ElementModel | 'background'>;
  onChange(cb: (el: ElementModel, attr: string, v: AttrValue, origin: Origin) => void): Unsubscribe;
  takeDirty(): Map<ElementModel, Set<string>>;
  takeQueuedEvents(): Array<{ el: ElementModel; event: string }>;   // the _onchange queue, FIFO
}
export interface ThemeModel {
  readonly views: readonly ViewModel[];
  readonly meta: { author: string; title: string; copyright: string; currentViewID: string | null };
  scriptsFor(viewId: string): string[];                     // scriptFile order, implicit <stem>.js last
  readonly diagnostics: readonly Diagnostic[];
}
export interface BuildCaps { maxElements: number; maxDepth: number; maxAttrs: number; maxAttrValue: number;
  maxViews: number; maxViewAxis: number }
export type BuildThemeFn = (root: RawNode, vfs: SkinVfs, opts: { probe: (ref: string) => ImageProbe | null;
  overlays?: SidecarOverlay[]; caps?: Partial<BuildCaps>; stacking?: 'context' | 'flat' }) => ThemeModel;   // G2: stacking

// ---------------------------------------------------------------------------------------------
// 5.4 Images

export interface ImageProbe { format: 'bmp' | 'png' | 'gif' | 'jpeg'; width: number; height: number }
export type ProbeImageFn = (bytes: Uint8Array) => ImageProbe | null;
export interface ImageCaps { maxAxis: number; maxArea: number; maxGifFrames: number }
export interface RgbaImage { width: number; height: number; data: Uint8ClampedArray;
  indexed?: { palette: Uint8Array; indices: Uint8Array }; frames?: { data: Uint8ClampedArray; delayMs: number }[] }
export type DecodeImageFn = (bytes: Uint8Array, caps?: Partial<ImageCaps>) => RgbaImage | null;
export type DecodeImageWithDiagnosticsFn = (bytes: Uint8Array, caps?: Partial<ImageCaps>) => { image: RgbaImage | null; diagnostics: Diagnostic[] };   // G1: what executors call
export interface KeySpec { transparency?: Rgb | 'auto' | null; clipping?: Rgb | 'auto' | null;
  hitKeyed: boolean; clipImage?: string }                   // clipImage = VFS ref of clippingImage
export interface KeyedPlanes { width: number; height: number; rgba: Uint8ClampedArray;
  paint: Uint8Array; hit: Uint8Array; clip: Uint8Array | null;   // 1 bit per pixel, row-major, LSB first
  // G1: clip bit 1 = inside the clip region (kept), 0 = clipped away; null = nothing clipped.
  // Alpha-0 pixels are never keyed; 'auto' read from an alpha-0 (0,0) pixel means no key.
  diagnostics?: Diagnostic[] }                              // G1: decode/keying warnings, carried to the image service
export type KeyImageFn = (img: RgbaImage, spec: KeySpec, clipImg?: RgbaImage | null) => KeyedPlanes;
export interface DecodeJob { bytes: Uint8Array; key: KeySpec; clipBytes?: Uint8Array }
export interface DecodeExecutor { run(job: DecodeJob): Promise<KeyedPlanes | null> }   // null = missing
export interface ImageService {
  probe(ref: string): ImageProbe | null;
  get(ref: string, spec: KeySpec): KeyedPlanes | null;      // sync; null until decoded or missing
  load(ref: string, spec: KeySpec): Promise<KeyedPlanes | null>;
  raw(ref: string): RgbaImage | null;                       // map images: never keyed
  pending(): number;
}
export type CreateImageServiceFn = (vfs: SkinVfs, exec: DecodeExecutor, log: Log) => ImageService;

// ---------------------------------------------------------------------------------------------
// 5.5 Realm and object model

export type Wire = undefined | null | boolean | number | string | { readonly __h: number };
export interface HostDispatcher {
  get(h: number, key: string): Wire | { method: true };     // key lowercased by the proxy
  set(h: number, key: string, v: Wire): void;
  call(h: number, key: string, args: Wire[]): Wire;         // args.length <= 16
  timer(op: 'set' | 'clear', id: number, ms: number, repeat: boolean): void;
  now(): number;                                            // engine clock, ms
}
export interface RealmBudgets { scripts: number; load: number; handler: number; expr: number; exprPass: number }
export interface RealmOptions {
  viewKey: string;
  memoryLimitBytes: number;                                 // 64 MiB of skin data; the enforced cap is the WASM heap (variant initial memory + this), G2
  maxStackBytes: number;                                    // G1: 256 KiB; host-dependent (escapes WASM at 320-384 KiB under Node 26), re-measured in WKWebView at W3.R
  budgets: RealmBudgets;                                    // 2000, 1000, 100, 20, 1000 ms
  wallClock: () => number;                                  // real performance.now, captured at module load
  dispatcher: HostDispatcher;
  classMembers: ReadonlyMap<string, readonly string[]>;     // class -> lowercased members (from the schema)
  hostGlobals: Readonly<Record<'player' | 'theme' | 'view' | 'event' | 'mediacenter' | 'playerApplication', number>>; // handles
  log: Log;
  testSeed?: string;
}
export type Fault = { ok: false; kind: 'soft' | 'hard'; reason: string; site: string };
export type Ok<T = Wire> = { ok: true; value: T };
export interface Realm {
  setIds(ids: ReadonlyArray<{ id: string; handle: number; className: string }>): void;   // once per view
  loadScript(name: string, source: string): Ok<void> | Fault;
  evalExpression(el: number, attr: string, src: string): Ok | Fault;
  runHandler(el: number, site: HandlerSite, ctx?: { event?: number; params?: Readonly<Record<string, Wire>>; gesture?: boolean }): Ok<void> | Fault;
  fireTimer(id: number): Ok<void> | Fault;
  callGlobal(name: string, args: Wire[]): Ok | Fault;      // demo, sidecar restore, tests
  readGlobal(name: string): Wire;                           // primitives only
  readonly inGesture: boolean;                              // true while a pointer/key handler runs
  readonly health: { soft: number; hard: number; unloaded: boolean; dutyThrottled: boolean };
  unload(reason: string): void;                             // revoke, clear timers, discard or dispose per D1
}
export type CreateRealmFn = (opts: RealmOptions) => Promise<Realm>;

export type MemberImpl = 'live' | 'emulated' | 'stub' | 'denied';
export type PolicyId = 'deny-log' | 'gesture-only' | 'rate-mpd' | 'pref-caps' | 'timer-caps' | 'view-current-only';
export interface MemberSpec { name: string; kind: 'prop' | 'method' | 'event'; type: 'number' | 'string' | 'bool' | 'object' | 'void';
  access?: 'r' | 'rw'; impl: MemberImpl; changeSource?: string; stubValue?: Wire; policy?: PolicyId }
export type ClassSchema = ReadonlyMap<string, MemberSpec>;
// const SCHEMA: ReadonlyMap<string, ClassSchema> (model/schema.js)
//                                                          // 'player', 'controls', 'settings', 'media', 'network', 'playlistObj',
//                                                          // 'theme', 'view', 'event', 'mediacenter', 'eq', 'vidset', 'element.<kind>', …
export interface HostObject {
  readonly className: string;
  get(member: string): Wire | { method: true };
  set(member: string, v: Wire, origin: Origin): void;
  call(member: string, args: Wire[], ctx: { gesture: boolean }): Wire;
}
export interface ObjectGraph {
  readonly globals: Readonly<Record<'player' | 'theme' | 'view' | 'event' | 'mediacenter' | 'playerApplication', HostObject>>;
  elementObject(el: ElementModel): HostObject;
  changeSource(path: string): { read(): Wire; subscribe(cb: () => void): Unsubscribe } | null;
  setEvent(ev: EventInit | null): void;
  dispose(): void;
  // G2 (W2.3): handles. Every HostObject the graph hands to the realm has a handle; objectOf maps it
  // back (null when unknown or revoked). hostGlobals feeds RealmOptions.hostGlobals.
  objectOf(handle: number): HostObject | null;
  readonly hostGlobals: Readonly<Record<'player' | 'theme' | 'view' | 'event' | 'mediacenter' | 'playerApplication', number>>;
  readonly ready: Promise<void>;                            // persisted mediacenter values applied
}
// G2: screenWidth/screenHeight added (spec 5.7, 38 corpus uses).
export interface EventInit { x: number; y: number; clientX: number; clientY: number; offsetX: number; offsetY: number;
  screenX: number; screenY: number; screenWidth: number; screenHeight: number; button: number; keyCode: number; altKey: boolean; ctrlKey: boolean; shiftKey: boolean;
  srcElement: ElementModel | null; fromElement: ElementModel | null; toElement: ElementModel | null }
export type CreateObjectGraphFn = (deps: { host: HostAdapter; view: ViewModel; theme: ThemeModel; skinSha: string;
  prefs: Map<string, string>; ledger: Ledger; opts: EngineOptions;
  animate: { moveTo: Animator['moveTo']; alphaBlendTo: Animator['alphaBlendTo']; cancel: Animator['cancel'] };   // element moveTo/slideTo/alphaBlendTo
  effectsOf: (el: ElementModel) => EffectsControl | null;            // EFFECTS element objects
  inGesture: () => boolean;                                          // D6.5 gesture gating
  queueEvent?: (el: ElementModel, event: string) => void;            // G2: script click() queues 'onclick'; the runtime drains it FIFO after the entry returns
  mediacenterPrefs?: Map<string, string> }) => ObjectGraph;          // G2: the already-loaded 'mediacenter' namespace
export interface LedgerEntry { api: string; kind: 'stub' | 'denied' | 'unknown-member' | 'unknown-tag' | 'unresolved-binding'
  | 'unresolved-res' | 'soft-fault' | 'cap'; count: number; detail?: string }
export interface Ledger { record(api: string, kind: LedgerEntry['kind'], detail?: string): void; entries(): LedgerEntry[] }
export type CreateLedgerFn = (skinSha: string) => Ledger;
export type WmplocConstantsFn = (opts?: { extras?: boolean }) => Record<string, number | string[]>;
// G1: wmploc.js helpers consumed by W2.2 (script loading) and W2.3 (theme.loadString, attributes).
export interface WmplocLibrary { id: number; install: 'before-scripts' | 'when-listed';
  constants: Record<string, number | string[]>; source: string }
export type ScriptEntry =
  | { kind: 'script'; path: string; implicit?: boolean }
  | { kind: 'library'; url: string; library: WmplocLibrary }
  | { kind: 'unknown-res'; url: string };
export type ParseScriptFileFn = (value: string | null | undefined, opts?: { stem?: string }) => ScriptEntry[];
export type ScriptLibraryFn = (url: string, opts?: { extras?: boolean }) => WmplocLibrary | null;
export type StringProblem = 'unresolved' | 'wrong-type' | 'unknown-id';
export type LookupStringFn = (url: string) => { text: string; problem: StringProblem | null };
export type ResolveStringAttributeFn = (attribute: string, value: string) => { value: string; problem: StringProblem | null };
export type ResolveResFn = (url: string) => { module: 'wmploc'; type: string; id: number } | null;
export type LoadStringFn = (url: string) => string;

// ---------------------------------------------------------------------------------------------
// 5.6 Media, DSP, audio

export interface SongInfo { id: number; pos: number; file: string; title: string; artist: string; album: string;
  genre: string; track: string; date: string; durationSec: number }
export interface MediaState {
  connected: boolean; playState: 'play' | 'pause' | 'stop';
  elapsed: number; duration: number;                        // s; elapsed as of the last status (G2); MediaModel.elapsed() extrapolates
  volume: number;                                           // 0..100, or -1 when MPD has no mixer
  random: boolean; repeat: boolean; single: boolean; consume: boolean;
  song: SongInfo | null; queueLength: number; queueVersion: number;
  queuePos: number | null;                                  // G1: MPD status.song (0-based), even when currentsong is empty
  bitrateKbps: number | null; error: string | null;
}
export interface MediaModel {
  snapshot(): Readonly<MediaState>;
  elapsed(): number;                                        // live extrapolation for per-frame reads
  subscribe(cb: (changed: ReadonlySet<keyof MediaState>) => void): Unsubscribe;
  queue(): readonly SongInfo[];
  storedPlaylists(): readonly string[];
  playlistSongs(name: string): Promise<readonly SongInfo[]>;
  play(): Promise<void>; pause(): Promise<void>; stop(): Promise<void>; next(): Promise<void>; previous(): Promise<void>;
  seek(sec: number): Promise<void>; setVolume(v: number): Promise<void>;
  setMode(mode: 'loop' | 'shuffle', on: boolean): Promise<void>;
  playQueuePos(pos: number): Promise<void>; playPlaylist(name: string, pos: number): Promise<void>;
  isAvailable(control: string): boolean;
}
export interface DspPort {
  eq: { gains(): readonly number[]; setGain(band: number, db: number): void; reset(): void;
        bypass(): boolean; setBypass(on: boolean): void; onChange(cb: () => void): Unsubscribe };
  balance: { get(): number; set(v: number): void; onChange(cb: () => void): Unsubscribe };   // -100..100, detent ±5
}
export interface AudioFrame { bands: Float32Array; wave: Float32Array; level: number; pcm?: Uint8Array }
export interface AudioFrameBus { subscribe(opts: { pcm?: boolean }, cb: (f: AudioFrame) => void): Unsubscribe }

// ---------------------------------------------------------------------------------------------
// 5.7 Windows

export type MaskShape =
  | { kind: 'bits'; width: number; height: number; bits: Uint8Array }      // 1 bpp, row-major, LSB first, skin px
  | { kind: 'regions'; width: number; height: number; regions: { x: number; y: number; w: number; h: number; poly?: number[] }[] };
export interface SkinWindow {
  readonly key: string;                                     // `${skinSha}/${viewId}`
  readonly binding: 'native' | 'cluster';
  readonly root: HTMLElement;
  readonly zoom: number;
  onZoom(cb: (z: number) => void): Unsubscribe;
  setZoom(z: number): Promise<void>;
  setInitialSize(w: number, h: number): Promise<void>;      // attach-time sizing (D7.4)
  requestSize(w: number, h: number): Promise<boolean>;      // script writes; phase 1 returns false
  setShape(shape: MaskShape): void;                         // coalesced to one IPC per frame
  setCapture(on: boolean): void;
  startDrag(): void;
  show(): Promise<void>; hide(): Promise<void>; minimize(): Promise<void>; close(): Promise<void>;
  setAlwaysOnTop(on: boolean): Promise<void>; setVisibleOnAllWorkspaces(on: boolean): Promise<void>;
  bounds(): Promise<Rect>;
  onClose(cb: () => void): Unsubscribe;
}
export interface WindowManager {                            // phase 3 beyond the first view
  open(viewId: string, at?: { left: number; top: number; relative: boolean }): Promise<boolean>;
  close(viewId: string): Promise<void>;
  isOpen(viewId: string): boolean;
}

// ---------------------------------------------------------------------------------------------
// 5.8 Host adapter

export interface EngineClock {
  now(): number;                                            // engine time, ms (animations, timers, marquees)
  onFrame(cb: (now: number) => void): Unsubscribe;
  setTimer(ms: number, cb: () => void): number;
  clearTimer(id: number): void;
}
export interface PrefStore {
  load(ns: string): Promise<Map<string, string>>;           // ns = 64-hex skin sha | 'app' | 'mediacenter'
  write(ns: string, key: string, value: string | null): void;    // debounced write-through; caps enforced
  onExternalChange(ns: string, cb: (key: string, value: string | null) => void): Unsubscribe;
}
export interface SlotSpec { kind: 'effects' | 'playlist' | 'video'; attrs: ReadonlyMap<string, AttrValue>; rect: Rect }
export interface EffectsControl { readonly count: number; readonly index: number; readonly title: string;
  titleOf(i: number): string; setIndex(i: number): void; step(d: 1 | -1): void; click(): void;
  onChange(cb: () => void): Unsubscribe }
export interface SlotHandle {
  readonly element: HTMLElement;
  update(spec: SlotSpec): void; setVisible(v: boolean): void;
  hitRects(): Rect[]; onHitRectsChange(cb: () => void): Unsubscribe;
  readonly effects?: EffectsControl;
  dispose(): void;
}
export interface SlotProvider { mount(el: HTMLElement, spec: SlotSpec, win: SkinWindow): SlotHandle }
export interface HostActions {
  run(action: 'returnToMediaCenter' | 'minimize' | 'close', ctx: { viewId: string }): void;
  denied(api: string, detail: string): void;                // one notice per skin per api
  fault(reason: string): void;                              // shows the fault panel
}
export interface Log { info(m: string, d?: object): void; warn(m: string, d?: object): void; diag(d: Diagnostic): void }
export interface HostAdapter {
  readonly kind: 'tauri' | 'test';
  readonly window: SkinWindow;
  readonly windows: WindowManager;
  readonly clock: EngineClock;
  readonly prefs: PrefStore;
  readonly media: MediaModel;
  readonly dsp: DspPort;
  readonly audio: AudioFrameBus;
  readonly palette: PaletteService;
  readonly decode: DecodeExecutor;
  readonly slots: SlotProvider;
  readonly actions: HostActions;
  readonly log: Log;
}

// ---------------------------------------------------------------------------------------------
// 5.9 Palette

export type NotanRole = string;                             // the nine notan-palette/1 v1 keys, verbatim
export interface PaletteSnapshot {
  source: 'artifact' | 'local' | 'default';
  association: 'current-uri' | 'retained' | 'default';
  track: { uri: string; generatedAt: string } | null;
  roles: Readonly<Record<NotanRole, string>> | null;        // all nine or null
  guarantees: readonly { a: NotanRole; b: NotanRole; kind: string }[];   // verbatim; [] unless artifact
  clusters: readonly { hex: string; oklch: [number, number, number]; share: number }[];
}
export interface PaletteService {
  snapshot(): PaletteSnapshot;
  subscribe(cb: (s: PaletteSnapshot) => void): Unsubscribe;
  lerp(a: string, b: string, t: number): string;            // the one blessed polar-OKLCH lerp
}

// ---------------------------------------------------------------------------------------------
// 5.10 Engine API, inspector, sidecar, skin hosts

export interface EngineOptions {
  config: 'faithful' | 'oracle-compat';
  sliderGeometry: 'oracle' | 'docs';                        // 'oracle' in both configs
  showBackgroundDefault: boolean;                           // faithful false (U-23), compat true
  buttonKeyedPixelsHit: boolean;                            // faithful true (spec 2.7), compat false
  stacking: 'context' | 'flat';
  subviewClip: boolean;
  availability: 'oracle' | 'mpd';
  realmTickHz: number;                                      // 10
  budgets: RealmBudgets;
  testSeed?: string;
}
// const FAITHFUL: EngineOptions (options.js)
// const ORACLE_COMPAT: EngineOptions (options.js)
export type CreateEngineFn = (host: HostAdapter, opts?: Partial<EngineOptions>) => Engine;
export interface Engine { load(archive: Uint8Array, opts?: { name?: string; sidecar?: Sidecar }): Promise<LoadedSkin> }
export interface LoadedSkin extends HostedSkin { attach(viewId?: string): Promise<ViewRuntime> }
export interface ViewRuntime extends HostedView {
  readonly viewId: string;
  readonly inspector: SkinInspector;
  readonly realmHealth: Realm['health'];
}
export interface SkinInspector {
  find(ref: string): { id: string; kind: ElementKind } | null;      // id or Unnamed_<type>_<n>
  rectOf(ref: string): Rect | null;                                 // view px, current animated value
  groupPoint(groupRef: string, mappingColor: string): { x: number; y: number } | null;   // view px
  sliderThumbPoint(ref: string, value: number): { x: number; y: number } | null;       // view px
  attr(ref: string, name: string): Wire;
  setAttr(ref: string, name: string, v: Wire): void;                // origin 'host'
  callGlobal(name: string, args?: Wire[]): Wire;
  readGlobal(name: string): Wire;
  stackingDump(): string[];
  root(): HTMLElement;                                              // div.view
}
export interface SidecarOverlay { parent: string; tag: 'text'; attrs: Readonly<Record<string, AttrValue>>;
  hostStyle?: { letterSpacing?: string } }
export interface Sidecar {
  schema: 'window_headmpd-sidecar/1'; skin: string;
  overlays?: SidecarOverlay[];
  attrs?: { ref: string; name: string; value: AttrValue }[];
  compat?: { attrs?: { ref: string; name: string; value: AttrValue }[] };
  actions?: { returnToMediaCenter?: 'zoomToggle' | 'none' };
  restore?: { global: string; toggle: string; pref: string }[];
  viewResize?: 'honor' | 'ignore';
  tour?: Record<string, unknown>;
}
export interface EqProfile { centres_hz: number[]; q: number; min_db: number; max_db: number; has_preamp: boolean }
export interface SkinHost {
  readonly family: 'wms' | 'wsz' | 'native';
  canLoad(vfs: SkinVfs): number;                            // 0..1
  load(vfs: SkinVfs, ctx: { host: HostAdapter; sidecar?: Sidecar }): Promise<HostedSkin>;
}
export interface HostedSkin {
  readonly sha: string;
  readonly family: SkinHost['family'];
  readonly capabilities: { eq: EqProfile | null; wantsPcm: boolean; windowModel: 'native-per-view' | 'cluster'; scripted: boolean };
  views(): { id: string; width: number; height: number; main: boolean }[];
  attach(viewId?: string): Promise<HostedView>;
  diagnostics(): Diagnostic[];
  ledger(): LedgerEntry[];
  dispose(): void;
}
export interface HostedView {
  maskShape(): MaskShape;                                   // the last shape sent
  settled(): Promise<void>;                                 // no tween, no queued events, no pending decode
  readonly health: { soft: number; hard: number; unloaded: boolean };
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// 5.11 Internal engine modules (contracted so waves can run in parallel)

// layout/
export type EvaluateLayoutFn = (view: ViewModel, realm: Realm, opts: { passBudgetMs: number }) => Diagnostic[];
export type RecordAnchorsFn = (view: ViewModel) => void;
export type RelayoutFn = (view: ViewModel, w: number, h: number) => void;     // phase 3 caller
export type PaintOrderFn = (container: ElementModel, opts: { stacking: 'context' | 'flat' }) => ReadonlyArray<ElementModel | 'background'>;
// bind/
export type ParsePathFn = (src: string) => BindPath | null;
export interface BindingEngine { install(): void; suspend(el: ElementModel, attr: string): void; resume(el: ElementModel, attr: string): void;
  frame(now: number): void; dispose(): void }
export type CreateBindingsFn = (view: ViewModel, graph: ObjectGraph, clock: EngineClock, opts: { realmTickHz: number; ledger?: Ledger }) => BindingEngine;   // G3: ledger
// anim/
export interface Animator { moveTo(el: ElementModel, x: number, y: number, ms: number, ease: 'linear' | 'inout', w?: number, h?: number): void;
  alphaBlendTo(el: ElementModel, a: number, ms: number): void; cancel(el: ElementModel): void; frame(now: number): void; running(): number }
export type CreateAnimatorFn = (clock: EngineClock, fire: (el: ElementModel, event: 'onendmove' | 'onendalphablend') => void) => Animator;
// render/
// G3: the pointer's visual state (hover/press), which is not in the model. For a BUTTONGROUP the target
// is the BUTTONELEMENT and part its index (the picker's shape).
export interface PointerTarget { el: ElementModel; part?: number | null }
export interface Renderer { mount(view: ViewModel): void; frame(dirty: Map<ElementModel, Set<string>>, now?: number): void;
  nodeOf(el: ElementModel): HTMLElement | undefined; slotOf(el: ElementModel): SlotHandle | undefined; dispose(): void;
  readonly plane: HTMLElement | null;                       // G3: div.input, for attachInput
  readonly windowed: HTMLElement | null;                    // G3: div.windowed, native-child-window widgets
  setPointer(over: PointerTarget | null, pressed: PointerTarget | null): void }   // G3
export type CreateRendererFn = (root: HTMLElement, images: ImageService, slots: SlotProvider, win: SkinWindow, opts: EngineOptions,
  extras?: { clock?: EngineClock; log?: Log }) => Renderer;   // G3: extras
// input/
export type PickRole = 'control' | 'blocked' | 'effects' | 'widget' | 'chrome';
// G3: for a BUTTONGROUP, el is the owning BUTTONELEMENT, part its index among the group's BUTTONELEMENT
// children, and local is relative to the GROUP's top-left; enabled=false on the element or the group
// makes the pick 'blocked'. A SLIDER/PROGRESSBAR with no thumbImage and no mouse handler is 'chrome'.
export interface Pick { el: ElementModel; part: number | null; role: PickRole; local: { x: number; y: number } }
export type PickFn = (view: ViewModel, images: ImageService, slotRects: (el: ElementModel) => Rect[], x: number, y: number, opts: EngineOptions) => Pick | null;
export interface InputSink { gesture(el: ElementModel, event: string, init: EventInit, part: number | null): void;
  key(event: 'onkeydown' | 'onkeypress' | 'onkeyup', init: EventInit): boolean;   // true if a skin handler ran. G3: runs only
  // init.srcElement's own handler, never bubbles (dispatch calls it for the focused element, then the VIEW).
  // keyCode: Windows VK for keydown/keyup, the character code for keypress (spec 5.7).
  dragSlider(el: ElementModel, phase: 'begin' | 'move' | 'end', value: number): void }
// G3: deps.thumbExtent gives a slider thumb's length along its axis in skin px (W4.1 computes it from
// the shared slider geometry and the image probe). A press the skin handled (right press, keys) is
// reported by preventDefault() on the DOM event; the shell's menu and keys check defaultPrevented.
export type AttachInputFn = (plane: HTMLElement, view: ViewModel, pickAt: (x: number, y: number) => Pick | null,
  win: SkinWindow, sink: InputSink, opts: EngineOptions, deps?: { thumbExtent(el: ElementModel): number }) => Unsubscribe;
// shape/
export type RasterizeShapeFn = (view: ViewModel, images: ImageService, slotRects: (el: ElementModel) => Rect[], opts: EngineOptions) => MaskShape;
export type RasterizeShapeWithDiagnosticsFn = (view: ViewModel, images: ImageService, slotRects: (el: ElementModel) => Rect[], opts: EngineOptions,
  extra?: object) => { shape: MaskShape; diagnostics: Diagnostic[] };   // G3: the popcount < 64 fallback diagnostic

// ---------------------------------------------------------------------------------------------
// Tooling shim, not a contract. tsconfig.check.json keeps `skipLibCheck` off so that an error in
// this file fails the check instead of silently turning the broken type into `any`. With it off,
// jpeg-js's own typings must check, and they name Node's `Buffer`. Declaring `Buffer` as a type
// only satisfies them without loading Node's globals, so engine code that uses the `Buffer`
// value (which does not exist in the webview) still fails the check.
declare global { interface Buffer extends Uint8Array {} }
