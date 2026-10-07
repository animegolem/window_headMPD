# Review 1 of the skin Forth design draft 0.2

2026-10-07 · Window-Head-Dev (engine lead) to Astra.
Reviewed: `FORTH-DESIGN.md` at `4637e1e` on `codex/forth-design`. Engine pin `d7b1b48` (`skin-engine`),
read with `git show d7b1b48:` or a `git archive` export. `src/engine/{realm,layout,wms}` show no diff
between the pin and the live tree. Wave-5 work in progress was not reviewed.

**Evidence status.** All corpus figures come from scratch scans under `/tmp` (`/tmp/fdr`, `/tmp/fx-types`,
`/tmp/fd-corpus`, `/tmp/fd-bench`). The headline basis is **195 distinct archives (by SHA-256), all 577
VIEWs, parsed through `buildTheme`, with jscript: values classified by a TS 5.8 AST using the realm's
name-resolution order**. A dynamic pass ran the pinned `runLayoutPass` with WIDE budgets (1,000 ms per
expression), empty prefs and the test host. It measures semantics and side effects, not budget faults.
The timing and memory figures are Node 26.8.1 on an M3 Max using the engine's own `realm.js`. They are not
WKWebView figures. No engine suite, oracle, proof checker or exploit was run, and nothing here claims a
proof or a test result. The numeric limits in §3 are proposals to calibrate at gate 2, not measurements.
One basis note for the design: ENGINE's "2,773 of 2,791 view.width-N lefts" counts all 342 archives. Over
342 archives I get 2,839, and 1,649 over the distinct 195. Say which basis each cited figure uses.

## 1. Verdict

The draft is right on the points that matter most. I would keep all of the following as written.

- **§9 seam.** It does not pretend jscript: is data, and it does not strip side effects. `prelude.js:402`
  compiles it as `with(__IDS){with(this){return eval(__wmp_src)}}`, a sloppy direct eval with completion
  values. In the corpus, 1,042 values (130 skins) end in `;` and 10 values are IfStatements.
- **Translating a pure subset first pays off.** 99.2% of the corpus fits it (§2). The bridge stays for
  handlers: 13,905 sites in 194 skins.
- **Once-only evaluation in document order** matches D5 U-3. Within-element order sensitivity in the corpus
  is 0.
- **No replay of MPD commands after a failure.** `policy.js:228-235` `dispose()` already drops pending
  coalesced values.
- **Clocks.** The wall clock is separate from the injectable clock: `performance.now` is captured at module
  load in the realm, the drain and `layout/expr.js`. The policy and animator run on the engine clock. Keep
  this two-clock split.
- **R20** is script-loader repair (`realm.js:1104`, 7 of 219 scripts). It touches 0 layout values.
- **Gesture permits** should be affine and never dup-able. Gesture state already lives only in host JS
  (`realm.js:498, 882, 902, 1214`) and never crosses the membrane.
- **Prefs** stay a mutable, implicitly namespaced edge. No skin API names a namespace (`theme.js:49-59`).

Three corrections are to **my own earlier guidance**, which the draft quoted faithfully. They are in §3.6
and §3.5: per-view instances already exist; the gesture rule I gave narrows D6.5 rather than preserving it;
and "3 hard faults in 30 s" is the realm's unload rule, not a restart intensity.

## 2. Answers to your two questions

### Q1. Which corpus jscript: layout forms need the legacy-expression fallback

The basis is 7,079 non-handler jscript: attributes in 156 skins. Each attribute is bucketed by the most
demanding feature it uses. I checked the soundFX count directly with grep: 8 sites in 8 skins, 2 of them
`'false'==` or `btnSoundFx` variants. The first AST pass had missed those 2.

