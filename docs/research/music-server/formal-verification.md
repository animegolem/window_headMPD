# Formal verification for the music server and its EQ

**Date:** 2026-10-07
**Lane:** WHAT TO FORMALLY VERIFY (music-server research, one of several parallel lanes)
**Reader:** the owner, who verifies user stories rather than reading proofs.

## 0. How to read this

Every line carries one of these tags so you can tell what I know from what I suggest.

| Tag | Meaning |
|---|---|
| **[M]** | Measured by me today. Scratch programs live in `/tmp/msr-formal-verification/` (scratch; may be cleared). The f32 numbers come from a verbatim copy of `src-tauri/src/eq.rs` with only `pub` added, so they are the real code's behaviour. |
| **[C]** | Read directly from the source files (`eq.rs`, `audio.rs`, `lib.rs`, `mpd.conf`). |
| **[D]** | Derived by hand here; the algebra is shown so you or an agent can re-check it. |
| **[n]** | A cited external source, numbered in section 13. If I only saw a search-result summary and could not open the page, the source list says so. |
| **[REC]** | My recommendation. Not a fact. |
| **UNCONFIRMED** | I could not confirm it. Listed again in section 12. |

Effort scale for recommendations, my judgement only: **S** = hours of agent work, **M** = days, **L** = weeks, **XL** = months.

Nothing was modified. MPD was only touched by read-only `mpc version`, `mpc outputs`, `mpc status`. [M]

## 1. Bottom line

1. **You can EQ your headphones now without waiting for proofs.** The safe way is a *checker at load time*, not a proof: when a profile is loaded, the control side computes the filter numbers in double precision, checks stability with a margin, computes the true peak gain of the whole cascade, sets the preamp from that, and refuses a profile it cannot vouch for. Proofs later shrink to "the checker is right". [REC]
2. **The current ten-band EQ does not meet the clipping story.** Its preamp (`-0.6 x largest boost`) is a taste rule backed by a soft clipper. With every band at +14 dB the cascade's real peak is **+21.9 dB**, the preamp removes 8.4 dB, and **+13.5 dB** of overshoot is left for the soft clipper to catch. [M][C]
3. **"A full-scale sine never clips" and "nothing ever clips" are different promises with different numbers.** The first is the peak of the frequency response. The second is the sum of the absolute impulse response (the "worst-case peak gain"). For the all-+14 case they differ by **8.9 dB**; on 2000 synthetic headphone-style profiles the median gap is **4.5 dB**. [M] The first is cheap and standard; the second is the real guarantee and is what Hilaire's group computes with rigour. [2]
4. **The stability story is a one-line theorem.** The standard peaking filter is stable for every centre frequency strictly between 0 and half the sample rate, every positive Q and every gain. [D] That is cheap to prove and cheap to keep true forever. What costs money is round-off, not stability.
5. **Round-off is the expensive, real risk, and it grows with sample rate.** On the real f32 code a 31 Hz band's centre gain is off by 0.003 dB at 44.1 kHz, 0.014 dB at 96 kHz and **0.40 dB at 192 kHz**. [M] Today the app always runs its EQ at 44.1 kHz [C], so this bites only the future native-rate server. The cheap fix is double precision for the EQ; proving f32 is possible but is thesis-grade work. [3][4]
6. **Moving a slider clicks, measurably.** With the current filter structure, a +1 dB step on a band far from the music's frequency produces a transient about 4 to 6 percent of the signal's size (about -26 dB); a 0 to +14 dB jump (profile load, reset) produces one as large as the signal itself in the worst phase. A different structure with the same settled sound (a state-variable filter) cuts those two far-from-band cases to about 0.1 percent and 3 percent. When the tone sits on the band being changed, part of the change is physical (the resonance has to build up) and no structure removes it. [M] I would make "no click" a tested story, not a proved one. [REC]
7. **Two state machines deserve TLA+, and MPD gives no written spec to copy.** The queue/gapless hand-off is one; the audio ring's prime/underrun/drop logic is the other. MPD's protocol document is silent on prefetch, gapless mechanics and queue edits during playback. [32] The model therefore has to be learned from experiments against a sandbox MPD and then used as the spec for our server. [REC]
8. **Prover choice for the numbers: Rocq (the new name for Coq) now.** It has the mature floating-point libraries and the strongest filter prior art (Gallois-Wong, Boldo and Hilaire in Coq; older work in HOL). [3][5][9][10][11] Lean 4 is better for pure maths but its floating-point library is pre-1.0 [13] and **Lean is not usable on this machine today** (`lean` is an `elan` stub with no toolchain configured). [M]
9. **Bend 2 should not carry any of this.** Its own README says "F32 is axiomatic: nothing about floating point can be proven", it has no F64 and no reals, and its compiler is "99% AI-written and not yet fully audited". [34] That agrees with the house ruling of 2026-09-26: keep Bend out of the signal path. [35]
10. **Never write the word "verified" without a rung.** Section 2 defines six rungs. The ledger in section 4.1 says which rung each story has now and which is reachable.

## 2. What "verified" can honestly mean

A claim like "the EQ never clips" is true or false about *a thing*, and there are many things between the idea and your ears:

```
the maths  ->  the algorithm  ->  the source code  ->  the compiler  ->  the CPU  ->  the OS audio stack  ->  the DAC
```

A proof of the maths says nothing about the C. A proof about the C says nothing about the compiler's floating-point choices. So each story gets a **rung**:

| Rung | Name | Meaning in plain words |
|---|---|---|
| E0 | Untested | Nobody has checked. |
| E1 | Example tests | A few inputs behave. |
| E2 | Exhaustive or swept | Every input in a stated, finite domain was run (all 4.3 billion f32 values for a one-input function; a dense grid for a many-input one). Fast, convincing, and *not* a proof outside the domain. |
| E3 | Proven in exact maths | A machine-checked proof about real numbers. The code might still differ. |
| E4 | Proven including rounding | The proof covers the floating-point arithmetic the code really uses, with stated error bounds. |
| E5 | Carried to the binary | The proof reaches machine code through a verified compiler, or the compiler's output is checked against the proof. |

[REC] Adopt this vocabulary. It makes "formally verified" a checkable statement and stops the project from overclaiming. It also matches how the prior art is organised: Gallois-Wong, Boldo and Hilaire separate the exact-arithmetic theorems from the finite-precision error theorems. [3][4]

One structural point matters for the "own language" plan: **the user stories are the durable asset; proofs are replaceable.** If the EQ is later re-implemented in Orgiac, the story statements and the golden test vectors carry over unchanged, and the proofs are redone or re-checked. [REC]

## 3. What is true of `eq.rs` today (the baseline)

