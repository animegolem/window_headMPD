# Follow-up 3: one gain chain, one headroom rule, one smoothing rule

Date 2026-10-07. Resolves the critic's item "Headroom rule, limiter placement and parameter-change method differ across lanes". Tags: **[M]** measured or read from source here, **[R]** recommendation, **[reasoning]** derived but not measured, **UNCONFIRMED**.

## 1. The answer

**Did a lane get it wrong? Yes, in four places.** architecture 10.4 (headroom rule: wrong in both directions), hidden-problems C2 (limiter before volume) and C1 (cross-fade with no fade law), and eq-dsp 4.6 rule 1 (its UNCONFIRMED "recompute every 16 to 32 samples" is wrong if the coefficients are held between recomputes). The other statements are right or only loose. Table in section 4.

### 1.1 The gain chain (one, per output) [R]

1. Decode to float **at the device rate**. Any resampling happens here, upstream of everything below (architecture section 7, `architecture.md:220, 323, 346`: decode slots hand the graph float at the device rate).
2. **Loudness gain L**, per track, before any track crossfade. Cap: L is at most minus the track's peak in dB; peak unknown means assume 0 dBFS, i.e. no boost. (ReplayGain's "Reduced gain" clause [R1].)
3. Track-to-track crossfade, when enabled: equal-power curves (two unrelated signals).
4. **EQ preamp P.**
5. **EQ filters.**
6. Balance. 7. Volume. Both attenuation-only, never above 0 dB.
8. Optional look-ahead true-peak **limiter**, off by default.
9. **Clamp** at plus or minus 1.0, always on, NaN becomes 0, every hit counted (this is the clip indicator hidden-problems A2 asks for).
10. Integer outputs only: TPDF dither, round, saturate (counted).