| Bucket | Attrs / skins | Examples |
| --- | --- | --- |
| Pure arithmetic over view, element and own-member reads | 6,612 / 144 | `view.width-svStub.width-svMain.left;`, `view.width-2*left` |
| Literals; ternary, comparison and `!`; string concat; `Math.round` | 12/3; 7/7; 15/3; 22/2 | `!eq.bypass`, `mediacenter.showTitles ? 50 : 1`, `'TruBass = ' + eq.truBassLevel` |
| Pure with an allowlisted host getter | 205 / 85 | `player.settings.getMode('loop')` 155/77; `effectType()`/`effectPreset()` 42/19 (these fault today, §11.2); `theme.loadString` 6/2; `loadPreference` inside a ternary 2/1 |
| Script-global read (a read-only bridge op, not eval) | 151 / 12 | `eq1.left+eqSpacer`. 128 read literal-initialised constants; 1 global is reassigned (Mandalay `drawerspeed`) |
| **Fallback: skin-function call** | 40 / 4 | `offsetx()`/`offsety()` (2 howarduniversity skins), `GetEqSliderLeft(N)` (9SeriesDefault), `chkDecVol()`/`chkIncVol()` (TDK) |
| **Fallback: prefs-gated write to another element** | 8 / 8 | `if('true'==theme.loadPreference('soundFX')) fxButton.down=true;` on `down` |
| **Fallback: statement completion value** | 4 / 2 | `if(eq.bypass == true)'Off';else'On';`, `if(eq.enhancedAudio){'On'}else{'Off'}` (PastAndBeyond, tubeframe) |
| **Fallback: bare assignment** | 1 / 1 | Halloween `down="visMask.alphaBlend=255"`, a host write during the pass |
| Refuse (reproduces today's soft ReferenceError) | 4 / 1 | howarduniversity Jordan, `balance.left+...` |

The fallback is **53 attributes in 14 skins (0.75%)**. With the two exact-shape rewrite rules in §3.4 it
falls to **41 attributes in 5 skins**: Halloween plus the 4 skin-function skins. Stripping a trailing `;`
is trivial. No layout expression calls a media, window, timer, `savePreference` or `openView` verb. The
dynamic pass produced 6,800 number, 171 boolean and 55 string results, plus 46 soft faults (42 not-a-function
and 4 ReferenceError).

### Q2. How the engine's mutation prohibition for layout expressions is enforced

**It isn't. No such prohibition exists at d7b1b48**, and that is my error to correct.

- **Entry.** `realm.evalExpression` (`realm.js:1155-1161`) refuses re-entry and runs
  `enter(site, budgets.expr, callEntry('evalExpr'))` against the full dispatcher. It sets no phase marker:
  `phase` is only ever `'script'` (`realm.js:500, 1095`), and it is read only for id-write diagnostics (`:615`).
- **Writes.** Writes and calls go through the same membrane dispatcher that handlers use
  (`view-runtime.js:600-602`). Element writes carry origin `'script'`, cancel tweens (`element.js:84`) and
  queue `<attr>_onchange` (`elements.js:189`). That queue drains after onload.
- **Read-only attributes.** `expr.js:199-205` drops a result whose target is read-only, "but its side effects
  stand".
- **What does bound an expression:**
  - the 20 ms `budgets.expr` limit;
  - the 1,000 ms pass cap, checked before each expression (`expr.js:145-152`);
  - membrane caps;
  - the result filter: only a primitive that the attribute coerces is accepted (`expr.js:192`);
  - no gesture during layout, so close and minimize fail;
  - the normal rate and prefs policies.

**What can happen today:** timers, `savePreference`, `openView` and MPD verbs are all reachable from a layout
expression. In the corpus, 1 write was executed during the dynamic pass (Halloween). The 8 soundFX writes run
only when the pref is set. "Layout quotations have an empty effect set" is therefore a **tightening**, not a
port, and the fallback node needs a declared effect row (§3.4).

## 3. Concrete proposals

### 3.1 Numeric and type model (§3)

"Checked integers and finite numbers" cannot be implemented as written. The pin uses at least nine value
domains, each with its own range policy. Proposed tower:

| Type | Representation | Range / policy | Evidence |
| --- | --- | --- | --- |
| `Px` | i32, checked | ±2^20, so Px×zoom(≤4)×DPR(≤2) stays below 2^23 and is exact in f32 GPU attributes | Corpus literals run −400..4,096; 106 negative layout results; 0 beyond ±4,096 |
| `PxExact` | finite f64, kept beside `Px` | anchors only | `align.js:23-24` keeps the fractional value so centred relayout does not drift |
| `ZIndex` | i32, separate type | — | `zIndex=90000` in 2 skins |
| `Axis` | u16 | 0..4,096, clamp with diagnostic | `elements.js:172-176`, `scene.js:70,87` |
| `Alpha` | u8 | ClampAtPaint for a script write; clamp-at-call for `alphaBlendTo` | `dom.js:169-171`, `element.js:112` |
| `Color` | `Rgb(u24) \| None \| Auto \| Unset` | — | many `attrs.js` defaults are null |
| `Volume` / `Mixer` | u8 0..100 / `NoMixer \| Level(Volume)` | never −1 | `contracts.d.ts:264`, `player.js:255-258` |
| `Balance` | i8 −100..100 | `balance.detent`: \|v\|≤5 → 0 | `player.js:20, 288-292` |
| `GainDb` | f64 | broker clamps to the admitted EqProfile (±14 WMP, ±12 Winamp) | `eq.js:48`, `dsp.js:32,41`, D11 |
| `Real` | finite f64 | slider min/max/value, hue/saturation, easing | slider-geometry D31; corpus min −127..5,000, max ..20,000 |
| `Ms`, `PosMs` | i64 integer ms | quantised once where the clock is injected; f64 seconds only at the bridge | `contracts.d.ts:263, 324` |
| `LayoutNum` | finite f64, JS `+ - * /` | imported layout only; a non-finite result flows to `px.half-even` and keeps prev (`membrane.js:19`); `numeric-domain` is the authored-code (`px.checked`) refusal | 13 fractional int results in 3 skins (`GetEqSliderLeft(1)` = 13.4545…) |
| `PlayState`, `OpenState` | sum types | total `>wmp-int` (0/1/2/3; 0/13); partial `wmp-int>` refuses in native code and keeps prev at the bridge | `player.js:43-59` |

**Strings.** Native `Str` is UTF-8 with a cap of 65,536 bytes. A string crossing the bridge must satisfy
both ≤65,536 UTF-16 units (the legacy rule, `membrane.js:32`) and ≤196,608 UTF-8 bytes. Lone surrogates
become U+FFFD, with one capped `bridge-lone-surrogate` diagnostic. Every cap name carries its unit
(`*.utf16`, `*.utf8`), because prefs count UTF-8 bytes (`policy.js:31-45`).

**No implicit Real→Px conversion.** Four named words, one per rounding boundary as the pin behaves:

| Word | Rule | Used at |
| --- | --- | --- |
| `px.half-even` | round half to even; −0 → 0; an invalid value keeps prev and emits a diagnostic | attribute and bridge coercion (`values.js:117, 145`) |
| `px.half-up` | floor(x+0.5) | tween, `moveTo`/`alphaBlendTo` targets, layout→paint px, slider edges (`animator.js:57`, `dom.js:71`, `slider-geometry.js:66-112`) |
| `px.floor` | floor | device→skin input mapping, clock display (`dispatch.js:265-277`, `player.js:31`) |
| `px.trunc` | trunc | scene and canvas axes, colour (`scene.js:87`, `compose.js:25`, `strings.js:88`) |

These rules disagree on real inputs. 3 fractional px literals (4.5, 142.5, 54.5) give 4/142/54 under
half-even and 5/143/55 under half-up. 3 layout results are exactly .5 (`treble.left+treble.width/2-23`
= 38.5). Script `el.left = 10.5` stores 10, while `el.moveTo(10.5,…)` lands on 11. Pin these as importer
fixtures. WMP's own half-even rule is still unconfirmed (`values.js` comment). Pin the easing as plain
multiplication in f64, not `**`/`pow`: `p<0.5 ? 4p³ : 1-((2-2p)³)/2`.

**Coercion is total and confined to two edges.** The signature is `coerce : Raw × AttrType × prev → T`. It
applies only at (1) WMS literal import and (2) values returned by the legacy bridge. Native code builds
values only through checked constructors that refuse. Freeze the grammar verbatim:
- numeric text: `^[+-]?(?:\d+\.?\d*|\.\d+)$` after trim;
- bool table: true/false, 1/0, `'true'`/`'false'`/`'1'`/`'0'`, case-insensitive; the number 2 keeps prev.

Add an `OutOfRange` field to the imported schema: `Ignore | Clamp | ClampAtPaint | ClampWithDiag`. Fill it
from the pin:
- slider value: Ignore (`element.js:73-77`);
- volume: Clamp(0,100);
- alphaBlend: ClampAtPaint;
- view w/h: ClampWithDiag(0,4096);
- vidset: Clamp(±127);
- other px: ClampWithDiag(±2^20). This is a new bound; today `left=1e300` reaches the DOM.

Fixtures: `'ture'`, `'600 '`, `'-1'`, `'1e3'`, `2`, and 4f6682948c36 `width = (…=='--') ? 640 :
theme.loadPreference('WD')`.

**Zoom and DPR.** Today `Zoom` is an unconstrained f64. Make it `n/4` with n ∈ 1..16, and `Dpr` ∈ {1,2}. The
app uses only 1 and 1.5 (`app/zoom.js:17-18`). Then `device = floor(px·n·dpr/4)` for both paint and hit
edges, and input maps back as `floor(device·4/(n·dpr))`. The paint and hit planes then cannot diverge by
rounding, which is what the drawer-mask story needs. Refuse any other zoom at window admission.

### 3.2 Capability table (§2, §7 item 5)

Do not seed this table from the 18-verb `MPD_ALLOWED_VERBS` (`guards.rs:14-33`). That list is the
page-realm→Rust blast-radius guard. Skin script code reaches only 9 wire verbs. Every capability is revoked
when a view incarnation ends (fault unload, restart, close) and when a replacement skin is admitted. The
last column lists only additional triggers.

| # | Capability | Ops | Dup | Consumable | Budget | Also revoked by |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `Media.Read` | snapshot, elapsed, queue window ≤256, subscribe | yes | no | publish ≤10 Hz realm-visible, 2 Hz under duty throttle | — |
| 2 | `Media.Transport` | play, pause, stop, next, previous | yes | no | sliding log of 10 per 1,000 ms per verb; overflow dropped and ledgered | — |
| 3 | `Media.Seek`, `Media.Volume` | latest-wins | yes | no | 40 ms trailing, 500 ms read-hold, deferred and never dropped | — |
| 4 | `Media.Mode` | loop→repeat, shuffle→random | yes | no | 10/s per mode | — |
| 5 | `Dsp.Eq`, `Dsp.Balance` | setGain(band 0..9), reset, setBypass; balance ±100 with detent | yes | no | latest-wins, ≤1 IPC per 40 ms (§3.3) | — |
| 6 | `Prefs.Skin` | implicit sha256 namespace | yes | byte quota | 256 keys, key ≤256 B, value ≤4 KiB, namespace ≤64 KiB (UTF-8), 250 ms debounce, Rust re-check | — |
| 7 | `Prefs.Mediacenter` | the 8 documented keys persist; the rest are session-only | yes | no | ≤64 keys × 4,096 chars | — |
| 8 | `GesturePermit` | consumed by one gated effect | **no, affine** | yes | one per trusted ingestion | its entry returning |
| 9 | `Window.Gesture` | close, minimize | yes; each use consumes #8 | no | denied and ledgered without a permit | — |
| 10 | `Window.Ambient` | returnToMediaCenter, requestSize (phase 1 returns false) | yes | no | 4/s | — |
| 11 | `View.Open` (phase 3) | open | yes | yes | ≤16 open, ≤4/s, gesture-gated | — |
| 12 | `Effects.Control` | next, previous, setIndex, step | yes | no | 10/s | — |
| 13 | `Palette.Read` | snapshot, subscribe, lerp | yes | no | coalesced per frame | — |
| 14 | `Audio.Frames` | one subscription per view | no | no | latest frame, ≤60 Hz; PCM only with `wantsPcm` (~61 KB/s) | window destroyed |
| 15 | `ObjectStore.Read` | manifest-scoped hashes | yes | no | a guessed hash is refused | — |
| 16 | `Clock.Timer` | set, clear | yes | live-slot count | ≤64 live per view, 10 ms floor (40 ms throttled), `timerInterval` 0 or ≥50 | — |
| 17 | `Diag.Log` | log | yes | yes | 200 lines × 512 chars per skin; 64 per stream, then one `-capped` | — |

Not grantable to skins: clear, load, single, consume, `playQueuePos`, `playPlaylist`, URL write, `launchURL`.
Engine-internal, never held by skin code: `setShape`, `setCapture`, `startDrag` (`isTrusted`,
`dispatch.js:377`) and Decode, which keeps the §10 caps (256 MiB LRU, 2 s kill, 16,384 px per axis,
16.7 M px area). `Harness.SyntheticInput` (§3.5) is never in a skin profile.

### 3.3 Caps mapping (ENGINE §10 → the Forth profile)

| Layer | Rows | Notes |
| --- | --- | --- |
| Checker (native code only) | source ≤1 MiB; ≤4,096 definitions; quotation nesting ≤32; static call depth ≤64 over an acyclic graph; data stack ≤256 cells, checked statically; ≤256 record fields; collections ≤4,096 (scene nodes ≤20,000); string literal ≤64 KiB UTF-8; arity ≤16 | proposals, calibrate at gate 2 |
| Fuel (native code) | layout quotation 200k steps; whole layout pass 10M; handler/timer/onchange 1M; onload/onclose 10M; top-level init 20M. Cost = 1+⌈n/64⌉; sort n·⌈log2 n⌉; resume every 4,096 units. VM values ≤16 MiB per view | keeps the 20:100:1,000:2,000 ms ratios; wall deadline + 300 ms overrun and the 50%/80% duty cycle stay as a backstop |
| Broker (native and legacy, at commit) | MPD **sliding log** of N=10 over the interval (now−1000, now] on the engine clock; a slot frees at exactly +1,000 ms (`policy.js:105-118`); discrete verbs Drop, seek/volume Defer+Coalesce 40 ms + Hold 500 ms; prefs as in row 6 above; timers 64 per view with a 10 ms floor; close/minimize gesture-only; openView 16 open / 4/s; diagnostics 64 per code per view, session 4,096, ledger 2,048; onchange queue 4,096, chain 32; binding chain 32 | **replace "window/token-bucket" in §5.** After 10 commands at t=0, a token bucket admits at t=100, but the sliding log waits until t=1,000 |
| Binding delivery | Tick{10 Hz, engine clock}, plus immediate delivery on notification with a tick restart (`bindings.js:24-33`) | §8 predicate: handler calls in any window W ≤ ⌈W·10/1000⌉ + notifications in W |
| WMS schema (importer, not language) | `timerInterval` 0 or ≥50 (`policy.js:126-131`); view axis clamp 4,096; mask popcount <64 → full rect | the 10 ms realm floor and the ≥50 rule are different rules at different layers |
| Decode/archive brokers | all archive and image rows unchanged, including the 2 s decode kill | — |
| Bridge only, dropped from native | membrane 16 args and 64 KiB key; R20 32 rewrites per file; compile-deadline poll; 1,000 jobs per drain; R19 guards | types, bounded parsing and chunked primitives replace them |
| Supervision | realm unload rule as-is; restart policy in §3.6 | — |

**DSP gap.** Today the DSP edge has no rate cap. `commitGains` sends all ten gains on every change
(`dsp.js:137-141`), and `eq.js:48` calls `setGain` with no policy check. Make `Dsp.*` latest-wins with at
most 1 `set_eq` and 1 `set_balance` per 40 ms. Script volume is also debounced twice, by `policy.js:28` and
`media.js:286`, for about 80 ms in total. Give each debounce exactly one owner, the broker.

### 3.4 Importer output and fallback (§7 row 13/21, §9)

1. **Split layout into eval and commit.** A pure result still has an effect when it is committed:
   `expr.js:207` writes with origin `'layout'`, and `elements.js:189-200` queues `<attr>_onchange` for
   every origin except init and quiet. In the corpus, 8 jscript: attrs sit on an element whose matching
   handler exists (value/width/height/left `_onchange`).
   - `layout.eval : ( LayoutEnv -- Value )` has effect row **`Read`** = {Element.Read(view snapshot),
     Media.Query, Prefs.Read(own), Res.Read, Legacy.ReadGlobal}. This row replaces "empty effect set".
   - `layout.commit : ( El Attr Value -- )` has row {Scene.Write(origin=layout), Legacy.QueueOnchange}. Only
     the pass driver applies it, never a quotation. Replay records the queued onchange events.

2. **Effect row for LegacyExpr (must-fix; two defensible rules, I recommend the first).**
   - **Recommended:** `LayoutLegacy = Read ∪ {Element.Write(same view, origin=layout)}`. Enforce it with a
     layout-mode dispatcher. `set` is admitted only on same-view element handles. `call` is admitted only on
     schema `kind==='prop'` members and pure getters: `getMode`, `loadPreference`, `loadString`,
     `isAvailable`, `getItemInfo`. Media.\*, Prefs.Write, Window.\*, timer creation, `openView` and the
     Promise-job drain become soft faults of type `layout-effect-refused`. This **breaks 0 corpus
     attributes**.
   - **Alternative:** also refuse `set` under a realm `phase='expr'`. This costs Halloween plus the 8
     prefs-gated soundFX writes.
   - Either way, this is an engine change and needs its own ticket. The origin change from `'script'` to
     `'layout'` is a recorded deviation. Both origins queue onchange, so no handler is lost.

3. **LayoutProgram is an ordered list, not a dataflow graph.**
   - `Step[] = [{el, attr, node}]`, in `view.elements` order. Within an element, follow the `attrs.js:81`
     AMBIENT order (left, top, right, bottom, width, height, then the rest), restricted to non-handler
     `attrSpecsOf(kind)` entries.
   - Invariant: no reordering, hoisting or CSE across steps, and every read sees the current model. The
     corpus depends on this: 2 forward reads see the default (QuickSilver ×2,
     `Unnamed_subview_37.width="videoWin.width+333"`).
   - Resolution order is own member → `__IDS` (exact id, then case-insensitive) → globals. A bare `left`
     means the element's own `left` (57 refs in 11 skins).
   - Caps: 1,000 ms per pass and 20 ms per LegacyExpr. If the pass stops, the remaining steps keep their
     literals (`expr.js:149-161`).
   - Terminal steps run in the order RecordAnchors → Sidecar → Bindings (`view-runtime.js:974-990`).

4. **Pure-subset grammar, decided on the AST only.**
   - Grammar:
     `E ::= Num | Str | Bool | Ref | E (+|-|*|/|%) E | E cmp E | !E | E&&E | E||E | E?E:E | Math.(round|floor|ceil|abs|min|max)(E) | Getter`.
   - `Ref ::= Root('.'Ident)*`, where Root ∈ {view, theme, player, mediacenter, elementId, ownMember,
     wmplocConst, scriptGlobal}. Members fold to lower case, as the proxies do. A single trailing `;` is
     stripped.
   - JS semantics are spelled out: f64 arithmetic; `%` is fmod with the dividend's sign (Erlang `rem`, not
     `Integer.mod`); `Math.round` = floor(x+0.5).
   - `+` is admitted only when both operand types are known from the schema (Num+Num or Str+Str).
     Otherwise the node becomes LegacyExpr, which costs at most 15 attrs in 3 skins. Number→string goes
     through `num>jsstring` (ECMA-262 Number::toString; Elixir `Float.to_string(3.0)` gives `"3.0"`).
   - Bitwise operators and ToInt32 stay behind the bridge. Add `rgb>color` and `color>rgb` for the 2
     colour-packing skins.
   - A node becomes **LegacyExpr** if it contains any of: an assignment, `++`, `--` or `delete`; a
     statement; a comma; a call to a skin function; a call outside the allowlist; `new`, a function
     literal, a regex or computed member access; or an `event` read. compact.wmz
     `maxWidth="event.screenWidth - rightMove"` evaluates to −179 today; it gets an `event-in-layout`
     diagnostic.
   - An unresolved identifier becomes **Refused{unresolved}**, so the attribute keeps its literal (Jordan,
     4 attrs in 1 skin).
   - The dynamic probe is only a cross-check, because load-time observation under-reports: it saw 1 of 9
     effectful sites, since an empty profile never sets soundFX. Fail the importer gate if the probe ever
     observes an effect inside a node classified pure.