| Fact | Tag |
|---|---|
| Ten RBJ-cookbook peaking biquads in series per channel, centres 31 to 16000 Hz, **fixed Q 1.41**, gains clamped to +-14 dB, all arithmetic in f32, transposed direct form II, state carried across coefficient changes. | [C] |
| The EQ runs at a fixed 44.1 kHz (`IN_RATE`) *before* the resampler to the device rate. | [C] |
| Preamp = `10^(-0.6 x largest positive gain / 20)`. A unit test's own comment says +12 dB nets +4.8 dB. | [C] |
| `process()` applies `soft_clip` whenever the EQ is not "flat" (all gains under 0.05 dB), **including cut-only settings**. The clipper is linear up to 0.7 (about -3.1 dBFS) and tanh-shaped above. | [C] |
| The cubic (Catmull-Rom) resampler comes *after* the clipper. | [C] |
| The audio callback locks `engine.ring` and `engine.eq`; the UI's `set_eq` locks the same `engine.eq` and recomputes ten sets of sin/cos/powf under the lock. | [C] `audio.rs:297,310`, `lib.rs:129` |
| Input is 16-bit PCM from MPD's FIFO scaled by 1/32768, so NaN cannot arrive today. | [C] |
| The drift-correcting resampler changes its ratio by up to 0.2 percent continuously, so output is never a bit-exact copy of input even with the EQ off. | [C] `audio.rs:308-309` |
| MPD here is 0.24.0; output "Headspace" (the FIFO the app reads) is currently **disabled**, "OS X Output" is enabled, volume 97 percent. | [M] `mpc` |

## 4. The EQ stories

### 4.1 The ledger

| ID | Story (what the owner would check) | Today | Best reachable | Tool | Effort |
|---|---|---|---|---|---|
| S1 | The gain I set is the gain I get at the band's centre. | E2-ish, f32 error 0.003 to 0.4 dB depending on rate [M] | E3 now; E4 with f64 | Rocq or Lean for the algebra; Gappa/VCFloat2 for rounding | S (E3) / M (E4) |
| S2 | The EQ never goes unstable, at any setting or sample rate. | E0 | E3, plus E4 margin check | Hand algebra, then Rocq/Lean; interval check of rounded coefficients | S |
| S3 | A flat setting leaves DC and Nyquist alone; EQ-off is bit-exact when rates match. | Filters yes [D]; bit-exact **no** [C] | E3 (filter) + E2 (path) | Algebra; golden-vector test | S |
| S4 | Boost then the exact opposite cut returns my original sound; band order does not change the result. | E0 | E3 (exact), E2 (float order effects) | Algebra | S |
| S5 | A band means the same width and shape at 44.1, 96 and 192 kHz. | **False** at high bands [M] | E3 against a chosen target | Orfanidis / Vicanek designs; algebra plus interval bounds | M |
| S6a | A full-scale sine at any frequency never makes the EQ clip. | **False** for most boost settings [M] | E3 with certified peak search; E4 later | Interval branch-and-bound in Rocq (CoqInterval) or checker + Frama-C | M |
| S6b | No input of any kind (any music, any glitch) can push the EQ output past full scale. | False [M] | E3 with certified l1 bound | Worst-case-peak-gain method [2][3] | M to L |
| S6c | The final output never exceeds full scale, whatever else happens. | Soft clipper bounded at 1.0 (**E2, all f32**) but the resampler after it can overshoot 1.25x [M] | E2 now, E3 with the clamp moved last | Exhaustive f32 check (done) | S |
| S7 | If I only cut, the EQ leaves my loud passages untouched. | **False** above -3.1 dBFS [M] | E2 | Design change plus test | S |
| S8 | The EQ adds no audible noise or distortion of its own. | -110 dBFS at 44.1 kHz, -91 at 192 kHz [M] | E4 via f64 (cheap) or E4 via error-filter theory (hard) | Boldo/Gallois-Wong/Hilaire [3][4] | M (f64) / XL (f32) |
| S9 | When the music stops the EQ goes quiet and stays quiet; one bad sample never kills a channel. | Denormal limit cycle forever; NaN is permanent [M] | E2 | Design change plus test | S |
| S10 | Moving a slider does not click. | Clicks, 4 to 100 percent of signal [M] | E2 with a structure change | State-variable filter plus ramps | M |
| S11 | The same file with the same settings gives the same bits on every machine and every build. | E0 | E2 (golden vectors) | Compiler flag pins [19] | S |
| S12 | The audio thread never waits for the UI. | **False** (shared mutex) [C] | E2 | RealtimeSanitizer, lock-free hand-off [33] | M |

### 4.2 Each story in detail

**S1. The gain I set is the gain I get at the centre.**
*Math:* the cookbook's analog prototype is `H(s) = (s^2 + s(A/Q) + 1) / (s^2 + s/(AQ) + 1)` with `A = 10^(dB/40)`, digitised by the bilinear transform, with the centre frequency prewarped so analog 1 rad/s lands exactly on the digital centre. [1] At the centre the analog gain is `A^2 = 10^(dB/20)`.
*Exact status [D]:* multiply numerator and denominator of the digital form by `z` at `z = e^(j w0)`. The numerator becomes `(z + 1/z) - 2cos w0 + alpha*A*(z - 1/z) = alpha*A*2j*sin w0`; the denominator becomes `(alpha/A)*2j*sin w0`. The ratio is exactly `A^2`. The `a0` normalisation cancels. This is a three-line proof; an agent can machine-check it in an hour.
*Measured [M]:* the f64 formulas reproduce the requested centre gain to 7e-12 dB over 160 cases. With the **f32 coefficients the real code produces**, the worst centre-gain error is 0.0034 dB (44.1 kHz), 0.0013 (48 k), 0.014 (96 k), **0.40 dB (192 k)**, always the 31 Hz band; every other band is under 0.0002 dB at 44.1 kHz.
*Why it grows:* at 31 Hz the poles sit 7.0e-4 from the unit circle at 44.1 kHz and 1.6e-4 at 192 kHz, and f32 can only place coefficients on a grid about 6e-8 apart near 1. The centre gain is a ratio of two tiny differences of near-1 numbers, so rounding is amplified. [M]
*Float status:* coefficient computation uses `powf`, `sin`, `cos`. The tools I checked are weak on those: Kani over-approximates them [14], Lean treats trigonometric functions as opaque [12], Gappa handles straight-line code only [16]. The standard way out is to compute coefficients in f64 or interval arithmetic and verify only the per-sample recurrence in the target precision. [REC] I did not find a source that states this as a recipe; it follows from the tool limits above.

**S2. The EQ never goes unstable.**
*Math:* a section `1 + a1 z^-1 + a2 z^-2` has both poles inside the unit circle exactly when `|a2| < 1` and `|a1| < 1 + a2` (the Jury triangle).
*Exact status [D]:* with `a0' = 1 + alpha/A`, the cookbook gives `a2 = (1 - alpha/A)/a0'` and `a1 = -2cos w0 / a0'`. Then `1 + a2 = 2/a0'` and `|a1| = 2|cos w0|/a0'`. So `|a1| < 1 + a2` is just `|cos w0| < 1`, true for every centre strictly between 0 and half the sample rate. And `|a2| < 1` is `alpha/A > 0`, true for every positive Q and gain. **Every admissible setting is stable. No exceptions.** I confirmed the identities to 2e-16 and swept 3000 frequencies x 60 Qs x 41 gains (-40..+40 dB); the smallest triangle margins were 2e-8 and 1e-10, at the extreme edges of the sweep. [M]
*Float status:* the question is whether the *rounded* coefficients still satisfy the triangle. For the 31 Hz +14 dB band the pole-to-circle distance is 11,700 f32 grid steps at 44.1 kHz and 2,700 at 192 kHz, so rounding cannot flip stability there. [M] At 20 Hz it is still 1,700 steps at 192 kHz. [M] A runtime check is trivially cheap: compute the pole distance from the unit circle (1 minus the larger pole radius) and refuse below a floor such as 1e-5 (about 170 f32 grid steps; 20 Hz at 192 kHz sits at 1e-4 [M]). Judge by pole distance, not by the second triangle margin: that margin shrinks like the square of the centre frequency in radians (about 4e-7 for 20 Hz at 192 kHz) while the pole distance shrinks only linearly, so a fixed floor on the margin would wrongly refuse legitimate low bands. [D][REC]
*Not covered:* a time-varying filter can be unstable even when every frozen setting is stable (a standard control-theory fact; I fetched no source for it). Proving that for slider motion needs a shared energy-like function (a common Lyapunov function); I did not find a source that does this for a peaking filter. UNCONFIRMED whether one exists for the state-variable form. See S10.

