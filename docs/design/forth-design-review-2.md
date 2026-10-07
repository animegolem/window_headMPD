# Review 2 of the skin Forth design draft 0.3

2026-10-07 · Window-Head-Dev (engine lead) to Astra.
Reviewed: `FORTH-DESIGN.md` at `a7f25e6` (diff against `4637e1e`). Engine pin unchanged: `d7b1b48`
(`skin-engine`). `5bfec40` and `95321b2` change docs and one header comment only.

**Evidence status.** These are code reads at the pin, with file:line citations. No new corpus scan, test,
oracle or benchmark was run. Two items cite Wave 5 work in progress, which is not committed and was not at
the pin. They are marked **WIP** and come from the W5.4 corpus mount report. Each item is labelled **Fact**
(read at the pin) or **Proposal** (a number or policy to calibrate at gate 2). §4 corrects two errors that
rev 0.3 took from my review 1.

## 1. Verdict

Rev 0.3 incorporates review 1 accurately. I spot-checked the attributions it carries against the pin, and
they hold:

- The sliding log is `RATE_LIMIT = 10` per verb in `RATE_WINDOW_MS = 1000` (`policy.js:25-26`). A slot frees
  when `now - ts[0] >= 1000` (`policy.js:109-110`), so the window is (now−1000, now] and capacity returns
  at exactly +1000 ms.
- The coalesce interval is 40 ms and the hold is 500 ms (`policy.js:28,30`).
- The binding tick is 10 Hz (`bindings.js:84`).
- 8 prefs-gated soundFX writes, the dynamic-pass miss, and "breaks 0 corpus attributes" for `LayoutLegacy`
  are all stated in review 1 as rev 0.3 reports them.

Both of your challenges are right. One new error, in G, needs a fix (§3.1).

## 2. Challenge 1: 192 MiB of growth is not a total session bound

Conceded. My review-1 proposal bounded growth only. Four facts sharpen the replacement:

- **Fact.** `maxViews: 64` (`wms/build.js:56`) bounds *declared* VIEWs. Views past the 64th are dropped with
  a `cap-views` diagnostic (`build.js:573-574`). It does not bound live realms.
- **Fact.** Live realms are bounded by the attach policy. At the pin, a session attaches one view
  (`index.js:148`), and another VIEW named by `openView` or `currentViewID` is denied with
  `policy.foreignView` (`theme.js:82-85`). ENGINE §9 (line 834) plans ≤16 *open* views per skin and
  ≤4 opens/s for phase 3. **WIP:** the 5F.6 view switch disposes the old realm before attaching the new one,
  so a switch never holds two live realms.
- **Fact.** Each realm owns a fresh `WebAssembly.Memory` with a 16 MiB initial size (`realm.js:105`).
  `heapCap` = 16 MiB + `memoryLimitBytes`, and the WASM maximum is `heapCap`·17/16 (`realm.js:450-456`).
  These are reservations. The ~2.8 MB in review 1 is resident memory.
- **Fact.** After an abort or OOM, a realm is discarded and never disposed (ENGINE D1, fault domain). Its
  memory comes back only when GC collects it. A bound that forgets retired realms is fiction under repeated
  faults. Both review 1 and rev 0.3 miss this.

**Proposal (gate 2).** Use one total instead of a growth figure.

1. *Accounted bytes.* SessionWasm = Σ over live realms **and retired-but-unreclaimed realms** of
   `wasmMemory.buffer.byteLength` + F per instance. F is the fixed non-heap charge; the proposed value is
   4 MiB, to be measured at gate 2. Byte length is the worst case resident size for linear memory, and it
   can be checked without OS instrumentation.
2. *Admission.* An open is refused if SessionWasm + 16 MiB + F > T. The refused view gets a
   `view-open-refused: memory` diagnostic, and existing views are untouched.
3. *Growth.* The existing grow hook (`realm.js:461-473`) refuses growth that would push SessionWasm past T.
   The growing view takes the `memory` fault.
4. *Retired realms.* A `FinalizationRegistry` on each discarded `WebAssembly.Memory` removes its bytes from
   SessionWasm when GC reports it. Retired bytes above R mean the session worker is recycled at the next
   quiescent point; under BEAM, killing the OS worker is the reclamation that cannot be lost. R is 64 MiB.
5. *Numbers.*
   - Per-view `memoryLimitBytes` is 32 MiB, so the per-view linear maximum is 48 MiB.
   - T = 16·(16 + F) + 64 MiB = **384 MiB** with F = 4. The planned 16 open views fit at their initial size
     with 64 MiB of headroom.
   - The corpus maximum of 9 VIEWs uses 180 MiB at initial size, leaving 204 MiB for growth. No corpus skin
     grew past 16 MiB after its top-level scripts (review 1, 187 skins).
   - If gate 2 measures a different F, keep the formula and recompute T.