5. **Script globals.** `LegacyGlobalRead{name}` has row {Legacy.ReadGlobal}. `realm.readGlobal`
   (`realm.js:1197`) reads a data property and runs no skin code, so it is admissible in `layout.eval`
   after top-level code completes. Optionally fold the 128 literal-constant reads to Literal and keep
   their provenance.

6. **Two exact-shape rewrites (consider).**
   - `if(C) E1; else E2;` with expression statements in both branches becomes `C ? E1 : E2`
     (4 attrs, 2 skins).
   - `if(C) <self>.A = K;` where A is the attribute being evaluated becomes `select(C, K, keep)`
     (8 attrs, 8 skins), with the origin change recorded.
   - Every other statement form stays LegacyExpr.

7. **Output schema.**
   - Node kinds: `Literal{type,value}`; `LayoutExpr{ir, reads, getters}`; `LegacyGlobalRead{name}`;
     `LegacyExpr{source, reason: assignment|statement|skin-call|non-allowlisted-call|event-in-layout|other,
     effects: LayoutLegacy}`; `Refused{reason}`; `Binding{path, negate, position}`;
     `Availability{method, negate}`; `Res{url}`; `HandlerSite{event, params, source, line}` (opaque, bridge
     only); `ScriptRef{name, kind}`.
   - Every node carries provenance: `{archiveSha256, wmsPath, viewId, elementId, attr, rawText≤60,
     valueClass, line}`. `Unnamed_<kind>_<n>` ids are stable per `build.js` step 4.
   - Diagnostics use the engine `Diagnostic` shape with codes `import-legacy-expr`, `import-refused`,
     `import-unsupported-stmt` and `import-prop-call-rewrite`. Each code is capped at 64 and then emits one
     `-capped` record. The report also carries the realm's R20 and script-syntax diagnostics for each file.
   - The importer consumes **`buildTheme` output**, not a raw scan. It therefore inherits last-wins
     duplicates, tag defaults, the 64-view and 20,000-element caps, and the rule that misspelled prefixes
     stay literal (18 skins).
   - wmpprop/wmpenabled/wmpdisabled are already a closed grammar (`values.js:202-272`), so they import
     100% as Binding and Availability nodes: 3,775 attrs in 190 skins, more than jscript: covers.
   - Prop-as-method (`mediacenter.effectType()`, 42 attrs in 19 skins) can be fixed statically from SCHEMA.
     That fix diverges from today's output, so name the oracle with an option
     `prop_call: 'wmp' | 'engine-d7b1b48'`, default `wmp`. Pin `engine-d7b1b48` for stories compared
     against skinlab goldens.

