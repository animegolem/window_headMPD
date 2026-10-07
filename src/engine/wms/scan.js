// @ts-check
// The tolerant `.wms` scanner (ENGINE.md D5 "Scanner", §5.2 `scanWms`). A hand-written tokenizer over
// the decoded string, not an XML parser: 79 of 195 distinct corpus skins are not well-formed XML
// (`survey 2.2`), and WMP read them anyway. It repairs what the corpus needs, reports each repair as
// a diagnostic, and never throws.
//
// What it does, in the order of D5's rules:
//   1. skips comments, `<? ... ?>`, `<! ... >` and every run of text (text content is never used);
//   2. folds tag and attribute names to lower case, accepts `name="v"`, `name='v'`, spaces or tabs
//      around `=`, missing whitespace between attributes (the one of these that is reported), and an
//      unquoted value that runs to whitespace or `>` (accepted silently, like single quotes);
//   3. decodes the five predefined entities and numeric references in attribute values only;
//   4. keeps one attribute per name: the first one's position, the last one's value and line
//      (U-5). The attribute list is therefore in the order names first appeared;
//   5. matches a close tag to the nearest open tag of the same name ignoring case, ignores an orphan
//      close tag, and stops after the first close of the root (G5);
//   6. keeps unknown tags and attributes as ordinary nodes (G12). Naming them is the builder's job,
//      so this module has no tag table and never says `unknown-tag`.
//
// It enforces no structural caps (E §10 gives the element, depth and attribute caps to `wms/build.js`,
// which must see an over-cap tree to diagnose it), but it is iterative throughout: a deeply nested
// or truncated file costs memory proportional to its size and no call stack.
//
// Diagnostic codes, all with a 1-based `line`:
//   duplicate-attribute       the same attribute spelled the same way twice (67 corpus skins)
//   duplicate-attribute-case  a repeat that differs only in case, `toolTip` then `tooltip` (8 skins)
//   missing-whitespace        `a="1"b="2"` (22 skins)
//   end-tag-case              `<Buttongroup>` closed by `</buttongroup>` (12 skins)
//   junk-after-root           anything but whitespace and comments after the root closed (1 skin)
//   orphan-close-tag          a close tag that matches no open tag
//   unclosed-tag              an element closed implicitly by an ancestor's close tag, or still open
//                             at the end of the text
//   unterminated-tag / unterminated-comment / unterminated-value / no-root    truncated or empty text
//   stray-character / valueless-attribute                                     other leniencies
//   diagnostics-truncated     one code hit MAX_PER_CODE and the rest were dropped

/** @typedef {import('../contracts').RawNode} RawNode */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */

/** A hostile file could otherwise turn every attribute into a diagnostic. */
const MAX_PER_CODE = 500;
/** Longest skin-controlled snippet quoted in a diagnostic's `detail`. */
const CLIP = 48;

const CH_TAB = 9;
const CH_LF = 10;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_BANG = 33;
const CH_DQUOTE = 34;
const CH_SQUOTE = 39;
const CH_SLASH = 47;
const CH_LT = 60;
const CH_EQ = 61;
const CH_GT = 62;
const CH_QUESTION = 63;

/** XML whitespace plus vertical tab and form feed. @param {number} c */
const isSpace = (c) => c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR || c === 11 || c === 12;

/** First character of a tag name after `<`; anything else makes the `<` plain text. @param {number} c */
const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c >= 128;

/** A tag name ends at whitespace, `>`, `/` or the next `<`. @param {number} c */
const isTagNameEnd = (c) => isSpace(c) || c === CH_GT || c === CH_SLASH || c === CH_LT;

/** An attribute name additionally ends at `=` and at quotes. @param {number} c */
const isAttrNameEnd = (c) => isTagNameEnd(c) || c === CH_EQ || c === CH_DQUOTE || c === CH_SQUOTE;

/** ASCII-only fold: `toLowerCase` also maps U+212A KELVIN SIGN onto `k`. @param {string} s */
const fold = (s) => (/[A-Z]/.test(s) ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s);