6. *Tests.*
   - (a) 64 declared VIEWs parse, and the 65th is dropped with `cap-views`.
   - (b) 16 views open at initial size; the 17th is refused by the open-count cap. With F raised so that
     memory binds first, the memory refusal fires before the count cap.
   - (c) At T, one view grows past the headroom; that view alone faults and the others keep running.
   - (d) A discarded realm still counts until reclaimed; an open that only fits by forgetting it is refused.
   - (e) Every 9-view corpus skin opens all of its views.

## 3. Challenge 2: one immediate attempt across an async broker

**Baseline facts at the pin.**

- The gesture check is synchronous inside the VM entry: `policy.requireGesture` reads `ctx.gesture` or
  `deps.inGesture()` (`policy.js:90-94`), called at `theme.js:90,115,120`.
- The commit is `host.actions.run` → `skinWindow.close()`/`minimize()` (`hosts/tauri/index.js:220-222`).
  That is one fire-and-forget Tauri call. A failure is logged as a warning, with no retry, no queue and no
  ledgered outcome.
- **The native side has no gate on window actions.** `guards.rs:160` `"close"` is in the deny list for
  MPD verbs and is unrelated. Today "one immediate attempt" means one IPC send during the entry, with
  nothing checked at commit.

### 3.1 Fix G first

Rev 0.3 puts open-view in G. That breaks splash hand-over, the commonest multi-view start.

- **WIP evidence (W5.4).** 34 corpus skins start on a splash view and hand over without a gesture.
  14 of the 34 do it through a size-less `controlView` whose `onload` calls `theme.openView('mainView')`.
  Others write `currentViewID` from `onload` or a timer.
- D6.5 exists so that "a skin cannot close itself at every launch" (ENGINE §9, line 835). The threat is dismissal,
  not opening.
- **Proposal.** G = {`view.close`, `view.minimize`, `theme.closeView(current)`}. `closeView(other)` is a
  phase-3 decision and stays in G provisionally, as dismissal.
- `openView`, `openViewRelative` and `currentViewID` writes leave G. They are governed by the open-view
  caps (≤16 open, ≤4/s) and the hand-over rule.
- G and D stay disjoint.

### 3.2 The protocol (proposal)

Four actors take part:

- **Ingest:** the trusted input adapter.
- **View:** the VIEW actor running the closed evaluator.
- **WinBroker:** handles G only, kept separate from the media broker so that a seek/volume backlog never
  sits in front of a close.
- **Host:** the window service.

1. **Mint.**
   - On a trusted pointer or key event for view V at incarnation I, Ingest `call`s WinBroker with
     `{mint, V, I, D}`.
   - WinBroker creates P = `make_ref()` and stores P → {V, I, D, open}. It monitors V's pid and returns P.
   - Only then does Ingest send `{event, D, P, …}` to View.
   - The mint must be synchronous. BEAM orders messages only per sender–receiver pair, so an async mint
     could arrive after View's commit.
   - `Harness.SyntheticInput` mints permits marked synthetic, and WinBroker refuses G effects for them.
2. **Entry.**
   - P is an affine VM value; skin code can consume it but never read it as data.
   - On a G effect, the evaluator checks the capability and arguments, consumes P, and casts
     `{commit, P, effect}` to WinBroker.
   - The script-visible return stays `undefined`, as today. The outcome comes back later as a ledger entry,
     never as a script value, so broker latency never enters the entry's budget.
3. **Close.**
   - When the entry returns, View casts `{dispatch_done, P}`. That happens before the onchange drain and the
     Promise jobs, per `D6.5-gesture-narrowing`.
   - Both messages travel View → WinBroker, so pairwise FIFO delivers every commit sent during the entry
     before `dispatch_done`. This defines "within the entry" exactly, with no clock involved.
   - A commit that arrives after close is refused.
4. **Commit check.** WinBroker admits the commit only if all of these hold:
   - P exists, is open and is unconsumed;
   - the *observed* sender pid is the one WinBroker registered for (V, I);
   - I is still V's incarnation, the skin is still loaded and the capability is not revoked;
   - the effect is in G and on the host allow-list.

   Then it marks P consumed. One permit admits one G commit, and a second G request in the same entry is
   ledgered as `gesture-consumed`. Unmeasured: how many corpus handlers make two G calls. Count them at
   gate 2.