### 3.5 Gesture and effect rule (§5)

My earlier wording, "no inheritance by queued onchange or promise jobs", is **a narrowing of D6.5, not
today's behaviour**.

**What inherits a gesture today:**
- The view-runtime drain stamps queued items with `currentGesture` and runs them with it
  (`view-runtime.js:127-129, 403, 459-461, 937-940`).
- A gesture entry's own Promise jobs drain while `gestureDepth` is still raised (`realm.js:882-902`). This
  is pinned by `timers.test.js:141-152`.

**What does not:** the realm's own re-entrant `_onchange` and leftover jobs past the 1,000-job cap.

The narrowing is right because the corpus does not use the looser rule. Of the paths that reach close or
minimize (following up to 3 call levels), 375 sites in 69 skins are gesture handlers. 0 reach them from a
user-value `_onchange`. The corpus contains 0 `.click(` calls and 0 `Promise`/`.then(`.

Proposed rule for §5:

1. A `GesturePermit` is minted only by trusted ingestion: pointer down/up/click/dblclick, key events, and
   slider drag begin/end (`view-runtime.js:656-683`). It is bound to {session, viewIncarnation, dispatchId}.
2. The permit is valid only inside that entry's body. It is not carried into the runtime drain, the realm
   drain or the entry's Promise-job drain. Record this as deviation **`D6.5-gesture-narrowing`** in the
   importer parity ledger. When the bridge adopts it, `timers.test.js:141-152` changes to expect `[false]`.
