// @ts-check
// The coverage ledger (E D6.7, §5.5 `Ledger`). Every stub, denied call, unknown member, unknown tag,
// unresolved binding or resource and soft-fault site that a skin reaches is recorded here, once per
// (skin, api, kind), with a running count. `tools/corpus.mjs` renders the entries into
// docs/coverage/ledger.md, and stubs are implemented in the order the corpus hits them (notan Q3).
// Coverage is measured, never asserted.
//
// Skins choose the strings that arrive here (`player.<anything>` is an unknown member), so the store
// is a Map keyed by a joined string, and it is capped: a skin that walks a million made-up member
// names fills a bounded table plus one overflow counter, not memory.

/** @typedef {import('../contracts').Ledger} Ledger */
/** @typedef {import('../contracts').LedgerEntry} LedgerEntry */

/** Distinct (api, kind) pairs kept per skin. The corpus's busiest skin touches a few hundred. */
export const MAX_LEDGER_ENTRIES = 2048;
const MAX_API_CHARS = 128;
const MAX_DETAIL_CHARS = 256;

/** The api name the overflow counter is filed under. */
export const OVERFLOW_API = '(overflow)';

/** @param {unknown} s @param {number} max */
const clip = (s, max) => {
  const text = String(s);
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
};

/**
 * One ledger per skin session, so the skin's SHA-256 is not part of a key: the (sha, api) pair of
 * E D6.7 is this object plus the api string. `skinSha` is accepted for the contract's signature and
 * to label diagnostics. `record` returns whether the pair was new; callers must not depend on that,
 * because the contract types it `void` and any `Ledger` can stand in for this one.
 * @type {import('../contracts').CreateLedgerFn}
 */
export const createLedger = (skinSha) => {
  void skinSha;
  /** @type {Map<string, LedgerEntry>} insertion order is first-seen order */
  const table = new Map();
  /** @type {LedgerEntry | null} */
  let overflow = null;

  return {
    record(api, kind, detail) {
      const name = clip(api, MAX_API_CHARS);
      const key = `${kind}\u0000${name}`;
      const known = table.get(key);
      if (known) {
        known.count++;
        return false;
      }
      if (table.size >= MAX_LEDGER_ENTRIES) {
        overflow ??= { api: OVERFLOW_API, kind: 'cap', count: 0, detail: `more than ${MAX_LEDGER_ENTRIES} distinct entries; the rest are only counted` };
        overflow.count++;
        return false;
      }
      /** @type {LedgerEntry} */
      const entry = { api: name, kind, count: 1 };
      if (detail !== undefined) entry.detail = clip(detail, MAX_DETAIL_CHARS);
      table.set(key, entry);
      return true;
    },

    entries() {
      const out = [...table.values(), ...(overflow ? [overflow] : [])];
      return out.map((e) => ({ ...e }));          // copies: a caller cannot change the counts
    },
  };
};