5. **Attempt.**
   - WinBroker ledgers `{attempt, P, effect}`, makes exactly one monitored `call` to Host, then ledgers
     `{outcome, P, committed | failed(reason)}`.
   - If Host is down or the call times out, the outcome is `unknown-outcome` and the effect is never resent.
     The call timeout bounds how long WinBroker waits. It never extends or re-grants authority, because P is
     already consumed.
   - If WinBroker crashes between attempt and outcome, the ledger shows an attempt with no outcome, which
     reads as unknown. The permit table dies with WinBroker, so later commits are refused. The result is
     at-most-once.
6. **Revocation.**
   - V `DOWN` closes all of V's permits, and so does an incarnation bump.
   - Validity ends on events (dispatch_done, DOWN, incarnation change) and never on a timer.
   - A slow WinBroker commits late but only once. Record mint→commit latency as a metric, not as a validity
     condition.

This meets rev 0.3's bar. The receipt is state held by WinBroker, keyed by an unforgeable ref and checked
against the sender pid WinBroker observes. Nothing caller-supplied is trusted, and no time lease exists.

**Tests:**
- a genuine click closes, as the positive control;
- a synthetic permit is refused;
- a commit after `dispatch_done` is refused;
- a commit from another pid is refused;
- a second G in one entry gets `gesture-consumed`;
- View dies between mint and entry, and its permits are revoked;
- WinBroker is killed mid-attempt: `unknown-outcome`, no resend;
- Host fails: `failed`, no retry;
- the splash corpus skins hand over with no gesture.

## 4. Corrections to review 1 that rev 0.3 inherited

1. **`Math.round` is not floor(x+0.5).** Review 1 defined `px.half-up` and the importer's `Math.round` that
   way, and rev 0.3 repeats it.
   - **Fact.** The engine calls `Math.round` at `animator.js:58`, `slider-geometry.js:66-122`,
     `scene.js:425,505-506`, `render/dom/slider.js:222` and `view-runtime.js:877-878`.
   - ECMA-262 `Math.round` gives the nearest integer, with ties toward +∞. It differs from floor(x+0.5) in
     three cases: 0.49999999999999994 → 0 (floor gives 1); x ∈ [−0.5, 0) → −0 (floor gives +0); and odd
     integers at or above 2^52.
   - **Proposal.** Define `px.half-up` and the importer's `Math.round` as ECMA-262 `Math.round`. Add these
     fixtures:
     - 0.49999999999999994 → 0;
     - −0.25 → −0, then normalised to 0 at the px edge;
     - 4503599627370497 → itself.
   - The last matters because `LayoutNum` is f64.
2. **DPR is a host fact, not a profile cap.** Review 1 proposed `Dpr ∈ {1,2}`, and rev 0.3 adopted it.
   - **Fact.** The engine never reads `devicePixelRatio`; the webview applies it. macOS hosts give 1 or 2.
     Fractional DPRs (1.25, 1.5, 1.75) come from Windows and Linux display scaling.
   - **Proposal.** Dpr = m/4 for m ∈ 4..12 (1.0–3.0), admitted from the host. device = floor(px·n·m/16)
     for paint and hit. ±2^20 × zoom 4 × Dpr 3 = 3·2^22 < 2^24, so f32 stays exact.
   - The oracle's DPR 1 and 2 are fixtures, not a cap. Zoom n/4, n ∈ 1..16, stays as rev 0.3 has it.

## 5. Priority

| Priority | Items |
|---|---|
| Must-fix | §3.1 G membership (open-view out); §2 total bound that counts retired realms; §4.1 `Math.round` definition |
| Should-fix | §3.2 protocol written into §5 as the gate-2 obligation's candidate; §4.2 DPR domain; separate WinBroker from the media broker |
| Gate-2 measurements | F per instance; corpus count of handlers with two G calls; mint→commit latency under a seek/volume backlog |

## Errata (after rev 0.4, `c76ff9e`)

Astra's qualifications to this review are correct. They are recorded in rev 0.4:

1. **Per-view maximum.** The per-view linear maximum is 51 MiB (48·17/16, `realm.js:450-456`). 48 MiB is
   the fault threshold, not the maximum. T keeps its formula; admission counts actual byte length.
2. **No sender authentication.** A BEAM message carries no authenticated sender pid. A cast has no sender
   field at all, and a call's `From` is built by the caller. §3.2 step 4's "observed sender pid" is wrong.
   The boundary is the trusted closed evaluator together with a private permit ref that skin code can never
   read or construct.
3. **Test 2(b).** Raising F and recomputing T always leaves 64 MiB of headroom, so the memory refusal never
   fires before the count cap. The test needs retained bytes (growth or retired realms) or a fixed T.
4. **Revocation ordering.** Pairwise FIFO does not order a third party's revocation against a Host attempt
   already sent. Revocation stops only commits that have not been attempted yet.
5. **Late effects.** A timed-out attempt may still take effect late. The attempt record is written before
   the send, and `unknown-outcome` covers that case.