/** @param {string} s */
const clip = (s) => (s.length > CLIP ? `${s.slice(0, CLIP)}...` : s);

// A Map, not an object literal: the name between `&` and `;` is skin text, and `&constructor;` must
// not find an inherited member.
const NAMED_ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);
const ENTITY = /&(?:#([0-9]{1,10})|#[xX]([0-9a-fA-F]{1,8})|([A-Za-z][A-Za-z0-9]*));/g;

/**
 * Code points a reference may produce. `String.fromCodePoint` throws above 0x10FFFF, NUL would end a
 * string for any native consumer, and a lone surrogate is not text.
 * @param {number} cp
 */
const isReferenceable = (cp) => cp >= 1 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);

/**
 * Entity decoding, one pass: `&amp;lt;` becomes `&lt;`, not `<`. A bare `&`, an unknown name and an
 * out-of-range number stay as written.
 * @param {string} s
 */
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY, (whole, dec, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES.get(name) ?? whole;
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return isReferenceable(cp) ? String.fromCodePoint(cp) : whole;
  });
}

/**
 * @typedef {{ node: RawNode, raw: string }} Open  an open element and its tag as written, which
 *   `end-tag-case` compares with the close tag
 * @typedef {{ index: number, spellings: Set<string> }} Seen  where an attribute name first landed, and
 *   every way it has been spelled so far (a Set: k case variants of one name must cost O(k), not O(k^2))
 */