3. **Two-phase check.**
   - At request time, inside the VM step that emits the effect: consume the permit, check that the
     capability is present, run rate admission, and validate arity and range. This produces
     `AdmittedRequest{cap, verb, args, incarnation, seq, gestureBound}`.
   - At commit time, in the broker: the incarnation is current, the capability is not revoked, the skin is
     loaded, and the Rust allow-list check (`guards.rs:37-39`) passes. **Gesture is never re-checked at
     commit.**
   - Invariant: the gesture-gated set G = {Window.Close, Window.Minimize, View.Open, View.CloseOther} and the
     deferred set D = {Media.Seek, Media.Volume, Dsp.\*, Prefs.Write, any rate-deferred verb} are disjoint. A
     gated request either commits in the gesture's broker turn or is dropped and ledgered. This matches
     today: only `theme.js:90, 115, 120` call `requireGesture`, and each runs `host.actions.run`
     synchronously.
4. A later continuation, if any, uses the draft's single-use token for one named dispatch in the same drain.
5. **Synthetic input.** Today `isTrusted` gates only the native drag (`dispatch.js:377`). Synthetic DOM
   events run with gesture=true (`view-runtime.js:664, 671`). The wish-23 REPL must use a separate
   `Harness.SyntheticInput` capability. Permits minted from it carry `origin: synthetic`, and the production
   broker refuses them for G. Story falsifier: a synthetic click cannot close a live window, and a genuine
   click can.