**S3. A flat setting leaves DC and Nyquist alone; EQ-off is bit-exact.**
*Exact status [D]:* at `z = 1` and `z = -1` the cookbook's numerator and denominator collapse to the same value (`2 -+ 2cos w0`), so every peaking section has exactly 0 dB at DC and at half the sample rate. Measured to 2e-15 dB. [M] (Consequence: this design cannot boost the very top of the spectrum, which matters for S5.)
*Bit-exact bypass:* **not true today** [C]. Even with all gains zero the drift-correcting cubic resampler touches every sample. A "bit-perfect" story needs a design decision: when MPD's rate equals the device rate and the EQ is flat, skip both stages. That is a code-path fact, testable by comparing output bytes to input bytes; no theorem needed. [REC]

**S4. Cascade is the product; boost-then-cut cancels; order does not matter.**
*Exact status:* the response of a series connection is the product of the sections' responses (convolution becomes multiplication); trivial in Rocq or Lean. [D] Because the cookbook's `A -> 1/A` swaps numerator and denominator polynomials, a cut at `-g` with the same centre and Q is exactly the **inverse** of the boost at `+g`. That is the property headphone correction relies on: a correction built as the inverse of a measured peak cancels it. [D]
*Float status:* the product law only holds approximately, and section order changes rounding and which intermediate value is largest. Test with golden vectors rather than proving. [REC]

**S5. A band means the same at every sample rate.**
*Measured [M]:* the octave width between half-gain points for a +12 dB band at Q 1.41:

| centre | rate | measured width | cookbook bandwidth formula | analog prototype |
|---|---|---|---|---|
| 1 kHz | 44.1 k | 0.999 oct | 1.000 | 1.003 |
| 8 kHz | 44.1 k | 0.794 | 0.799 | 1.003 |
| **16 kHz** | **44.1 k** | **0.339** | 0.334 | 1.003 |
| 19 kHz | 44.1 k | 0.160 | 0.156 | 1.003 |
| 16 kHz | 96 k | 0.823 | 0.829 | 1.003 |
| 16 kHz | 192 k | 0.955 | 0.958 | 1.003 |