Placement rule: **nothing that can add gain or overshoot may sit after the clamp.** A resampler can (the app's Catmull-Rom reaches 1.25 on samples -1,+1,+1,-1 at the midpoint; checked by hand, matches formal-verification S6c). Dither can (up to 1 LSB). In the server neither is after the EQ, so "last stage" and "after the resampler" are the same place. The formal-verification wording describes today's app, where the resampler runs after the clipper (`formal-verification.md` section 3).

Why the limiter is after volume and not before it [reasoning]: the float pipeline cannot clip until the last conversion, and full scale only means something at the device edge. With volume at -20 dB, a pre-volume limiter would flatten peaks the device would never have clipped. A bound set before a stage survives it only if that stage cannot raise the peak; volume and balance can't, the resampler and dither can.

Why a clamp *and* an optional limiter: the clamp is stateless, bounded, and is the identity for in-range samples, so it keeps the EQ-off path bit-exact (answers architecture 10.2's worry). The limiter is a dynamics effect with a sound; it stays a choice.

### 1.2 The headroom rule (one) [R]

```
H_peak = max over f in [20 Hz, fs/2] of 20*log10 |H_total(f)|     (all filters multiplied)
P      = - ceil_to_0.1_dB( max(0, H_peak) )
```
Dense evaluation (at least 200 points per octave, then refine), at the graph's sample rate, recomputed whenever a filter or the rate changes. Cut-only profiles get P = 0. This is "sine-safe from 20 Hz up": no steady full-scale sine in that range can exceed full scale after the EQ. Two stronger promises are offered *by name*, not as the default: **full-range** (include DC to 20 Hz) and **absolute** (any signal at all, preamp = minus the sum of the absolute impulse response). The clamp is the guarantee in every mode. Loudness gain (step 2) and the preamp are **two separate caps, not one shared pool**: the preamp's attenuation is spent at the boosted frequencies, so a positive loudness gain may not borrow it [reasoning]. architecture section 9 and eq-dsp 4.7 both say "share one budget"; read that as "both subtract from full scale", each with its own cap.

### 1.3 The smoothing rule (one) [R]

**Every change to level or response is a raised-cosine transition, 20 ms by default (user range 10 to 50).** What moves depends on the kind of change:

- **Continuous edit** (an existing band's gain, frequency or Q; preamp; volume; balance): ramp the *parameter* with the raised-cosine law (gain in dB, frequency in log Hz, Q in log Q; mute as linear gain to zero), and design the filter from the ramped value every sample, or every 128 samples or fewer **with per-sample linear interpolation of the coefficients between design points. Never hold them.** The **preamp rides the same transition** as the filter gains.
- **Structural change** (add or remove a band, change type, load a profile, bypass, rate change): run old and new chains and cross-fade the two *outputs* with raised-cosine weights that **sum to 1**. The incoming chain may start cold. Where a band can be added at 0 dB gain, do that and ramp it instead (eq-dsp 4.6 rule 3).
- **Never:** a step; a linear ramp or linear fade; an equal-power fade between chains; coefficients held between recomputes; resetting filter memory.

The state-variable filter (SVF) is **not needed to stop clicks** on slider and profile edits; it stays reserved for audio-rate sweeps (eq-dsp 4.6 rule 5).

## 2. Evidence: headroom [M]

**What AutoEq does, from its source** [A1][A2][A3]: `PEQ.fr` is the sum of every filter's dB response; `max_gain = np.max(self.fr)`; the evaluation grid is 20 Hz to 20 kHz in steps of x1.02, at the optimisation sample rate (default 44100); the file line is `Preamp: {-compound.max_gain:.1f} dB`, nearest 0.1 dB, no margin. Its README helper writes `-(max_gain + 0.1)` instead. Equalizer APO's `Preamp` exists "to make sure that no clipping occurs" with positive-gain filters and several preamps add in dB [E1]. This closes formal-verification section 12's second UNCONFIRMED item (whether AutoEq's `max_gain` is the exact peak).

**Real profiles.** 75 AutoEq `ParametricEQ.txt` files (every k-th entry of the repo index: 40 oratory1990 over-ear, 20 oratory1990 in-ear, 15 crinacle GRAS over-ear), my own RBJ implementation (same formulas as `peq.py`), 44.1 kHz, dense 2^18-point grid:

| Question | Result |
|---|---|
| File Preamp vs my peak over 20 Hz to 20 kHz | within 0.12 dB of minus my peak, at most 0.10 dB short; 9 of 75 files are 0.05 to 0.1 dB short; none more |
| Is that scatter just rounding of the published numbers? | simulated rounding alone gives sd 0.043 dB vs observed 0.042 (consistent, not proof: AutoEq's unrounded filters aren't published) |
| AutoEq's 1.02 grid vs dense, same window | grid under-reports by at most 0.02 dB (0.03 at 96 kHz) |
| **Largest single positive gain vs the true peak** | too small in 15 of 75 (8 by more than 0.5 dB, worst 1.8 dB, Focal Stellia); too large in 48 of 75 (19 by more than 1 dB, worst 9.9 dB, Meze Rai Solo: +16.1 dB single filter, peak +6.2); within 0.05 dB in only 12 |
| Sum of positive gains vs the peak | never below it (0 of 75; shelf Q is at most 0.70 in this sample), but median 10.9 dB too much. Not a general bound: eq-dsp 4.2 notes shelves above Q 0.7071 overshoot |
| Window 20 Hz to Nyquist vs 20 Hz to 20 kHz | +0.04 dB at 44.1 kHz; up to +0.57 dB at 96 kHz (5 of 75 over 0.05 dB: high shelves keep boosting above 20 kHz) |
| **Adding DC to 20 Hz** | extra attenuation median 0, p90 1.1, **max 6.5 dB** (HE1000 V2: +12.5 dB at DC vs +6.0 at 20 Hz); over 0.5 dB in 13 of 75, over 3 dB in 2 |
| Any-signal promise vs sine-safe | extra attenuation median 4.5, p90 6.2, max 7.6 dB |
| Preamp of the sample | median -6.2 dB, range -1.6 to -7.0 |

The sub-20 Hz gap is one pattern: a bass shelf (low shelf at 105 Hz) plus a narrow cut in the 30 to 90 Hz region. The response dips just above 20 Hz and climbs back toward DC. AutoEq's grid starts at 20 Hz, so its optimiser and its preamp never see that. A 2nd-order Butterworth high-pass at 10 Hz ahead of the EQ cuts the full-range extra to max 1.9 dB (2 of 75 over 0.5 dB) at a cost of -0.26 dB at 20 Hz and -0.05 dB at 30 Hz; at 15 Hz it removes the extra but costs -1.2 dB at 20 Hz.

**Other chain facts.** Ramping preamp and filter gains together on the same transition, 900 single-band drags of +/-3 and +/-6 dB: worst momentary overshoot +0.034 dB; an EQ-strength ramp 0 to 1 over the 75 profiles: max +0.47 dB, one profile over 0.25 dB (the clamp absorbs these). A cross-fade of two sine-safe chains with weights summing to 1 can never exceed full scale at any fade position (triangle inequality; 300 random profile pairs, worst -0.0004 dBFS). With equal-power weights the same test reached **+3.005 dBFS**.

## 3. Evidence: smoothing [M]

My own re-implementation (`xf.c`, 64-bit, `-ffp-contract=off`) reproduces eq-dsp's section 4.6 table to 0.1 dB on the rows I ran (hard swap -42.1 / -34.5, 20 ms ramps -92.3 to -100.0, linear fade -58.1 / -70.1, raised-cosine fade -102.8 / -114.8). Setup as eq-dsp: 200 Hz tone at -6 dBFS through a bell at 200 Hz, Q 1.41, change at 0.5 s; number = loudest content above 3 kHz in the next 150 ms, worst of 8 tone phases, dBFS (lower is better; the analysis floor is about -104 for the louder 0 to +12 case and lower when the output is quieter, as in +12 to 0, so rows near the floor are tied):

| Method (all 20 ms unless stated) | gain 0 to +12 dB | +12 to 0 dB |
|---|---|---|
| Step, today's filter structure, memory kept | -42.1 | -34.5 |
| Linear parameter ramp (eq-dsp's rule) | -92.5 | -93.3 |
| **Raised-cosine parameter ramp** | **-104.3** | **-133.9** |
| Raised-cosine parameter ramp, 5 ms | -103.3 | -108.7 |
| Redesign every 32 samples, **held**, linear ramp | -67.1 | -65.1 |
| Redesign every 32 samples, **interpolated** per sample, raised-cosine | -102.2 | -109.0 |
| Cross-fade of outputs, linear | -58.1 | -58.1 |
| **Cross-fade of outputs, raised-cosine** | **-102.8** | **-103.7** |
| Cross-fade of outputs, equal-power | -51.7 | -51.7 |
| State-variable filter: step / linear ramp / raised-cosine ramp | -9.7 / -58.0 / -102.9 | -3.8 / -56.8 / -102.5 |

The same ordering held for a 1 kHz tone and for -12 dB and +1 dB steps (`xf_analyze*.out`). Reading:

- **The ramp shape is what matters.** A linear ramp has a corner at each end; the raised-cosine has none. Fade law and ramp law are one question, so one law covers both.
- **Plain gain changes behave the same** (1 kHz tone at -6 dBFS, 0 to -12 dB): step -15.6, linear in dB -63.8, **raised-cosine in dB -99.3**; mute: linear -66.6, raised-cosine -98.1.
- **Held block updates cost 25 to 36 dB**; interpolating between design points recovers it. This corrects eq-dsp 4.6 rule 1.
- **Equal-power is wrong between two versions of the same signal:** the outputs are the same music, so the weights add instead of power-adding, giving a **+3.0 dB bump** mid-fade (peak 0.706 vs 0.500), about 6 dB more click than a linear fade and about 50 dB more than raised-cosine. Equal-power stays right for track-to-track crossfades.
- **Cold start is fine for clicks:** the incoming chain starting from zero memory gave the same above-3-kHz level as a settled one (-103.1 vs -102.8). It does give a slow bass swell: for the HE1000 V2 profile and a 40 Hz tone the difference peaks at -9.2 dB below the signal peak, settling about 0.1 s after the fade (1 kHz tone: -36.5; noise: -52). If a bypass toggle sounds like a swell, prime the new chain on the last ~100 ms of input; not needed for clicks.
- **The SVF is not the fix.** With the same raised-cosine ramp it ties or loses to the current structure. A step is *worse* in this metric because the output follows the stepped gain directly. formal-verification S10 measured something else (deviation from the new steady output, a slow low-frequency effect), so the two sets of numbers do not conflict; I did not measure that metric. Wishnick's paper calls the choice "a trade-off", notes "interpolating TDF-II coefficients can give less sensible intermediate transfer functions", and in its listening test (21 listeners, one 100 Hz tone, five trials) the TDF-II scored above the SVF in four of the five (its Table 5) [W1]. The paper also confirms the warning eq-dsp quotes: direct form II, lattice and normalised ladder are "not necessarily stable when coefficients are changed".

## 4. Which lane document this corrects or extends

| Lane, place | Says | Verdict and fix |
|---|---|---|
| architecture 10.4, last bullet | preamp at least minus the largest positive filter gain | **Wrong.** Replace with the formula in 1.2. It is the app's bug minus the 0.6 factor, and still fails in both directions (section 2) |
| architecture 9 last bullet, 10.3 | loudness and EQ "share one headroom budget"; order ends volume, limiter, dither | Extend: two caps; add the clamp as step 9; state the resampler is upstream. Limiter position is right |
| architecture 4.4 | "cross-fades from the old coefficients to the new" | Imprecise. It is a coefficient ramp: measured fine for gain edits (and best with the raised-cosine shape); for frequency or Q edits Wishnick warns of odd intermediate responses [W1, not measured here]. Say "ramp parameters" so it isn't confused with an output cross-fade |
| hidden-problems C2 | ... EQ, true-peak limiter, **then volume**, dither | **Wrong placement.** Limiter after volume, clamp last. The rest (gain before the mix, one EQ after it) stands |
| hidden-problems C1 | "or run old and new for 10-20 ms and crossfade the results" | **Defective:** no fade law, and the obvious linear law is -58 / -70 dBFS. Specify raised-cosine, weights sum to 1 |
| hidden-problems A2 | preamp = minus the true maximum; limiter after the EQ; smooth 10-20 ms | Right. Add the fade law and the 20 Hz window |
| eq-dsp 4.1 / 4.7 | limiter after volume (4.1), "after the EQ" (4.7); "share one budget" | Same place, read as after volume. Extend with the window (section 2) and the two caps |
| eq-dsp 4.7, DC | maximum "at DC", a formal claim must cover it | Extend: on real profiles that costs up to 6.5 dB, not the 0.24 dB of the HD 600 example. Default 20 Hz, DC as a named mode |
| eq-dsp 4.6 rule 1 | linear ramp; "every 16 to 32 samples is the obvious economy" (UNCONFIRMED) | Ramp: upgrade to raised-cosine (-92 to -104 and better). Economy: **wrong if held** (-67), right with per-sample interpolation |
| eq-dsp 4.6 rule 2 | raised-cosine cross-fade | Right. Add "weights sum to 1" and "cold start is fine" |
| formal-verification S6c, Phase 0 item 4 | final clamp after the resampler | Right for today's app. For the server: after volume, last; clamp also maps NaN to 0 (S9 measured NaN passing the soft clip) |
| formal-verification S6a | "a full-scale sine at any frequency never clips" | True only for the chosen window. State "from 20 Hz up" (or DC mode). Default question: sine-safe, with the any-signal mode named |
| formal-verification S10, Phase 1 item 11 | switch to a state-variable filter | Not needed; ramp shape fixes it (section 3). Keep as the audio-rate option |
| formal-verification section 12, second item | is AutoEq's `max_gain` the exact peak? | **Closed** (section 2): grid maximum of the summed response, 20 Hz to 20 kHz |
| headphones-today (tonight recipe) | uses the file's Preamp line | Fine. It matches the window peak within rounding; the server recomputes from the filters (9 of 75 files leave 0.05 to 0.1 dB over) |

## 5. Two owner decisions

1. **Below 20 Hz.** Recommendation: default 20 Hz to Nyquist, full-range as a named mode, no high-pass. The cost of full-range is real (up to 6.5 dB on 2 of 75 profiles); the content it protects (full-scale sines below 20 Hz) is not music. A 10 Hz high-pass is available if you want the "DC included" claim without that cost.
2. **Default promise.** Sine-safe, as the requester's sample suggests. The requester reports 24 real tracks stayed under 0 dBFS with the sine-safe AutoEq preamp; I did not re-run it. 24 tracks is evidence, not proof. The any-signal mode costs a median 4.5 dB more.

## 6. Limits and UNCONFIRMED

- 75 profiles, every k-th from three sources, designed at 44.1 kHz; not the whole catalogue.
- Smoothing: one bell at Q 1.41 and pure tones, one artifact metric, no listening test, no music. Cost of per-sample redesign not benchmarked. Low-frequency, high-rate behaviour (31 Hz at 192 kHz) not re-tested.
- Volume-ramp law measured on a 1 kHz tone only.
- Whether CoreAudio clips float above 1.0: Apple's driver guide says "the driver is responsible for providing a routine that can clip and convert that 32-bit floating point output data" [C1], so it is per driver. UNCONFIRMED for the built-in jack and any USB DAC. The chain never relies on it.
- The ReplayGain wiki blocks direct fetch (403); read from an Internet Archive copy [R1].
- The SVF formula is from memory of Cytomic's design; correctness doesn't depend on the source because it matches the RBJ bell's impulse response to 8e-15.

## 7. Sources

- [A1] AutoEq `frequency_response.py` (lines 199-213, 284-325): https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/autoeq/frequency_response.py
- [A2] AutoEq `peq.py` (`fr`, `max_gain`, biquad coefficients): https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/autoeq/peq.py
- [A3] AutoEq `constants.py` (20 Hz, 20 kHz, step 1.02, default rate 44100): https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/autoeq/constants.py
- [A4] AutoEq results index and the 75 files: https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/INDEX.md
- [E1] Equalizer APO configuration reference, Preamp: https://sourceforge.net/p/equalizerapo/wiki/Configuration%20reference/
- [W1] Wishnick, "Time-Varying Filters for Musical Applications", DAFx-14: https://dafx.de/paper-archive/2014/dafx14_aaron_wishnick_time_varying_filters_for_.pdf
- [R1] ReplayGain specification, "Clipping prevention" (Internet Archive copy): https://web.archive.org/web/2020/http://wiki.hydrogenaud.io/index.php?title=ReplayGain_specification
- [C1] Apple, Audio on OS X (driver guide): https://developer.apple.com/library/mac/documentation/DeviceDrivers/Conceptual/WritingAudioDrivers/AudioOnMacOSX/AudioOnMacOSX.html

Scratch, all in `/tmp/msr-followup-3/work/` (Python run with `-I`, NumPy 2.5.3; C with clang): `headroom_real.py`, `final_numbers.py`, `checks.py`, `ramp_headroom.py`, `hp_dc.py`, `xf.c` with `xf_analyze.py` and `xf_analyze2.py`, `cold_prime.py`, `gain_ramp.py`; their `.out` logs; downloads in `/tmp/msr-followup-3/dl/`.