### 3.6 Fault isolation and per-view instances (§2)

1. **Per-view instances already exist.** `createRealm` builds a fresh `WebAssembly.Memory`, module, runtime
   and context on every call (`realm.js:454-484`). `attachView` calls it once per view
   (`view-runtime.js:952-963`). The `realm.js:3` header ("one module instance per skin session") and the
   ENGINE D1 text are stale; I will correct them in a separate engine-doc change.
   - In §2, replace "needs one independent instance … today's boundary is coarser" with: "preserve one
     QuickJS-WASM instance per view when moving under BEAM. Several views in one OS process contain a WASM
     trap but not a host or runtime crash."
   - The requirement matters: 102 of the 195 distinct skins have more than one VIEW, with a maximum of 9.
2. **Cost, measured in scratch.** Warm `createRealm` takes a median of 4.2 ms (max 14.8 ms); cold, 18-24 ms.
   Loading the heaviest script set (125,771 chars) takes a median of 7.3 ms. Resident memory is about
   2.8 MB per instance. Each instance reserves 16 MiB and can grow to an 80 MiB heap cap (85 MiB WASM
   maximum). No corpus skin grew past 16 MiB after its top-level scripts (187 skins). Nine views therefore
   reserve up to 765 MiB in the worst case, and the draft sets no session bound.
   - *Pins for these figures (measured, not proposed):* engine `d7b1b48`, `src/engine/realm/realm.js`
     SHA-256 prefix `685c4a163eb33bed`; `quickjs-emscripten-core` 0.32.0 with
     `@jitl/quickjs-wasmfile-release-sync` 0.32.0 (bellard QuickJS); corpus = the 195 distinct archives
     listed in `tests/corpus.manifest.json` at `d7b1b48` (file SHA-256 prefix `f3b28784073981ff`);
     Node v26.8.1, macOS 27.0, Apple M3 Max; scratch harness under `/tmp/fd-bench`.
