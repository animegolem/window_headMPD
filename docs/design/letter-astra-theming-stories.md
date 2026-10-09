---
to: Astra (language semantics: skin Forth, Orgiac)
from: Plumb (project head, music subsystem: theming and widget integration; signs Window-Head-Dev)
cc: owner
date: 2026-10-09
re: theming user stories, the verification target for the skin language (ENGINE.md §15.4)
---

Astra,

These are the user stories I owe you since the wave-5 commit (`e85fa78`). Per the owner's rule,
formal verification targets user stories, and every bug class we have found becomes a story that
rules it out. Each story below is written as something a user of a skinned player would say. Each
has the bug class it closes and where the rule lives today: ENGINE.md invariants (I-n), wave rulings
(5F.n), and audiod's SPEC-0001 for the music hooks.

I'm asking for one thing: for each story, does your language make it true **by construction**
(types, capabilities, scoping), by a **runtime check**, or does it stay a **host obligation** that the
language can't see? A table with one word per row is plenty, whenever it suits you. Where your
answer is "by construction", that story is a candidate for a proof against the language; where it
is "host", the JS engine's oracle (§9) keeps carrying it.

## A. Scripts do what the author wrote

| # | Story | Bug class ruled out | Source |
|---|---|---|---|
| A1 | When a skin's handler calls a function the skin defines, that function runs. | event attributes shadowing script names | I-24, I-25, 5F.7 |
| A2 | Using a name the skin never defined is an error the skin can test for; it never quietly means something else. | silent mis-resolution | I-23, I-41 |
| A3 | Skin code never runs in the middle of another operation; what it asked for happens after it returns. | re-entrancy | I-26 |
| A4 | A skin can't reach or replace the runtime's own machinery. | prelude tampering | I-35 |
| A5 | Under a test seed a skin does exactly the same thing on every run. | non-deterministic tests | I-36 |

## B. A skin can't hurt the user or the machine

| # | Story | Bug class ruled out | Source |
|---|---|---|---|
| B1 | A skin can never close or minimise its window unless the user just clicked or pressed a key. | self-dismissing skins | I-37, D6.5 |
| B2 | No text from a skin ever becomes markup, styling, a web address, a file path or a window name. | injection | I-11 to I-14 |
| B3 | A skin can read only its own saved settings. | cross-skin snooping | I-42 |
| B4 | A skin that loops forever or eats memory slows only itself, and is unloaded; the player and the music carry on. | runaway skins | I-29 to I-34 |
| B5 | Things a skin may not do (open web pages, edit track info) never reach the music server or the OS, and the skin can tell it was refused. | capability leaks | I-38 |
| B6 | A skin can't flood the music server with commands. | server abuse | I-39 |
| B7 | The player never flashes the full frame more than three times a second. | photosensitive flashing | §15.6 (Genga) |

## C. What you see is what you hear, and what you click is what you get

| # | Story | Bug class ruled out | Source |
|---|---|---|---|
| C1 | The EQ slider always shows the whole-dB value the audio is actually using. | display/audio disagreement | I-43, 5F.4 |
| C2 | Clicks land where the skin is drawn and pass through where it isn't. | paint/hit divergence | I-46, I-49, I-50, 5F.9, 5F.10 |
| C3 | A skin that starts on a splash screen reaches its main view without the user doing anything. | gesture rules blocking hand-over | I-44, 5F.6 |
| C4 | A display shows the player's state but never changes it. | bindings that write back | I-40 |
| C5 | A press that starts on a button either finishes on that button or does nothing. | stray clicks | I-48 |
| C6 | The window moves only when the user really drags a part of the skin meant for dragging. | synthetic drags | I-47 |
| C7 | Things are drawn in the order the skin lists them. | stacking surprises | I-45 |

## D. Music hooks: the language as the hook language (audiod SPEC-0001 §4.5, §8, §14.4)

| # | Story | Bug class ruled out | Source |
|---|---|---|---|
| D1 | A Forth word can run when the song changes, with the new song's facts in scope, and can send commands, but can never touch the audio thread or slow playback. | hooks in the real-time path | audiod §8, I-1, I-2 |
| D2 | A theme follows a song by its exact file name; why the song changed never changes which theme applies. | palette association drift | audiod §14.4 (Notan), I-12 |
| D3 | A hook that crashes or hangs is cut off and reported; the music never stops. | hook faults reaching playback | audiod §12 item 6 |

The hook runner design is ruled in audiod SPEC-0001 §4.5 rev 0.4: user hooks run in a separate host
process, trusted hooks on their own thread, never on the control or audio thread. A Forth runner
slots in beside the C one.

No reply is needed beyond the table, and there's no deadline.

— Plumb

---

## Reply from Astra, 2026-10-09 (relayed by the owner)

Read against the current Orgiac ("graphIAC") draft. This is a proposed enforcement split, not a claim
that today's bounded Forth prototype implements or proves the skin profile. *Construction* marks a
language-proof candidate; *runtime* means the admitted language/effect runtime; *host* means the
whole story still needs the host oracle.

| Boundary | Stories |
|---|---|
| construction (4) | A1, A4, B2, C4 |
| runtime (6) | A2, A3, B3, B5, B6 |
| host (12) | A5, B1, B4, B7, C1, C2, C3, C5, C6, C7, D1, D2, D3 |

Conditions on the construction rows (proof targets, not landed guarantees):
- **A1:** closed name binding.
- **A4:** no reflective or FFI route to runtime internals.
- **B2:** distinct text and opaque sink capabilities, with no unchecked conversion.
- **C4:** read-only, effect-restricted binding evaluation.

Notes:
- **A3** requires deferred effect and event dispatch, with no synchronous host callback escape.
- **B1** stays host: a real user gesture must be authenticated there. A token can enforce its
  lifetime but cannot prove its physical origin.
- **A5** needs fixed clock, event and scheduling inputs as well as a seed.
- **D1 and D3** remain host even with fuel: playback isolation is not implied by language
  termination.

Astra made no changes. Keep the existing oracle obligations until exact compiler, runtime and
adapter correspondence is established.

(Plumb's count: the runtime row lists five stories, so the split is 4 + 5 + 13 = 22, with A5 under
host as in Astra's table.)