So the 16 kHz band is a third of an octave wide at 44.1 kHz and almost a full octave at 192 kHz, with the same slider setting. This is the standard "cramping" of the bilinear transform; the cookbook warps the *centre* exactly and offers a bandwidth readjustment that is within about 2 percent here. [1][M] The Q-form used in `eq.rs` keeps the analog Q, so the digital band shrinks near the top. [C]
*What "same" should mean is the owner's call.* Three defensible targets: (a) match the analog bell's response at all frequencies (Vicanek's matched design [22]); (b) pin the gain at the top of the spectrum to the analog value instead of 0 dB (Orfanidis [21]); (c) hold the octave width (cookbook BW form). Equalizer APO accepts both Q and bandwidth forms in profiles [25]; **how it treats the top of the spectrum is UNCONFIRMED** and decides what an imported AutoEq profile "means" at 44.1 versus 96 kHz.
*Reach:* once a target is chosen, proving the filter meets it within X dB is an interval-arithmetic proof over a one-dimensional frequency range. [REC]

**S6. The EQ never clips.** This story splits into three promises, because the numbers differ.

*S6a, any full-scale sine.* Needs the peak of `|H(e^(jw))|` over all frequencies, for the whole cascade. [M] with the app's own ten bands at fs 44.1 kHz, all at the same gain g:

| g (dB) | true cascade peak (all at 500 Hz) | app preamp | net peak left after preamp |
|---|---|---|---|
| 1 | +1.45 dB | -0.60 | +0.85 |
| 3 | +4.37 | -1.80 | +2.57 |
| 6 | +8.84 | -3.60 | +5.24 |
| 9 | +13.50 | -5.40 | +8.10 |
| 12 | +18.42 | -7.20 | +11.22 |
| 14 | **+21.90** | **-8.40** | **+13.50** |

Because each section's response in dB is increasing in its own gain at every frequency [D: numerator term `Omega^2 A^2/Q^2` rises with A, denominator term `Omega^2/(A^2 Q^2)` falls; also confirmed on a 4001-point grid, [M]], the uniform setting is the worst case for any given largest boost. So the app's preamp rule leaves a positive net peak for any setting whose boosts are not offset by nearby cuts, and it is worst when all bands are lifted.
*Synthetic headphone-style profiles [M]:* 2000 random sets of ten peaking filters at 48 kHz (frequency 20 to 16000 Hz, Q 0.4 to 6, gains -12 to +8 dB; **not real headphone data**): the true peak exceeds the largest single boost by more than 1 dB in 32.8 percent of profiles (99th percentile +9 dB), and the app's rule would leave a positive net peak in 83.6 percent. The share on real AutoEq profiles is UNMEASURED.
*Standard practice, for context:* Equalizer APO tells you to write a negative `Preamp:` line [25]; AutoEq sets the preamp to minus the largest gain of the compound filter (`Preamp: {-compound.max_gain}` in its source, per a fetch summary of `frequency_response.py`; I did not read the file line by line). [26] That is the sine-safe promise.
*Why a finite grid is not a proof [M]:* a scan on 1024 linear points under-reports the true peak by up to 5.8 dB (99th percentile 3.5 dB); 256 points by up to 17 dB; even a 1/24-octave log grid from 20 Hz to 20 kHz misses up to 1.3 dB. A certified bound needs branch-and-bound or analytic slack. [M]
*How to prove it [D][REC]:* for a cascade of N biquads, `|H|^2` is a ratio of two polynomials of degree 2N in `x = cos w` on `[-1, 1]`. Maximising a rational function of one variable on an interval is exactly what interval-arithmetic bisection (CoqInterval in Rocq) or an exact root-isolation method certifies. Cost M.

*S6b, no input of any kind.* For any signal with `|x| <= 1`, the output satisfies `|y| <= sum_k |h[k]|`, and some +-1 input achieves it. This is the worst-case peak gain (WCPG). Volkova, Hilaire and Lauter compute it with controlled precision and give a formula for how many terms of the infinite sum are needed for a chosen error. [2] Gallois-Wong, Boldo and Hilaire proved the WCPG theorem in Coq. [3]
*Measured [M]:* all ten bands at +14 dB, no preamp: peak of `|H|` = 12.44 (+21.9 dB), sum of `|h|` = **34.63 (+30.8 dB)**. I built the +-1 input from the impulse response and ran it through the filter: the output reached **34.625**, equal to the sum, so the bound is tight, not just an inequality. With the app's -8.4 dB preamp that input reaches **+22.4 dB** over full scale versus +13.5 dB for the worst sine. Gap between the two promises: 4.5 dB (3 dB boosts, median synthetic), 8.9 dB (all +14). On the 2000 synthetic profiles the gap is median 4.5, 90th percentile 6.4, maximum 9.0 dB.
*What that means for design:* an "absolutely never clips" preamp costs roughly 4 to 9 dB more headroom than the sine-safe one. Real music sits between the two. [REC] Offer both promises by name, default to sine-safe, and back it with the proven-bounded limiter in S6c so the output guarantee does not depend on the music being polite.
*Cost:* M to L. The Coq results are for general filters in state-space and direct forms [3]; adapting to a cascade of biquads with a geometric tail bound from the largest pole radius is an engineering port, not new research. [REC]

*S6c, the final output never exceeds full scale.* The existing soft clipper is `0.7 + 0.3 tanh((|x| - 0.7)/0.3)` above 0.7. I ran **every** non-negative finite f32 (2,139,095,040 inputs, 5.5 s on this machine) and their negatives: output never exceeds 1.0, never decreases as input grows, and is exactly odd. Infinity maps to 1.0; NaN maps to NaN. [M] That is a genuine E2 result for a one-input function, equivalent to a proof for this arithmetic. At 0.7 the slope is exactly 1 (tanh'(0) = 1), so it joins the linear part smoothly. [D]
*But the bound is not final:* the Catmull-Rom resampler runs after the clipper, and for inputs bounded by 1 it can output up to **1.25** (+1.94 dB) with sample pattern (-1, +1, +1, -1) at the midpoint. [M] Rarely reached by music; real in principle. Fix: clamp last, or make the clipper the final stage. [REC] Separately, inter-sample peaks after the DAC can exceed sample peaks; how CoreAudio float output handles values above 1.0 is UNCONFIRMED here.

**S7. If I only cut, my loud passages are untouched.**
*Measured [M]:* EQ with a single -14 dB cut at 1 kHz, a 100 Hz sine:

| input level | fundamental change | harmonic distortion (2nd to 9th) |
|---|---|---|
| -26 dBFS | -0.105 dB | -132 dB (f32 floor) |
| -6 dBFS | -0.105 | -135 dB |
| -3.1 dBFS | -0.105 | -132 dB |
| -1.0 dBFS | -0.176 | **-41.6 dB (0.83 %)** |
| -0.09 dBFS | -0.346 | **-32.4 dB (2.4 %)** |

The -0.105 dB is the cut's skirt at 100 Hz. Everything above it is the soft clipper acting on a signal the EQ only made quieter. Modern masters peak above -1 dBFS routinely, so "cut-only is transparent" is false today. [M][C] Fix: engage the clipper only when the checker says boost headroom is needed, or never (see S6c). [REC]

**S8. The EQ adds no audible noise or distortion of its own.**
*Measured [M]:* 4 seconds of white noise at +-0.02 (-35 dBFS rms) through the real f32 code, compared with an f64 run using the identical f32 coefficients. Error rms in dBFS:

| rate | all +14 | 3 bass bands +14 | 31 Hz only +6 | all -14 |
|---|---|---|---|---|
| 44.1 k | -109.8 | -110.7 | -112.5 | -115.2 |
| 96 k | -99.9 | -100.7 | -103.3 | -104.7 |
| 192 k | -91.1 | -92.0 | -93.9 | -96.2 |

For scale, 16-bit quantisation noise is about -101 dBFS rms and 24-bit about -149. So at 44.1 kHz the EQ's added error sits 9 to 14 dB below 16-bit noise; at 192 kHz it is above it. The error shape (whether it piles up in the bass) was not analysed; level depends on the signal. [M]
*How to make it provable:* two routes. **Cheap:** hold coefficients and state in f64. The format has 29 more bits; the sample-rate scaling above stops mattering, and the CPU cost is negligible (the 20-biquad stereo f32 chain took 25 ns per sample here, about 0.1 percent of one core at 44.1 kHz). [M] The remaining proof is "no catastrophic case", not a tight bound. **Thorough:** the Gallois-Wong, Boldo, Hilaire theory proves the difference between the ideal filter and the rounded implementation is itself a filter whose size is bounded through the WCPG, for direct forms and state-space realisations. [3][4] The tool route for a straight-line part is Gappa, FPTaylor or Daisy [7][8][6] with certificates checked in Rocq (VCFloat2) [9] or in Rocq and HOL4 (FloVer, which checks Daisy-produced certificates but supports straight-line kernels only [6]). An unbounded recursion needs the filter-level theory, not a straight-line tool. HOL has older filter work: Akbarpour and Tahar, "Error analysis of digital filters using HOL theorem proving", J. Applied Logic 5(4), 2007 [5] (seen as a listing, not opened). Cost: M (f64), XL (f32 proof).

**S9. When the music stops the EQ goes quiet; one bad sample never kills a channel.**
*Measured [M], real f32 code:* feed loud noise, then **60 seconds of digital silence**. At 44.1, 96 and 192 kHz, with all +14, all -14 and bass-only, the output **never returns to exact zero**: all ten sections end the minute holding denormal-range values (outputs between 1e-40 and 1e-44, at or below -800 dBFS, inaudible), and 92 to 99 percent of the output samples are denormal numbers (for example 2,527,700 of 2,646,000 at 44.1 kHz all +14).
*Does it cost CPU? [M]* On this machine, one test: the process starts with the floating-point control register at 0x0 (flush-to-zero **off**), and 20 million samples with denormal filter state took 20.0 ns per sample versus 25.1 ns for normal signal, i.e. **no penalty measured** (the silence run also skipped the noise generator the normal run used, so do not read a speed-up into the difference). That is one benchmark on one chip; Apple's and Arm's own statements on denormal cost were not found. [20] UNCONFIRMED in general. The standard mitigations (a tiny alternating offset, or clearing state after long silence) are well known; I did not find a primary source I could cite for them here.
*NaN [M]:* one NaN sample in the left channel makes the left output NaN for the next million samples, **and again after switching the EQ to flat and back**, because the filter state is never cleared; the right channel is unaffected. Unreachable today (16-bit input), reachable the day a float decoder or a bug feeds NaN.
*How to prove or test [REC]:* "after N consecutive exact-zero inputs the state is exactly zero" becomes trivially true if the code clears state at N, and a test confirms it. "A non-finite sample is replaced at the input" is one comparison. Both E2, effort S.

**S10. Moving a slider does not click.**
*Why it matters:* `set_gains` swaps all coefficients in one step while the filter's memory carries over from the old ones, and `pre` jumps instantly. [C]
*Measured [M, f64, linear model, my experiment]:* largest deviation after the switch from the output the new setting would have given all along, relative to the larger steady-state amplitude, over 24 switch phases (median / worst):

| change | current structure (transposed direct form II) | state-variable filter (TPT form) |
|---|---|---|
| 1 kHz band 0 to +14 dB, 100 Hz tone (far from band: all click) | 0.71 / **1.00** | 0.028 / 0.039 |
| 1 kHz band +14 to 0 dB, 100 Hz tone (far from band) | 0.58 / 0.82 | 0.000 / 0.000 (at 0 dB the bell passes the input straight through) |
| 31 Hz band 0 to +14 dB, 40 Hz tone (near band: part physical) | 0.57 / 0.76 | 0.26 / 0.34 |
| 1 kHz band 6 to 7 dB, 100 Hz tone (far from band) | 0.045 / 0.064 | 0.0008 / 0.0012 |
| 1 kHz band 0 to 1 dB, 100 Hz tone (far from band) | 0.037 / 0.053 | 0.0001 / 0.0002 |

A 1.0 means the transient is as large as the music. Both structures have the **identical sound** once settled; I checked their steady-state outputs agree to 1.6e-15. [M] The state-variable ("topology-preserving") form keeps its memory in quantities that stay meaningful when the cutoff or gain changes, which is why Zavalishin's book recommends it for modulated filters. [23][24] I checked the bell mix `out = x + (A^2 - 1) * k * v1` with `k = 1/(Q*A)` numerically; the pages of the Cytomic paper I could read do not reach the peak formula. [24][M]
*Story form [REC]:* "dragging a slider changes the output by no more than X percent of the signal per step" and "profile load or reset fades in over Y ms". Both are measurable E2 tests. A proof for time-varying filters is research; do not promise it.

**S11. Same bits everywhere.**
*Risk [19]:* clang's default is `-ffp-contract=on`, which fuses a multiply and add *within one statement* into a single fused instruction with different rounding; Apple's CPUs have fused multiply-add. `-ffast-math` additionally allows re-association and assumes no NaN or infinity. A proof about the rounding of separate operations stops describing the binary. [REC] Pin `-ffp-contract=off`, never use `-ffast-math`, and store golden output vectors from the reference build. Rust does not fuse automatically (UNCONFIRMED here; I did not check Rust's documentation). CompCert's FMA behaviour is UNCONFIRMED (not in its release notes as fetched). [17]

**S12. The audio thread never waits for the UI.**
*Fact [C]:* the callback takes `engine.ring` and `engine.eq` locks; slider moves take the `eq` lock and do ten trig computations inside it. This is a real-time safety issue rather than EQ maths, noted here because it decides how a proof of "the callback always finishes in time" could even be stated. Tools: LLVM's RealtimeSanitizer flags `malloc`, mutex locks and other unbounded calls in functions marked `[[clang::nonblocking]]`, for C and C++ [33]; this is a *dynamic* check (E2), and a formal worst-case execution-time proof on Apple Silicon is not realistic. [REC] The usual design fix is that the control side builds the whole coefficient set and hands it over by atomic pointer swap, which also pairs with the load-time checker in section 10.

## 5. Player and queue stories (TLA+)

TLA+ is a language for writing the rules of a system as a small mathematical model and a model checker (TLC) that tries every reachable situation within bounds. It found "subtle bugs that would not have been found by other means" in Amazon's systems. [27] It is the right tool for the player because the bugs here are about *order of events*, not arithmetic.

**What MPD does and does not say.** The protocol document defines `state`, `song`, `nextsong`, `consume` (0, 1, oneshot), `single` (0, 1, oneshot), `repeat`, `random`, and says `playlist` is a version number that increments when the queue changes. It does **not** document gapless mechanics, prefetching, or what happens when the queue is edited or the current song deleted during playback. [32] MPD's behaviour on those is therefore a thing to *discover*, not read.

**Model A: queue and gapless hand-off** [REC]. State: queue, current index, play state, flags, shuffle order, the prefetched next track, and the stream of output events. Actions: add, delete, move, clear, play, pause, resume, stop, next, previous, seek, end-of-track, hand-off, decode error. Stories to check:

| ID | Story | Kind |
|---|---|---|
| P1 | Gapless: between the last sample of one track and the first of the next, nothing is inserted and nothing overlaps (unless I asked for crossfade). | Safety |
| P2 | The "next" track is decided once and agrees with what actually plays, even if I edit the queue while it is being prepared. | Safety |
| P3 | Random plays every track once before repeating; consume removes each played track exactly once; single stops or repeats exactly as the flag says. | Safety |
| P4 | Deleting or moving the current or next track, clearing the queue, or seeking at the instant of hand-off never leaves the player in an impossible state. | Safety |
| P5 | Every Play ends in sound or a visible error; a decode failure of the next track never hangs the current one. | Liveness |
| P6 | Pause, resume and stop never replay stale audio or lose position. | Safety |

A queue of 3 to 4 tracks with all flags is well inside what TLC handles; state spaces for this size are typically small (my estimate, not measured). TLA+ has a newer front end, Quint, with the same logic, types, and a simulator and Apalache-based checker [29]. Pick one; Quint is friendlier to an agent that writes TypeScript-like code. [REC]

**Closing the gap to reality.** A model is only as good as its match to the thing. Cirstea, Kuppe, Loillier and Merz show how to record execution traces of a real program and check them against its TLA+ specification using TLC, finding discrepancies in all their case studies. [28] [REC] Apply it twice: first to a **sandbox MPD with a test library** (never your live one) to learn MPD's real behaviour, then to the new server's own traces. Not run in this lane.

**Model B: the audio ring.** Small, worth doing exactly because it is small. Variables: ring fill, primed flag, writer bursts, callback demand. Properties: fill never exceeds `MAX_FRAMES` plus one burst; after an underrun the engine re-primes before playing again (no stale audio); drops happen only when fill exceeds `MAX_FRAMES` and leave exactly `TARGET_FRAMES`. [C] `audio.rs:234-241,289-320` The same logic can also be covered by property tests; TLA+ adds the interleavings.

**Model C: the BEAM edge.** The owner's plan puts the systems layer in Elixir with typed actor edges. Candidates: the TLA+ model as the protocol spec; Concuerror, a stateless model checker that systematically explores process interleavings of Erlang programs [31]; PropEr, which supports stateful property testing against a model [31]. If the core stays Rust, Stateright checks actor code inside the checker and can run the same actors on a real network [30]. [REC]

## 6. Library stories (what you hear is what is stored)

Two cheap guarantees come from formats rather than proofs.

- **"My stored FLAC decodes to exactly the audio it was encoded from."** FLAC's STREAMINFO carries an MD5 checksum of the unencoded interleaved samples, and every frame has a CRC-8 on the header and CRC-16 on the whole frame; an MD5 of 0 means "not known". [36] A decoder that checks the MD5 at the end of each file gives an E2 integrity story for every FLAC for free.
- **"Nothing in my library is silently altered."** The plan's content-addressed blobs make every read self-verifying by hash. [REC] This is the same check as the house's record verifier idea, which the 2026-09-26 ruling already flagged as Bend-shaped (parallel hash checking). [35]

## 7. Prior art and tools

| Tool or work | What it does | Fit here | Maturity or caveat |
|---|---|---|---|
| **Rocq (Coq)** with **Flocq** | Machine-checked proofs including IEEE floating point (Boldo and Melquiond's library and book [10]). Coq was renamed Rocq; 9.0 released 2025-03-12 with a compatibility layer. [11] | Primary for numerics. | Mature. Coquelicot (real analysis) and CoqInterval (interval arithmetic) were named in the brief; I could not open their pages (blocked). UNCONFIRMED here. |
| **Gallois-Wong, Boldo, Hilaire** | In Coq: WCPG theorem, existence of the "error filter" between ideal and implemented filter, equivalence of direct forms and state-space. CICM 2018. [3] Her thesis (Paris-Saclay, 2021) extends it to finite precision. [4] | The prior art for S6b and S8. | Abstract fetched; full text and thesis not opened (access-control page). The 2018 abstract does not mention floating-point rounding. |
| **Volkova, Hilaire, Lauter** | Reliable multiprecision evaluation of the WCPG (ARITH 2015). [2] | S6b engine. | Listing and abstract via search; paper not opened. |
| **HOL**: Akbarpour and Tahar; FloVer | HOL error analysis of filters (J. Applied Logic 2007) [5]; FloVer is a certificate checker verified in both Coq and HOL4, takes Daisy's certificates, covers straight-line kernels. [6] | Back-up prover family; fits straight-line parts only. | JAL paper seen as a listing only. The FMCAD 2004 paper I opened is about FFTs. |
| **Gappa**, **FPTaylor**, **Daisy** | Rigorous round-off bounds; Gappa on straight-line code with Coq-checkable proofs [7]; FPTaylor via symbolic Taylor expansions and global optimisation; Daisy computes relative bounds, certificates checkable by FloVer. [6][8] | S1 and per-sample recurrence of S8. | All weak on sin/cos/pow; verify the recurrence only. Search-summary-level comparison [8]. |
| **VCFloat2** (Appel, Kellison; CPP 2024) | Round-off error analysis of floating-point C programs inside Rocq, with transparent certificates. [9] | E4 for C code. | Listing and abstract only. |
| **Frama-C** (WP, Eva) | Deductive verification of C against ACSL annotations, with Gappa and Coq/SMT back-ends. [16] A 2024 talk from CEA, EDF and IRSN on filters says abstract-interpretation domains for filters are not yet mature in Frama-C, and describes the working approach: compute the invariant outside, import it as an ACSL annotation, check it inside with Eva or WP. [16] | S1, S2, S6 on the C. That "certificate then check" pattern is the one I recommend. | First six slides read. |
| **CBMC** | Bounded model checker for C with a bit-precise floating-point decision procedure. [15] | Fast bounded checks (S2 margin, S9 clearing). | Bounded; transcendentals expensive. Search-summary level. |
| **Kani** (Rust) | CBMC-backed bounded checker for Rust. Its docs mark `sinf32`, `cosf32`, `powf32`, `expf32`, `sqrtf32`, `fmaf32` as *partially* supported with over-approximated results. [14] | Checks on today's `eq.rs` recurrence and `soft_clip`. | Float transcendentals unusable for exact claims. |
| **CompCert** | Verified C compiler; AArch64/macOS port added in 3.9 (dated 2021 in one release listing, 2020 in a fetch summary); latest release I saw: 3.18, 2024-08-30. [17] | E5 for a C DSP kernel on this Mac. | Whether a newer release exists, its licence terms, and its FMA handling are UNCONFIRMED. |
| **Vélus** | Formally verified compiler from Lustre (synchronous dataflow) to C using CompCert; proves the generated code implements the stream semantics. PLDI 2017. [18] | The closest existing precedent for "stream program to verified C", relevant to Orgiac. | Research compiler. |
| **Lean 4 / mathlib** | Strong in real and complex analysis. Lean's `Float` is IEEE binary64 with a logical model for + - * / sqrt, but "trigonometric functions are represented as opaque functions in Lean's logic". [12] **FloatSpec** is a Flocq port, version 0.7.0, with the error-bound layer described as a scaffold. [13] I found no digital-filter or Jury-criterion development in mathlib (search; UNCONFIRMED as absence). | Fine for S1, S2, S4 algebra. Not yet for S8. | **Not runnable on this machine today:** `lean --version` fails with "no default toolchain configured". [M] |
| **TLA+ / TLC, Quint, Stateright, Concuerror, PropEr** | Section 5. [27][28][29][30][31] | P1 to P6. | Mature (TLA+); the rest as described. |
| **Bend 2** | Section 8. [34] | Not in the signal path. | Two days old at the time of the sources. |
| **RealtimeSanitizer** | Runtime detector of blocking calls in marked real-time functions. [33] | S12. | Dynamic; not a proof. |
| **Equalizer APO**, **AutoEq** | Real-world definition of "parametric EQ with a preamp": `Filter n: ON PK Fc .. Hz Gain .. dB Q ..` lines and `Preamp: -x dB`. [25][26] | The interface a headphone-profile importer must read. | Internal filter implementation not documented on the page I read. |

## 8. What role can Bend play?

Facts from the project's own README and a launch-week write-up. [34]

- Bend 2 launched on 2026-09-17 (search results citing the author's post; an independent blog dated 2026-09-19 calls it "the second day of the language's life", with nine compiler releases in ten hours). It targets C, Metal, CUDA and JavaScript, uses dependent types, and describes itself as "a fast language that blocks AI mistakes via proof".
- **"Numbers are Nat, U32 and F32 only: no U64, I64 or F64 (Metal has no f64)... F32 is axiomatic: nothing about floating point can be proven."**
- "The checker has no proof and may have bugs; `--verdict` uses a proven kernel" (a kernel formalised in Lean). "The compiler (not kernel) is 99% AI-written and not yet fully audited." The blog adds that the standard library lacks lemmas for basic arithmetic and that proofs stay behind at the foreign-function boundary.

What follows for this project [REC]:

1. **Signal path: no.** Real-time audio needs bounded latency and low jitter; this toolchain compiles through clang and has limited I/O. (This also fits the house ruling on 2026-09-26, which said Bend is a poor fit for the control-surface TUI because the glass is I/O-bound and Bend's parallelism buys nothing there. [35])
2. **EQ proofs: no, not now.** No reals, no F64, floats axiomatic. The only EQ-relevant things it could prove today are integer or rational statements, and it has no 64-bit integer for a double-wide accumulator.
3. **Offline analysis: it could, but nothing needs it.** The tempting use is brute-force parameter sweeps on a GPU. But a ten-band EQ has thirty continuous parameters, so no sweep can cover the space; certification has to come from mathematics (S2, S6). My 2000-profile sweeps ran in minutes in plain numpy, and Bend's only float is 32-bit, so it cannot even serve as the reference. [M]
4. **Later, a second opinion on discrete invariants.** The queue and ring invariants (P2, P3, Model B) are exactly the list-and-natural-number statements a dependent-type language handles. It is a reasonable, low-stakes experiment once the TLA+ models exist: restate P3 as a Bend law and have the checker prove it, to see whether the owner's own agent-written language route can host proofs. The kernel's Lean formalisation is what would make that interesting. [REC]
5. **The house's earlier "record verifier" role stands** (parallel hash-chain checking) and is outside this lane. [35]

## 9. The Orgiac, C and Elixir trust chain

The owner's plan (literate org-mode compiling to C; systems layer in Elixir/BEAM) suggests this division. [REC]

| Layer | What it holds | How it earns trust |
|---|---|---|
| Stories ledger (plain text) | S1..S12, P1..P6, each with a rung | The owner reads this. |
| DSP kernel in C (tangled from org) | Coefficient checker and the per-sample recurrence | Properties stated as ACSL annotations in the same org file; Frama-C WP/Eva checks; Rocq proves the maths and, optionally, VCFloat2 the rounding. [9][16] |
| Checker (control side) | f64 coefficients, margins, certified peak and l1 bounds, preamp | Small, pure, proven once; produces a certificate (the numbers) the audio side applies. |
| Compiler flags | `-ffp-contract=off`, no `-ffast-math`, FP mode pinned | Golden vectors on every build. [19] |
| Player and queue (Elixir) | Actor edges | TLA+ model as spec; Concuerror and PropEr on the implementation. [27][31] |
| Optional verified compilation | CompCert for the kernel, or a Vélus-style route from stream equations | Carries a proof to machine code (E5). Check licence and FMA handling first. [17][18] |

A caution on "proofs live in the same literate file": it is a good fit for review (prose, code and proof side by side) but it makes the build run provers. Keep provers out of the audio build's critical path and make them a separate "verify" target. [REC]

## 10. Recommendations, in order

**Principle:** the app *refuses* a setting it cannot guarantee, rather than guessing. With ten bands (or a few dozen) the control side has time and precision to check everything; the audio thread only applies pre-checked numbers.

**Phase 0, now (EQ your headphones; days).** None of this needs a prover.
1. Compute coefficients in **f64** on the control side; run the filter in f64 (cost negligible [M]).
2. Stability is guaranteed by the closed forms in S2 for any admissible setting; as a belt-and-braces check compute the pole distance from the unit circle and refuse below a precision-independent floor such as 1e-5 (about 170 f32 grid steps; far above f64 round-off).
3. Compute the cascade peak with a **dense and refined** search, not a coarse grid [M], and set the preamp to its negative plus a small margin (the AutoEq pattern [26]). Report the l1 figure beside it ("sine-safe: -X dB; absolutely safe: -Y dB").
4. Cut-only must not touch peaks: no clipper unless the checker needs it. Place a final bounded limiter or clamp **after** the resampler. [M]
5. Ramp preamp and gain changes; clear filter state after long silence; reject non-finite samples at the input.
6. Pin compiler flags; record golden vectors. Evidence level reached: E2 for S1 to S3, S6a, S6c, S7, S9, S11.

**Phase 1 (weeks).**
7. Machine-check S1, S2, S3, S4 in Rocq (or Lean once a toolchain is installed). [REC] Small, high value, and the statements become the permanent ledger entries.
8. Certified peak (S6a) and l1 (S6b) bounds in the checker, with a Rocq proof that the checker's bound is an upper bound. Port the Hilaire-group approach. [2][3]
9. Choose the meaning of "same band at every rate" (S5) and prove the chosen design meets it. **Owner decision.**
10. TLA+ (or Quint) Models A and B; sandbox-MPD traces to learn real behaviour. [28]
11. Replace the filter structure with a state-variable form if click tests (S10) fail the target. **Owner decision** on the target.

**Phase 2 (weeks to months).**
12. Frama-C WP/Eva on the C kernel with imported invariants. [16] E4 for the recurrence via VCFloat2 or Gappa. [6][9]
13. Trace-check the new server against the TLA+ models (Cirstea et al.). [28]
14. Decide whether f32 (smaller, SIMD-friendly) is worth the XL proof of S8; f64 is the pragmatic default.

**Phase 3 (the Orgiac move).**
15. Carry the stories ledger and golden vectors across; redo or recheck proofs; consider a verified compiler for the kernel. [17][18]
16. A Bend 2 experiment on one discrete invariant, as in section 8. Low stakes.

**Questions for the owner [REC]**
- Which promise do you want as the default: *no sine clips* (smaller preamp) or *nothing clips* (about 4 to 9 dB more headroom)?
- What should a band's width mean at high sample rates (S5)?
- Is f64 for the EQ acceptable, which removes most of the proof burden at negligible CPU?
- Is a limiter after the EQ acceptable, with the guarantee "output never exceeds full scale" rather than "the EQ never changes loud music"?

## 11. Measured appendix

All with a verbatim copy of `eq.rs` (SHA-256 `9425d04f77c8ef1961a42214cda8a5cba3df7cb9390dfc4f3398ff92d6749b29`, only `pub` added) driven by a small Rust harness, plus numpy 2.5.3 for f64 analysis. Random profiles used seed 20261007. Files in `/tmp/msr-formal-verification/`: `rs/main.rs`, `analysis1.py`, `analysis2.py`, `analysis2b.py`, `analysis3.py` and their `.out` logs. This is scratch and may be cleared; the numbers above are the record.

| Item | Result |
|---|---|
| f64 centre gain error, 160 cases (4 rates x 4 gains x 10 bands) | max 6.9e-12 dB |
| f32 coefficient centre gain error, worst per rate | 0.0034 / 0.0013 / 0.0144 / 0.3997 dB at 44.1 / 48 / 96 / 192 kHz, always band 31 Hz |
| Pole distance from unit circle, 31 Hz +14 dB, f32 coefficients | 7.0e-4 / 6.4e-4 / 3.2e-4 / 1.6e-4 at 44.1 / 48 / 96 / 192 kHz |
| DC and Nyquist gain of a +14 dB section | 0 and -1.9e-15 dB |
| Stability sweep (3000 x 60 x 41 grid) | all stable; min margins 2e-8, 1e-10 |
| Exhaustive soft clip, 2,139,095,040 non-negative finite f32 | 0 above 1.0; 0 monotonicity or oddness violations; 5.5 s |
| Catmull-Rom worst overshoot for inputs in [-1, 1] | 1.25 (+1.94 dB) |
| All ten at +14: peak, l1, +-1 input achieved | +21.90 dB, +30.79 dB, 34.625 (equals l1) |
| FPCR at process start on this Mac | 0x0 (flush-to-zero off) |
| Filter speed, normal vs denormal state | 25.1 vs 20.0 ns per stereo sample |
| Silence test | never reaches exact zero in 60 s; 92 to 99 percent of outputs denormal |
| NaN test | left channel NaN permanently; right unaffected |
| Peak found by 256-point linear / 1024-point linear / 1/24-oct log grid | under-reports by up to 17.1 / 5.8 / 1.3 dB |

Method caveats: round-off numbers use white noise at -35 dBFS rms and a 4 s run; the transient experiment is f64, linear, unclipped; the synthetic profile percentages describe my random generator, not real headphones.

## 12. UNCONFIRMED

- How Equalizer APO treats the top of the spectrum, and whether its "Q" forms warp.
- Whether `compound.max_gain` in AutoEq is the exact peak of the summed response (read via fetch summary, not line by line).
- How CoreAudio handles float samples above 1.0; the size of inter-sample peaks relative to the clipped samples.
- Apple's or Arm's own statements on denormal cost on Apple silicon; the benchmark here is one measurement on one chip.
- CompCert: any release newer than 3.18, licence terms, FMA contraction behaviour, and its macOS AArch64 status today beyond the 3.9 notes.
- Rust's floating-point contraction defaults (not checked).
- Whether a common Lyapunov function exists for the state-variable bell under slider motion.
- Whether mathlib or any Lean library has Z-transform or Jury-criterion material (a search found none).
- Coquelicot and CoqInterval details (pages blocked); FPTaylor and Daisy primary pages (comparison seen via search summary only).
- Full text of the Volkova et al. paper, the Gallois-Wong thesis, and Akbarpour and Tahar's JAL paper (access-control pages or listings only).
- FLAC and MD5 coverage details beyond what the RFC section I read states (I read about 100,000 of 179,000 characters).
- The size of TLC state spaces for the models in section 5 (my estimate).
- Effort estimates throughout (S/M/L/XL) are judgement.

## 13. Sources

Local files read, never modified: `~/git/window_headMPD/src-tauri/src/{eq,audio,lib}.rs`; `~/git/window_headMPD-engine/docs/design/ENGINE.md` (`DspPort`, lines around 1593); `/opt/homebrew/etc/mpd.conf`; `~/git/VampireOTP/RAG/design/SPEC-control-surface-tui-2026-09-26.md`.

1. Robert Bristow-Johnson, Audio EQ Cookbook (W3C): https://www.w3.org/TR/audio-eq-cookbook/ (opened; formulas, bandwidth relation, warping statement quoted)
2. Volkova, Hilaire, Lauter, "Reliable evaluation of the Worst-Case Peak Gain matrix in multiple precision", ARITH 2015: https://hal.sorbonne-universite.fr/hal-01083879v3 (abstract via search listing; page blocked)
3. Gallois-Wong, Boldo, Hilaire, "A Coq Formalization of Digital Filters", CICM 2018: https://www.springerprofessional.de/en/a-coq-formalization-of-digital-filters/15994968 (abstract opened); HAL copy https://hal-centralesupelec.archives-ouvertes.fr/hal-01728828v1 (blocked)
4. Gallois-Wong, thesis "Formalisation en Coq des algorithmes de filtre numerique calcules en precision finie", Paris-Saclay 2021: https://tel.archives-ouvertes.fr/tel-03202580 (identifier from search listing; not opened); defence notice https://lmf.cnrs.fr/News/PhD-defense-Diane-Gallois-Wong
5. Akbarpour and Tahar, "Error analysis of digital filters using HOL theorem proving", J. Applied Logic 5(4), 2007: listing at https://dblp.dagstuhl.de/pid/74/1259.html (not opened). The FMCAD 2004 FFT paper by the same authors: https://www.cs.utexas.edu/~hunt/FMCAD/2004/accepted/72.html (opened)
6. Becker et al., "A Verified Certificate Checker for Finite-Precision Error Bounds in Coq and HOL4" (FloVer): https://arxiv.org/pdf/1707.02115 (first page read)
7. Melquiond et al., "Certifying floating-point implementations using Gappa": https://arxiv.org/pdf/0801.0523 (search listing)
8. Comparison of Gappa, Fluctuat, PRECiSA, Real2Float, Rosa, FPTaylor: https://arxiv.org/pdf/1507.03331 (description via search summary; not opened)
9. Appel and Kellison, "VCFloat2: Floating-Point Error Analysis in Coq", CPP 2024: https://www.cs.princeton.edu/~appel/papers/vcfloat2.pdf (search listing)
10. Boldo and Melquiond, "Computer Arithmetic and Formal Proofs" (Flocq): https://shop.elsevier.com/books/computer-arithmetic-and-formal-proofs/boldo/978-1-78548-112-3
11. Rocq Prover 9.0 release: https://rocq-prover.org/releases/9.0.0
12. Lean reference, Floating-Point Numbers: https://lean-lang.org/doc/reference/latest/Basic-Types/Floating-Point-Numbers/ (first 100,000 of 225,831 characters read)
13. FloatSpec on Lean Reservoir: https://reservoir.lean-lang.org/@Beneficial-AI-Foundation/FloatSpec
14. Kani intrinsics support table: https://model-checking.github.io/kani/rust-feature-support/intrinsics.html
15. CBMC overview: https://arxiv.org/pdf/2302.02384 (search summary)
16. Vedrine, Piriou, David, "Numerical filter code analysis", Frama-C Days 2024: https://frama-c.com/download/publications/frama-c-days-2024/14-filters.pdf (6 slides read); Frama-C with Gappa: https://hal.archives-ouvertes.fr/hal-00777605 (search listing)
17. CompCert releases: https://github.com/AbsInt/CompCert/releases (fetch summary)
18. Bourke et al., "A Formally Verified Compiler for Lustre", PLDI 2017: https://www.di.ens.fr/~pouzet/bib/pldi2017.pdf (search listing)
19. Clang user manual, `-ffp-contract` and `-ffast-math`: https://clang.llvm.org/docs/UsersManual.html (first 100,000 of 316,450 characters read)
20. Arm FPCR register description (FZ, FIZ, AH): https://df.lth.se/~getz/ARM/SysReg/AArch64-fpcr.html (search listing)
21. Orfanidis, "Digital parametric equalizer design with prescribed Nyquist-frequency gain", JAES 45(6), 1997: https://aes2.org/publications/elibrary-page/?id=13397 (search listing)
22. Vicanek, "Matched Second Order Digital Filters", 2016: https://www.vicanek.de/articles/BiquadFits.pdf (search listing)
23. Zavalishin, "The Art of VA Filter Design" (discussion with summary of TPT and modulation): https://www.kvraudio.com/forum/viewtopic.php?p=6257704 (search listing; book itself not opened)
24. Simper (Cytomic), "Solving the continuous SVF equations using trapezoidal integration and equivalent currents": https://cytomic.com/files/dsp/SvfLinearTrapOptimised2.pdf (pages 1 to 4 read)
25. Equalizer APO configuration reference: https://sourceforge.net/p/equalizerapo/wiki/Configuration%20reference/
26. AutoEq: https://github.com/jaakkopasanen/AutoEq and https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/autoeq/frequency_response.py (fetch summary)
27. Newcombe et al., "How Amazon Web Services Uses Formal Methods", CACM 2015: https://cacm.acm.org/magazines/2015/4/184701-how-amazon-web-services-uses-formal-methods/fulltext (search listing)
28. Cirstea, Kuppe, Loillier, Merz, "Validating Traces of Distributed Programs Against TLA+ Specifications": https://arxiv.org/abs/2404.16075
29. Quint: https://github.com/informalsystems/quint
30. Stateright: https://docs.rs/crate/stateright/latest
31. Concuerror: https://github.com/parapluu/Concuerror and PropEr (stateful property testing): https://elixirforum.com/t/property-based-testing-with-proper-erlang-and-elixir-pragprog/15339 (search listings)
32. MPD protocol documentation: https://mpd.readthedocs.io/en/latest/protocol.html
33. RealtimeSanitizer: https://clang.llvm.org/docs/RealtimeSanitizer.html (search listing)
34. Bend 2: https://github.com/HigherOrderCO/Bend (README fetched via https://raw.githubusercontent.com/HigherOrderCO/Bend/main/README.md); launch write-up https://akitaonrails.com/en/2026/09/19/new-ai-language-just-released-bend-2/ ; launch post by the author (search listing only) https://x.com/VictorTaelin/status/2100681226143092875
35. House ruling on Bend, SPEC control-surface TUI, section 4(c), 2026-09-26: `~/git/VampireOTP/RAG/design/SPEC-control-surface-tui-2026-09-26.md`
36. FLAC format, RFC 9639: https://www.rfc-editor.org/rfc/rfc9639.html (first 100,000 of 179,404 characters read)