3. **Proposal.**
   - One killable OS worker per skin session holds one WASM instance per view. A trap, OOM or budget fault
     restarts that view only. A worker crash restarts every legacy view in the session.
   - Lower `memoryLimitBytes` from 64 to 32 MiB per view.
   - Add a session aggregate: ≤192 MiB of growth beyond the initial 16 MiB per view, enforced in the
     existing `wasmMemory.grow` hook (`realm.js:461-473`). The view that is growing takes the `memory`
     fault.
4. **Unload vs restart.** "3 hard faults in 30 s" is the realm's unload rule
   (`REALM_CAPS.hardFaultWindowMs/hardFaultsToUnload`, `realm.js:90-91`). It is not a supervisor intensity,
   and the draft also omits `UNLOAD_AT_ONCE` = {memory, abort, host-exception, prelude} (`realm.js:108`).
   - Proposed restart policy, separate from unload: backoff 0 s, then 2 s, then 10 s; at most 3 restarts per
     view per 300 s, after which the fault panel shows.
   - Escalate to the session only when 2 distinct views exhaust their restarts within 300 s, or the worker
     exits.
   - Pending coalesced effects are discarded and never replayed.

### 3.7 Handled-event deadline (§5, OPEN → 0 ms)

Today "handled" is decided structurally, before the handler runs.
- **Right press:** handled if the picked element has a mouse handler (`dispatch.js:381, 391-394`).
- **Key:** handled if a handler site exists on the focused element or the VIEW, even if the handler faults
  (`view-runtime.js:666-672`, `dispatch.js:546-556`). The shell reads `defaultPrevented` (`keys.js:48`,
  `menu.js:246`).
