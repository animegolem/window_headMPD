# Follow-up 4: does "boost then cut equals wire" survive the analog-matched mode?

Date: 2026-10-07
Resolves the critic's verify-claim across the `eq-dsp` and `formal-verification` lanes: "Boost-then-cut identity fails in eq-dsp's analog-matched mode; the verification ledger is not mode-conditioned."

Terms. A **bell** is a peaking filter (boost or cut around one frequency). **Wire** means no change at all. **Mode A** is eq-dsp's "same as Equalizer APO" (the Audio EQ Cookbook bell). **Mode B** is eq-dsp's "analog-matched" bell (Vicanek 2016), which is also formal-verification's S5 option (a). Tags: **[M]** I measured it today. **[D]** I derived it by hand from the cited formulas; nobody has machine-checked it. **[REC]** my recommendation. **UNCONFIRMED** I could not check it.

## 1. Answer

1. **The critic's measurement is right, and I reproduced it exactly.** Mode B as eq-dsp prints it (each gain designed on its own) does not give wire for boost then cut. At 44.1 kHz, Q 1.41, +6 dB then -6 dB, the leftover is 0.000005 dB at 1 kHz, 0.025 dB at 8 kHz and 0.31 dB at 16 kHz. Those three figures are the largest leftover between 20 Hz and 20 kHz. [M] Counting up to half the sample rate (22.05 kHz) the 16 kHz case reaches 0.39 dB.
2. **The stated cause is only half right.** Poles depend on gain in the cookbook too. The real cause is that mode B builds the poles and the zeros with two different mappings, so the cut's denominator is no longer the boost's numerator. Section 3.
3. **It is a cheap fix, not a trade-off.** Build every cut as the exact inverse of the boost of equal size ("swap numerator and denominator"). That restores exact cancellation, keeps the analog match, and is *more* accurate for cuts than Vicanek's own cut. Measured leftover: under 2e-12 dB everywhere I tried. [M] Section 3.
4. **So S4 and S5 are not independent only if the owner picks mode B as printed.** With the cut rule in 3, S5 option (a) keeps S4's cancel property. The owner's S5 decision should therefore include one more line: "a cut is defined as the inverse of the boost of the same size and width." [REC]
5. **Two other properties in the ledger are cookbook-only, and the critic missed one.** "Gain at half the sample rate is exactly 0 dB" (eq-dsp P2) is false in mode B by design (+1.41 dB for a 10 kHz, +6 dB bell at 44.1 kHz). And eq-dsp P10 is the rate-change property, not the 0 dB identity; the identity is in P2. Section 4.
6. **Was a lane wrong?** No lane has a wrong number, and formal-verification S4 scopes its own derivation correctly ("the cookbook's A to 1/A swap"). The errors are by omission. eq-dsp 4.13 states P2 (half-rate gain) and P3 with no mode tag and summary item 10 promises "boost-then-cut equals wire" for the whole DSP core. formal-verification's ledger row S4 and its S5 option list never say that option (a) breaks S4. Separately, the "verified" wording is looser than formal-verification's own rule, and the rung is E1, not E2, for the ffmpeg and headphones-today checks. Section 6.

## 2. What I measured

Method: I wrote the filter designs from the primary sources, not from the lane scripts (`/tmp/msr-followup-4/work/designs.py`). I checked my transcription of the matched bell against eq-dsp's printed formulas and Vicanek's equations 12, 29, 42, 44 and 45: gain at the centre is exactly the set gain, DC is 0 dB, and the 10 kHz +6 dB bell at 44.1 kHz has +1.4061 dB at half the sample rate, the same figure eq-dsp's appendix A2 gives. [M] eq-dsp's printed formulas are faithful to the paper. [S2]

**Leftover after boost then cut, mode B as printed (cut designed on its own), Q 1.41.** Leftover in dB at 20 kHz (the top of what is audible); in brackets the largest value anywhere up to half the sample rate. [M]

| Bell | 44.1 kHz, +-6 dB | 44.1 kHz, +-12 dB | 48 kHz, +-6 | 48 kHz, +-12 | 96 kHz, +-6 | 96 kHz, +-12 |
|---|---|---|---|---|---|---|
| 1 kHz | 0.000004 | 0.00003 | 0.000003 | 0.00002 | 0.0000002 | 0.000001 |
| 8 kHz | 0.025 | 0.12 | 0.017 | 0.085 | 0.0009 | 0.0047 |
| 10 kHz | 0.069 | 0.305 | 0.046 | 0.21 | 0.0022 | 0.011 |
| 16 kHz | 0.31 (0.39) | 1.16 (1.40) | 0.22 (0.34) | 0.85 (1.24) | 0.0085 (0.017) | 0.038 (0.086) |