/** @type {import('../contracts').ScanWmsFn} */
export const scanWms = (text) => {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @type {Map<string, number>} */
  const perCode = new Map();
  /**
   * @param {string} code @param {'info'|'warn'|'error'} severity @param {string} detail @param {number} line
   */
  const diag = (code, severity, detail, line) => {
    const count = (perCode.get(code) ?? 0) + 1;
    perCode.set(code, count);
    if (count <= MAX_PER_CODE) diagnostics.push({ code, detail, severity, line });
    else if (count === MAX_PER_CODE + 1) {
      diagnostics.push({ code: 'diagnostics-truncated', severity: 'info', line,
        detail: `further "${code}" diagnostics dropped after ${MAX_PER_CODE}` });
    }
  };

  const n = text.length;

  // Line numbers count LF, and a CR that is not followed by LF. Every query is at or after the
  // previous one, so a single running counter replaces a table of line starts.
  let linePos = 0;
  let line = 1;
  /** @param {number} pos */
  const lineAt = (pos) => {
    while (linePos < pos) {
      const c = text.charCodeAt(linePos++);
      if (c === CH_LF || (c === CH_CR && text.charCodeAt(linePos) !== CH_LF)) line++;
    }
    return line;
  };

  /** @type {RawNode | null} */
  let root = null;
  /** @type {Open[]} */
  const stack = [];
  // How many times each folded tag name is on the stack. A close tag whose name is not there is an
  // orphan and is dismissed without walking the stack, so `</b>` repeated under a deep `<a>` chain
  // costs O(1) each instead of O(depth).
  /** @type {Map<string, number>} */
  const openCount = new Map();
  let done = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  /**
   * Parse the start tag whose `<` is at `start`; returns the index after it.
   * @param {number} start
   */
  const openTag = (start) => {
    const tagLine = lineAt(start);
    let p = start + 1;
    while (p < n && !isTagNameEnd(text.charCodeAt(p))) p++;
    const raw = text.slice(start + 1, p);
    /** @type {RawNode} */
    const node = { tag: fold(raw), attrs: [], children: [], line: tagLine };
    /** @type {Map<string, Seen> | null} */
    let seen = null;
    let selfClosed = false;

    for (;;) {
      while (p < n && isSpace(text.charCodeAt(p))) p++;
      if (p >= n) {
        diag('unterminated-tag', 'error', `<${clip(raw)}> is not closed before the end of the text`, tagLine);
        break;
      }
      const c = text.charCodeAt(p);
      if (c === CH_GT) { p++; break; }
      if (c === CH_SLASH) {
        let r = p + 1;
        while (r < n && isSpace(text.charCodeAt(r))) r++;
        if (text.charCodeAt(r) === CH_GT) { p = r + 1; selfClosed = true; break; }
        diag('stray-character', 'warn', `"/" inside <${clip(raw)}>`, lineAt(p));
        p++;
        continue;
      }
      if (c === CH_LT) {
        // The author forgot a `>`. The next tag starts here; keep this element open.
        diag('unterminated-tag', 'error', `<${clip(raw)}> runs into the next tag`, tagLine);
        break;
      }

      const nameStart = p;
      while (p < n && !isAttrNameEnd(text.charCodeAt(p))) p++;
      if (p === nameStart) {
        // A quote or `=` where a name belongs. Skip it so the loop always advances.
        diag('stray-character', 'warn', `"${text[p]}" inside <${clip(raw)}>`, lineAt(p));
        p++;
        continue;
      }
      const rawName = text.slice(nameStart, p);
      const nameLine = lineAt(nameStart);

      let r = p;
      while (r < n && isSpace(text.charCodeAt(r))) r++;
      let value = '';
      let closesTag = false;
      if (text.charCodeAt(r) === CH_EQ) {
        r++;
        while (r < n && isSpace(text.charCodeAt(r))) r++;
        const q = text.charCodeAt(r);
        if (q === CH_DQUOTE || q === CH_SQUOTE) {
          const end = text.indexOf(q === CH_DQUOTE ? '"' : "'", r + 1);
          if (end < 0) {
            value = text.slice(r + 1);
            p = n;
            diag('unterminated-value', 'error', `${clip(rawName)} on <${clip(raw)}> has no closing quote`, nameLine);
          } else {
            value = text.slice(r + 1, end);
            p = end + 1;
            // `a="1"b="2"`: the next attribute starts with no whitespace in between.
            if (p < n && !isAttrNameEnd(text.charCodeAt(p))) {
              diag('missing-whitespace', 'warn', `no space after ${clip(rawName)}="..." on <${clip(raw)}>`, lineAt(p));
            }
          }
        } else {
          let e = r;
          while (e < n && !isSpace(text.charCodeAt(e)) && text.charCodeAt(e) !== CH_GT) e++;
          value = text.slice(r, e);
          p = e;
          // `<a id=b/>`: a value never ends in the slash that closes the element, or the element
          // would stay open and swallow its siblings.
          if (text.charCodeAt(e) === CH_GT && value.endsWith('/')) {
            value = value.slice(0, -1);
            closesTag = true;
          }
        }
      } else {
        diag('valueless-attribute', 'warn', `${clip(rawName)} on <${clip(raw)}> has no value`, nameLine);
      }

      const folded = fold(rawName);
      const decoded = decodeEntities(value);
      const prior = seen?.get(folded);
      if (prior) {
        // Same name again. U-5: the second value is the author's intent. Position stays where the
        // name first appeared, so evaluation order of one element's attributes does not depend on
        // which copy won.
        const attr = node.attrs[prior.index];
        attr.value = decoded;
        attr.line = nameLine;
        const exact = prior.spellings.has(rawName);
        if (!exact) prior.spellings.add(rawName);
        diag(exact ? 'duplicate-attribute' : 'duplicate-attribute-case', 'warn',
          `${clip(rawName)} repeated on <${clip(raw)}>; the last value wins`, nameLine);
      } else {
        (seen ??= new Map()).set(folded, { index: node.attrs.length, spellings: new Set([rawName]) });
        node.attrs.push({ name: folded, value: decoded, line: nameLine });
      }

      if (closesTag) { p++; selfClosed = true; break; } // p is on the `>`
    }

    const parent = stack.length ? stack[stack.length - 1].node : null;
    if (parent) parent.children.push(node);
    else root ??= node;
    if (selfClosed) {
      if (!parent) done = true;
    } else {
      stack.push({ node, raw });
      openCount.set(node.tag, (openCount.get(node.tag) ?? 0) + 1);
    }
    return p;
  };

  /**
   * Handle the close tag whose `</` is at `start`; returns the index after it.
   * @param {number} start
   */
  const closeTag = (start) => {
    const closeLine = lineAt(start);
    let p = start + 2;
    while (p < n && isSpace(text.charCodeAt(p))) p++;
    const nameStart = p;
    while (p < n && !isTagNameEnd(text.charCodeAt(p))) p++;
    const raw = text.slice(nameStart, p);
    while (p < n && text.charCodeAt(p) !== CH_GT && text.charCodeAt(p) !== CH_LT) p++;
    if (text.charCodeAt(p) === CH_GT) p++;
    else diag('unterminated-tag', 'error', `</${clip(raw)}> has no closing ">"`, closeLine);

    const folded = fold(raw);
    if ((openCount.get(folded) ?? 0) === 0) {
      diag('orphan-close-tag', 'warn', `</${clip(raw)}> closes nothing and is ignored`, closeLine);
      return p;
    }
    // The count is above zero, so this walk stops at a match, and every entry it passes is popped
    // below: the cost is amortised O(1) per element pushed.
    let at = stack.length - 1;
    while (stack[at].node.tag !== folded) at--;
    for (let k = stack.length - 1; k > at; k--) {
      diag('unclosed-tag', 'warn',
        `<${clip(stack[k].raw)}> from line ${stack[k].node.line} is closed implicitly by </${clip(raw)}>`, closeLine);
    }
    if (stack[at].raw !== raw) {
      diag('end-tag-case', 'warn', `<${clip(stack[at].raw)}> is closed by </${clip(raw)}>`, closeLine);
    }
    for (let k = at; k < stack.length; k++) {
      const tag = stack[k].node.tag;
      openCount.set(tag, /** @type {number} */ (openCount.get(tag)) - 1);
    }
    stack.length = at;
    if (at === 0) done = true;
    return p;
  };

  while (i < n && !done) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    const c1 = text.charCodeAt(i + 1);
    if (c1 === CH_BANG) {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end < 0) {
          diag('unterminated-comment', 'error', 'a comment is not closed before the end of the text', lineAt(i));
          i = n;
        } else i = end + 3;
      } else if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9);
        i = end < 0 ? n : end + 3;
      } else {
        const end = text.indexOf('>', i + 2);
        i = end < 0 ? n : end + 1;
      }
    } else if (c1 === CH_QUESTION) {
      const end = text.indexOf('?>', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c1 === CH_SLASH) {
      i = closeTag(i);
    } else if (isNameStart(c1)) {
      i = openTag(i);
    } else {
      i++; // a `<` that starts no tag is text
    }
  }

  if (done) {
    // G5: nothing after the root's close tag counts. Whitespace and comments are fine; the first
    // other thing is reported once, and scanning ends either way.
    let j = i;
    for (;;) {
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (j >= n) break;
      if (text.startsWith('<!--', j)) {
        const end = text.indexOf('-->', j + 4);
        if (end < 0) break;
        j = end + 3;
      } else if (text.startsWith('<?', j)) {
        const end = text.indexOf('?>', j + 2);
        if (end < 0) break;
        j = end + 2;
      } else {
        diag('junk-after-root', 'warn', `unexpected text after the root element: ${JSON.stringify(clip(text.slice(j, j + CLIP + 1)))}`, lineAt(j));
        break;
      }
    }
  } else if (!root) {
    diag('no-root', 'error', 'the text has no element', 1);
  } else {
    const endLine = lineAt(n);
    for (let k = stack.length - 1; k >= 0; k--) {
      diag('unclosed-tag', 'warn', `<${clip(stack[k].raw)}> from line ${stack[k].node.line} is still open at the end of the text`, endLine);
    }
  }

  return { root, diagnostics };
};