- **Cost:** the DOM event is held for up to 100 ms of handler time + 300 ms of overrun slack + 1,000 ms of
  drain. A VIEW `onkeypress` (518 VIEW hotkeys in the corpus) also swallows Space/V.

Proposal:
- Each scene revision publishes a **HandlerManifest**: event classes per element, VIEW key handlers and
  `focusObjectID`. The adapter decides handled at ingestion, applies the default, then dispatches to the VM
  asynchronously. There is no timeout path, and VM execution can never flip the answer.
- Authored Forth key handlers declare `handles: {vk set}`. The legacy bridge keeps "site exists ⇒ handled"
  for parity. A dynamic handled answer is out of profile 1.

## 4. Priority list

**Must-fix**
1. §3/§9: no mutation prohibition exists. Give LegacyExpr the `LayoutLegacy` row and add a layout-mode
   dispatcher (§3.4.2). Change the native layout row from empty to `Read`.
2. §3/§7 row 13: split `layout.eval` from `layout.commit` so queued onchange events are not lost (§3.4.1).
3. §3: freeze the numeric tower, including `PxExact` (§3.1).
4. §3: four named rounding words with no implicit Real→Px, plus the half-pixel fixtures (§3.1).
5. §3/§9: coercion is total, keeps prev, and applies only at the two edges, with an `OutOfRange` schema
   field (§3.1).
6. §9: spell out JS operator semantics in the pure subset (`%`, `+`, `num>jsstring`) (§3.4.4).
7. §5: name the gesture rule as deviation `D6.5-gesture-narrowing` (§3.5.2).
8. §2/§5: two-phase request/commit with G∩D=∅; gesture is never checked at commit (§3.5.3).
9. §2: correct the per-view instance claim. Add the session memory aggregate and separate unload from
   restart (§3.6).

**Should-fix**
- Ordered LayoutProgram with its invariants (§3.4.3).
- Pure-subset grammar and AST-only fallback classification (§3.4.4).
- Importer output schema and the `prop_call` oracle option (§3.4.7).
- Capability table (§3.2) and caps mapping (§3.3).
- Sliding-log rate contract and the binding tick predicate (§3.3).
- DSP rate cap and a single debounce owner (§3.3).
- String units (§3.1).
- `Zoom = n/4`, `Dpr ∈ {1,2}` (§3.1).
- Fuel and checker numbers (§3.3).
- HandlerManifest with a 0 ms deadline (§3.7).
- `Harness.SyntheticInput` (§3.5.5).

**Consider**
- `LegacyGlobalRead` and literal folding (§3.4.5).
- The two exact-shape statement rewrites (§3.4.6).
- `PlayState`/`OpenState` enums with WMP int projections (§3.1).