Where the leftover lives: at the bell's own centre and at DC it is exactly zero (both filters hit the set gain there). It grows toward half the sample rate and the sign is negative, so the cut wins. It is not just a level error: the complex product differs from 1 by up to 0.15 at 16 kHz, +-12 dB, 44.1 kHz, so phase is off too. [M]

**Leftover for every design, worst of 30 cases** (rates 44.1, 48 and 96 kHz; centres 1, 4, 8, 10 and 16 kHz; +-6 and +-12 dB; Q 1.41; 20 Hz to half the sample rate). [M]

| Design | Worst leftover |
|---|---|
| Cookbook, Q form (mode A) | 1.1e-12 dB |
| Cookbook, bandwidth form (S5 option c, BW 1 octave) | 1.2e-12 dB |
| Matched bell as printed (mode B, S5 option a) | **1.40 dB** |
| Matched bell, cut built as inverse of boost | 1.6e-12 dB |
| Orfanidis (S5 option b), where defined | 2.5e-12 dB |

The cookbook shelves (low and high, Q form) leave 1.2e-9 dB or less over 3 rates, 5 centres, 2 gains and 4 Q values. Mode B uses cookbook shelves, so shelves are unaffected. [M]

## 3. Why it happens, and the fix

**Cause.** The cookbook's bell comes from one analog filter, `H(s) = (s^2 + s*A/Q + 1) / (s^2 + s/(A*Q) + 1)`, pushed through one mapping (the bilinear transform) applied to numerator and denominator alike. Changing the gain from +g to -g replaces `A` with `1/A`, which swaps numerator and denominator. One mapping applied to both sides means the digital numerator and denominator swap too. [S1] The cookbook says so itself: its Q is defined "so that a boost of N dB followed by a cut of N dB for identical Q and f0/Fs results in a precisely flat unity gain filter or 'wire'." [S1] I confirmed the coefficient swap to 2e-16. [M]

Vicanek's matched bell uses the *same* analog filter (his eq. 42), but takes the poles by impulse invariance (his eq. 12: each analog pole s maps to z = e^s) and fits the zeros to the analog magnitude at DC and at the centre (his eqs. 43 to 45 and 29). He says he does not use the mapped zeros and puts "no special requirement" at Nyquist. [S2] Two different mappings means the cut's denominator is not the boost's numerator. Measured coefficient mismatch at 44.1 kHz, +-6 dB: 1e-8 at 1 kHz, 2e-3 at 8 kHz, 8e-2 at 16 kHz (the cookbook: 2e-16 at all three). The zeros of the boost and the poles of the cut sit at different angles at 16 kHz (2.13 versus 1.97 radians). [M]

"Poles depend on gain" does not separate the two designs: the cookbook's poles also move with gain (`a1`, `a2` use `alpha/A`; at 8 kHz, Q 1.41, a2 is 0.629 at +6 dB and 0.374 at -6 dB). [M]

**Fix [REC].** Define a cut as the exact inverse of the boost of equal size: design the +|g| bell, then swap numerator and denominator. Measured results:

- Boost times cut: exact (section 2 table). [M]
- Accuracy against the analog bell: identical to the boost's, because the analog cut is exactly the inverse of the analog boost. Vicanek's own direct cut is *worse*: at 44.1 kHz, 16 kHz, -12 dB, 1.83 dB error versus 0.67 dB for the inverse-of-boost cut; at -6 dB, 0.75 versus 0.44; at 8 kHz, -12 dB, 0.58 versus 0.46. The inverse-of-boost cut was at least as accurate in all 18 cut cases I compared (3 rates, centres 1, 8 and 16 kHz, -6 and -12 dB). [M]
- Stability: the inverse is stable only if the boost's numerator is minimum phase (zeros inside the unit circle). Vicanek requires this (his eq. 28) and his closed form is built to give it. In 400,000 random boosts (rates 44.1 to 192 kHz, centre 10 Hz to 0.499 of the rate, 0.01 to 24 dB, Q 0.1 to 30) there were zero violations, zero unstable poles, zero design failures; worst centre-gain error 0.0005 dB, all of it among centres below 0.001 of the sample rate. Same sweep on 400,000 direct cuts: also zero. [M] This is a random sample, not a proof; I did not re-derive eq. 28's claim.
- Continuity through 0 dB: the coefficients of the +g and -g designs are mirror images that both tend to the identity, linearly in g (checked at 0.1, 0.01, 0.001 dB). [M] Whether a slider ramp through zero clicks was **not measured** (UNCONFIRMED; eq-dsp 4.6's measurement method applies).

Two hand derivations I rely on [D]:

- *0 dB identity in mode B.* At G = 1 the pair of equations (44) is solved by B_i = A_i, and the determinant (-4*phi1^2) is nonzero for any centre above 0, so that is the only solution. Equation 29 then gives W = 1 + a2, b0 = 1, b1 = a1, b2 = a2. In double precision I measured up to 5.9e-11 in the coefficients (4 rates, 7 centres from 20 Hz to 20 kHz), so exact bypass needs a "0 dB means skip" rule.
- *Stability of matched poles.* `z = e^s` with a left-half-plane `s` has modulus below 1 for every positive Q, gain and centre. No sweep needed; the sweep above confirms it.

## 4. Properties per mode

Columns: **A** cookbook Q form (eq-dsp mode A). **A-BW** cookbook bandwidth form (formal-verification S5 c). **B** matched bell as printed (eq-dsp mode B; S5 a). **B+** matched bell with the cut-as-inverse rule (my proposal). **O** Orfanidis (S5 b), implemented from the summary in Vicanek's section 3.3 and validated (DC 0 dB, centre gain exact, half-rate gain equal to the prescribed analog value); Orfanidis's own paper was not read (see section 8).

| Property (lane ref) | A | A-BW | B | B+ | O |
|---|---|---|---|---|---|
| Stable at every setting (P1, S2) | yes [D] | yes [D] | yes [D]; 0 failures in 800,000 random [M] | yes if boost numerator is minimum phase: paper requires it, 0 failures in 800,000 [M] | 0 failures in 544 in-domain cases [M] |
| DC gain 0 dB (P2) | exact [D] | exact [D] | exact by construction; <1e-9 dB [M] | same | exact by construction |
| Gain at half the sample rate 0 dB (P2 as written) | exact [D] | exact [D] | **no**: +1.41 dB (10 kHz, +6, 44.1 k); +4.36 dB (16 kHz) [M] | **no**, same | **no**: +0.89 dB (10 kHz case); equals analog value |
| Gain at the centre = set gain (P2, S1) | exact [D] | exact [D] | exact by construction; worst error 0.0005 dB, only for centres below 0.001 of the rate [M] | same | exact |
| 0 dB setting is the identity (P2) | bit-exact [M] | bit-exact [M] | exact in real arithmetic [D]; 6e-11 left in double precision [M] | same | formulas are 0/0 at exactly 0 dB; needs a special case; limit is the identity [M] |
| Boost then cut = wire (P3, S4a) | exact (1e-12 dB) [M] | exact (1e-12 dB) [M] | **no** (up to 0.31 dB at 20 kHz, 1.16 dB at +-12) [M] | exact (2e-12 dB) [M] | exact where defined (2.5e-12 dB) [M]; undefined above about 15.6 kHz at 44.1 kHz, Q 1.41 |
| Error against the analog bell, 44.1 kHz, max 20 Hz to 20 kHz: 8 kHz +-12 / 16 kHz +-12 | 1.90 / 7.35 dB [M] | different target | boost 0.46 / 0.67, cut 0.58 / 1.83 [M] | 0.46 / 0.67 both [M] | 0.35 / out of domain [M] |
| Shelves boost then cut | exact (1e-9 dB) [M] | exact | cookbook shelves: exact | exact | not covered |
| Band order irrelevant (S4b) | exact maths, any linear filter [D]; rounding by test | same | same | same | same |
| Rate change leaves nothing behind (P10) | by construction | same | same | same | same |
| Same width at every rate (S5), 16 kHz +12 dB bell | no: 0.34 oct at 44.1 k, 0.96 at 192 k [M] | 1.11 / 1.04 / 0.99 / 1.00 oct at 44.1 / 48 / 96 / 192 k for BW 1; still pinned to 0 dB at half rate [M] | follows analog bell; width 1.005 / 1.003 oct at 96 / 192 k; at 44.1 and 48 k the bell never falls back to half gain below half the rate, so width is undefined [M] | same as B for boosts, and cuts match as well as boosts [M] | matches analog at DC, centre, half rate and the half-gain points; limited to centres roughly half a bandwidth below half the rate [S2] |

Reading: modes A and A-BW keep every property in the ledger. Mode B as printed loses boost-then-cut and "0 dB at half the rate". B+ regains boost-then-cut but not "0 dB at half the rate"; for B and B+ the preamp rule (eq-dsp 4.7, which scans the whole band including half the rate) is unaffected, but any proof that leaned on P2's half-rate value needs re-deriving for B. [REC]

## 5. What this does to the owner's S5 decision

formal-verification asks what "same band at every rate" means (S5 a, b, c). The critic is right that this is coupled to S4 only for option (a) *as printed*. My table gives the real choice:

| S5 option | Keeps cancel (S4a) | Cost |
|---|---|---|
| (a) matched bell as printed | **No**, up to 0.31 dB at 20 kHz (+-6) | Not recommended on its own |
| (a) plus cut-as-inverse (B+) | Yes | One rule in the spec; a minimum-phase check on the boost numerator at load time (the load-time checker is already planned); a "0 dB means skip" rule |
| (b) Orfanidis | Yes, where defined | Cannot place a bell above about 14 to 16 kHz at 44.1 kHz; 0/0 at 0 dB; not read from the original paper |
| (c) cookbook bandwidth form | Yes | Squeezed shape near half the rate remains; width held to within 11 percent at 16 kHz [M] |

[REC] Keep mode A as the default (eq-dsp's recommendation is untouched by this note). If a matched mode is offered, offer B+, not B, and write "cut = inverse of boost" into the ledger as a rule so no future implementer re-derives a cut from scratch.

Context for the size: 0.31 dB at 20 kHz needs a deliberate +6 then -6 stack at the same centre and width at a 16 kHz centre. A preset has no reason to contain that (I did not scan the AutoEq database). The reason to care is the *test*, not the music: P3 is the cheapest exact test oracle the DSP core has, and it only works in modes where it holds. I did not test audibility of 0.3 dB at 20 kHz.

**Two things S4 conflated.** (i) *Digital*: a +g bell then a -g bell with the same centre and width is wire. That is the mode-dependent statement above. (ii) *Physical*: "a correction built as the inverse of a measured peak cancels it" (formal-verification line 115). That was never a theorem in any mode. A headphone's resonance is not a biquad bell, and AutoEq fits bells to it approximately; eq-dsp line 441 already lists "a preset matches a given headphone" as not provable. The critic's "also fails there" merges (i) and (ii).

## 6. "Verified" and the rungs

formal-verification section 2 defines the rungs: E0 untested, E1 "a few inputs behave", E2 "every input in a stated, finite domain was run (a dense grid for a many-input one)", E3 machine-checked proof about real numbers, E4 covers rounding, E5 reaches the binary. Rule 10: "Never write the word 'verified' without a rung." Applying that rule literally:

| Statement | Where | Rung |
|---|---|---|
| ffmpeg `equalizer`/`lowshelf`/`highshelf` equal the cookbook: five test filters, then one ten-filter chain | eq-dsp line 117 | **E1** (a few inputs) |
| HD 600 preset gives AutoEq's -6.3 dB preamp | eq-dsp line 350 | E1 |
| ffmpeg chain equals AutoEq's formulas: 4 profiles x 5 rates, dense in frequency | headphones-today section 6 | **E1** on the settings axis (20 hand-picked cases); dense on the frequency axis only |
| Matched bell: centre gain, DC, stability over 1,620 cases (rates x centres x gains x Q) | eq-dsp line 282 | **E2** (a stated grid) |
| Cookbook: boost times cut flat to 4e-14 dB (+-9 dB, one case) | eq-dsp line 221 | E1 as a number; the claim itself is [D] algebra |
| Cookbook identities (swap, stability, 0 dB at DC and half rate) | eq-dsp 4.13 P1 to P3; formal-verification S2 to S4 | [D] hand derivation, **no rung exists** for this |
| Everything in section 3 above | this note | E2-ish (random sample, 800,000 settings; not a grid) plus [D] |

So the critic is right that "verified" and "proof" are overstated, and right that the strongest numerical rung in these lanes is E2. For the two ffmpeg checks the rule gives E1, not E2. Also `eq-dsp` line 23 defines "Verified" locally as "I ran it, read the source, or measured it", which is not formal-verification's meaning; an owner reading "math verified" will hear E3 or higher. headphones-today already disclaims correctly at line 198 ("numerical evidence rather than a mathematical proof"), but its section title at line 169 says "Proof the math is right".

[REC] Add a rung between E2 and E3 for "derived on paper, not machine-checked" (the lanes tag it [D]) so these statements stop floating outside the ladder. Add a golden test "boost then cut leaves under 1e-9 dB, every mode, whole band to half the rate"; it would have caught this at once.

## 7. What to change, and where

| Document | Lines | Change |
|---|---|---|
| `eq-dsp.md` | 17 (summary item 10) | Say "in the cookbook mode"; list which properties hold per mode (section 4). |
| `eq-dsp.md` | 18, 117, 457, 506 ("math verified", "I verified") | Replace with "formulas matched at the settings I tried (E1); not a proof". |
| `eq-dsp.md` | 431 to 432 (P2, P3) | Tag "mode A". P2's half-rate value and P3 do not hold in mode B as printed. P3 holds in B+. |
| `eq-dsp.md` | 441 | Extend: in mode B, P2 proves "gain at the centre and DC", not "same as the cookbook". |
| `eq-dsp.md` | 282, 312 (4.5, mode B) | Add the cut-as-inverse rule (section 3); note a matched cut designed directly is up to 1.2 dB worse than the inverse-of-boost cut (1.83 versus 0.67 dB, 16 kHz, -12 dB, 44.1 kHz). |
| `formal-verification.md` | 83 to 84, 114 to 116 (S4) | Split S4 into S4a (digital cancel: per mode) and S4b (order). Remove "a correction built as the inverse of a measured peak cancels it" or label it not a theorem. Add a mode column to the ledger. |
| `formal-verification.md` | 118 to 133 (S5), 310, 312 | Option (a) needs the cut rule to keep S4a; ask the owner both questions together. |
| `headphones-today.md` | 169 | Retitle "Evidence the math is right"; state E1. |
| `winamp-better.md` | 18 | "which curve is correct" also needs "what a cut is". Minor. |

The critic cited eq-dsp P10 as the 0 dB identity. In eq-dsp (line 439) P10 is the rate-change property and is correct as written; the identity is in P2 (line 431). No change needed there.

I did not edit any of these files.

## 8. Not done, and UNCONFIRMED

- **Orfanidis's original paper was not read.** The Rutgers link (`http://www.ece.rutgers.edu/~orfanidi/ece348/peq.pdf`, the one Vicanek and eq-dsp cite) returns the department's home page today (fetched and checked). My implementation uses the equations Vicanek prints in section 3.3 and passes the checks in section 4. That the boost and cut come out as exact inverses is my measurement (coefficients agree to 1.3e-15 over 272 in-domain cases); why, and whether Orfanidis states it, is UNCONFIRMED.
- **Equalizer APO's formulas** are still UNCONFIRMED: its configuration page gives syntax only and states no formulas or cookbook. [S4] Mode A being "APO compatible" therefore rests on AutoEq's presets being fitted with the cookbook, as eq-dsp says.
- Slider ramp through 0 dB under B+ (clicks): not measured.
- Audibility of the leftovers: not tested.
- Nothing here is machine-checked; Lean is not usable on this machine today (formal-verification) and no Rocq was present (`coqc` not found).
- I used only read operations on the repository; MPD, the app and its outputs were not touched.

## 9. Sources and scratch

- [S1] R. Bristow-Johnson, Audio EQ Cookbook (W3C copy), https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html (read; Q definition and peaking and shelf formulas checked against my code).
- [S2] M. Vicanek, "Matched Second Order Digital Filters", 14 Feb 2016, https://vicanek.de/articles/BiquadFits.pdf (read in full; equations 12, 28, 29, 42 to 45, and section 3.3 checked on the rendered pages).
- [S3] S. J. Orfanidis, "Digital Parametric Equalizer Design with Prescribed Nyquist-Frequency Gain", JAES 45(6), 444-455, 1997: known only through Vicanek's section 3.3 [S2]. A web search for a copy returned descriptions and patents, not the paper.
- [S4] Equalizer APO configuration reference, https://sourceforge.net/p/equalizerapo/wiki/Configuration%20reference/ (read; silent on formulas).
- Lane documents in this folder: `eq-dsp.md`, `formal-verification.md`, `headphones-today.md`, `winamp-better.md`.
- Scratch (may be wiped): `/tmp/msr-followup-4/work/` (`designs.py` and `exp1.py` to `exp8.py`, outputs `out1.txt` to `out5.txt`), downloads in `/tmp/msr-followup-4/dl/`. Python 3 with NumPy 2.5.3, run in isolated mode.
