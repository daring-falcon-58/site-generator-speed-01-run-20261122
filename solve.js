// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// run(input) returns, for one case's { site, templates, files }, exactly the
// output tree makefun-site 1.0.0's build returns, byte for byte — as a JSON
// object of every path it writes and that file's text. Written from the
// reference spec (its README + code) as a single-pass implementation:
//  - fused block lexer+renderer (no token objects, no second pass),
//  - fused inline scan: one regex jump per construct, and the HTML escapes
//    (& < > " ') are emitted right at the scan hit, so a plain run between
//    hits holds no special character and is pushed raw — no second esc()
//    pass over plain runs (r3; esc was ~15% of r2's time),
//  - string-accumulated output (r3): templates compiled to functions that
//    build their result with += (rope appends, flattened once by the
//    driver's JSON.stringify) instead of chunk-array + join per render;
//    renderMarkdown and inline return strings the same way (the interpreter
//    fallback still uses arrays),
//  - ASCII fast-path slugify (no NFKD normalise for plain-ASCII text),
//  - inline scan by one regex jump per construct, escape searches by
//    indexOf + backslash parity, first-character block dispatch,
//  - word counting by a whitespace table, front matter without splitting
//    the body, front-matter keys parsed manually (no per-line regex),
//  - per-case memo of resolved link paths (fresh Map per build()).
//  - (r4) branchless word counting (a word starts where a non-whitespace
//    char follows whitespace — same table, same count, no branch per char),
//    and block rendering that accumulates its strings directly instead of
//    via intermediate line arrays (fences, blockquotes, lists, paragraphs).
// No cross-case caching: every case is answered alone, from its input only.

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/** `text` with & < > " and ' escaped, in one regex pass. Most calls have no
 * special character at all, so a test first (one C++ scan, no callback, no
 * result built) beats replace alone on those; only the few with a special
 * pay for the replace. */
const ESC_TEST = /[&<>"']/;
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

const SLUG_MAX = 64;
const ASCII_RE = /^[\x00-\x7F]*$/;
const COMBINING_RE = /\p{M}/gu;
/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Pure-ASCII text takes a fast path (NFKD + mark-strip are identities
 * on ASCII, so the result is identical).
 */
function slugify(text) {
  if (ASCII_RE.test(text)) {
    // Collapse runs of non [a-z0-9] to one "-", trim ends, cut at 64, drop a
    // trailing "-" left by the cut: identical to the char loop above it
    // (NFKD + mark-strip are identities on ASCII), in C++ regex passes.
    let out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
    out = out.slice(0, SLUG_MAX);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(COMBINING_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Whitespace code units, by the same set wordsOf used to test one by one. */
const WS_TABLE = (() => {
  const t = new Uint8Array(65536);
  for (const c of [32, 9, 10, 11, 12, 13, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) t[c] = 1;
  for (let c = 0x2000; c <= 0x200a; c++) t[c] = 1;
  return t;
})();

/** The words of a body: its runs of characters other than whitespace.
 * Branchless (r4): a word starts exactly where a non-whitespace char
 * follows a whitespace char (or the start) — same WS_TABLE, same count,
 * no if/else per character. */
function wordsOf(text) {
  let n = 0;
  let prevWs = 1;
  const t = WS_TABLE;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const w = t[text.charCodeAt(i)];
    n += (w ^ 1) & prevWs;
    prevWs = w;
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANK_LINE = /^[ \t]*$/;
const TRAIL_WS = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused.
 */
function parseFrontMatter(text) {
  // lines[0] is "---" exactly when text is "---" or starts with "---\n".
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The closing line is a line "---": "\n---\n" inside, or "\n---" at the end.
  let closeAt = text.indexOf('\n---\n', 3);
  let bodyAt;
  if (closeAt !== -1) bodyAt = closeAt + 5;
  else if (text.endsWith('\n---')) { closeAt = text.length - 4; bodyAt = text.length; }
  else return { error: 'the front matter is not closed' };
  // Only the (small) front-matter region is split; the body stays a slice.
  const fm = text.slice(4, closeAt).split('\n');
  const data = {};
  for (let j = 0; j < fm.length; j++) {
    const line = fm[j];
    if (BLANK_LINE.test(line) || line.startsWith('#')) continue;
    // Manual `key: value` split: the LINE regex /^([a-z_]+):(?: (.*))?$/
    // means one ':' with the key all [a-z_], then end or one space + rest.
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${j + 2} is not "key: value"` };
    let badKey = false;
    for (let q = 0; q < colon; q++) {
      const cc = line.charCodeAt(q);
      if (!((cc >= 97 && cc <= 122) || cc === 95)) { badKey = true; break; }
    }
    if (badKey) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, colon);
    let raw;
    if (colon === line.length - 1) raw = '';
    else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
    else return { error: `line ${j + 2} is not "key: value"` };
    raw = raw.replace(TRAIL_WS, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyAt) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` is blank: empty, or only spaces and tabs. */
function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  return BLANK.test(line);
}

/** Whether `line` closes a fence: ``` then only spaces and tabs. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  return FENCE_CLOSE.test(line);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return line.startsWith('```') && FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether the character at `j` is escaped: an odd run of backslashes before it. */
function isEscaped(s, j) {
  let k = 0;
  while (j - 1 - k >= 0 && s.charCodeAt(j - 1 - k) === 92) k++;
  return (k & 1) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1 && isEscaped(s, j)) j = s.indexOf(what, j + 1);
  return j;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    // Escape first: an escaped * is consumed by its backslash and is never
    // the start of a ** pair (e.g. \\* followed by * is a single star).
    if (isEscaped(s, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline into `out` (an array of string chunks); `env.link`
 * resolves a link's href. Constructs that fail to close stay in the plain
 * run, exactly as the reference renders them literally. The scan jumps from
 * one special character (\\, `, *, [, &, <, >, ", ') to the next with one
 * regex scan instead of stepping every character, and the HTML escapes are
 * emitted right at the scan hit — so a plain run between two hits holds no
 * special character at all and is pushed raw, with no second esc() pass
 * over it (esc was ~15% of r2's time, mostly these runs). One shared regex:
 * every exec is preceded by setting lastIndex, so the recursion into
 * strong/em/link text cannot corrupt an outer scan.
 */
const INLINE_RE = /[\\`*\[&<>"']/g;
function inline(s, env) {
  const re = INLINE_RE;
  let o = '';
  const n = s.length;
  let i = 0;
  let plain = 0;
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m === null) break;
    i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash: escaped only before an escapable character
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) o += s.slice(plain, i);
        const d = s[i + 1];
        o += d === '>' ? '&gt;' : d;
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      // backtick: code span closed by the next backtick (plain indexOf)
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) o += s.slice(plain, i);
        o += '<code>' + esc(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      // *: strong (**...**) or emphasis (*...*)
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) o += s.slice(plain, i);
          o += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) o += s.slice(plain, i);
        o += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      // HTML special inside a plain run: emit its escape at the hit.
      if (i > plain) o += s.slice(plain, i);
      o += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      i++;
      plain = i;
      continue;
    }
    // [: [text](target)
    const k = findUnescaped(s, ']', i + 1);
    const m2 = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !/\s/.test(target)) {
      if (i > plain) o += s.slice(plain, i);
      o += '<a href="' + esc(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
      i = m2 + 1;
      plain = i;
    } else i++;
  }
  if (n > plain) o += s.slice(plain, n);
  return o;
}

/** `s` rendered inline, as one string. */
function inlineStr(s, env) {
  return inline(s, env);
}

/**
 * `src` rendered in one pass over its lines (lex + render fused): its HTML
 * (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line === '' || c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    }
    const fence = c0 === 96 && line.startsWith('```') ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${esc(fence[1])}"`;
      html += `<pre><code${cls}>`;
      while (i < n && !isFenceClose(lines[i])) { html += esc(lines[i]); html += '\n'; i++; }
      i++;
      html += '</code></pre>\n';
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const hhtml = inlineStr(heading.text, env);
      html += `<h${heading.depth} id="${id}">${hhtml}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: hhtml });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line[0] === '>') {
      // The trimmed non-empty lines accumulated directly: identical to
      // inner.join('\n') over the same lines, without the two arrays.
      let inner = '';
      let first = true;
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') { if (!first) inner += '\n'; inner += t; first = false; }
      }
      if (first) html += '<blockquote>\n</blockquote>\n';
      else html += '<blockquote>\n<p>' + inline(inner, env) + '</p>\n</blockquote>\n';
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) ? BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      // Each item as one accumulated string: identical to
      // items[k].join('\n') over the same trimmed lines.
      const items = [];
      let cur = null;
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          if (cur !== null) items.push(cur);
          cur = trimLine(isOrdered ? m[2] : m[1]);
          i++;
        } else if (lines[i].charCodeAt(0) === 32 && lines[i].charCodeAt(1) === 32 && CONTINUED.test(lines[i])) {
          cur += '\n' + trimLine(lines[i]);
          i++;
        } else break;
      }
      if (cur !== null) items.push(cur);
      const start = isOrdered ? Number(ordered[1]) : 1;
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      html += open + '\n';
      for (let k = 0; k < items.length; k++) html += '<li>' + inline(items[k], env) + '</li>\n';
      html += `</${tag}>\n`;
      continue;
    }
    let ptext = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) { ptext += '\n' + trimLine(lines[i]); i++; }
    if (excerpt === null) {
      excerpt = inline(ptext, env);
      html += `<p>${excerpt}</p>\n`;
    } else {
      html += '<p>' + inline(ptext, env) + '</p>\n';
    }
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- template

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template error, rendered as `template "<name>": <reason>`. */
class TemplateError extends Error {
  constructor(name, reason) {
    super(`template "${name}": ${reason}`);
    this.name = 'TemplateError';
  }
}

/** The value path of `text`, or null when it is not a path. */
function pathOf(text) {
  return PATH.test(text) ? text.split('.') : null;
}

/** A template's tokens: text, variables and block tags. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    if (next === '{' && src[open + 2] === '{') {
      const end = src.indexOf('}}}', open + 3);
      if (end === -1) throw new TemplateError(name, 'a {{{ is not closed');
      const path = pathOf(src.slice(open + 3, end).trim());
      if (path === null) throw new TemplateError(name, `${JSON.stringify(src.slice(open + 3, end).trim())} is not a path`);
      text += src.slice(i, open);
      if (text !== '') tokens.push({ kind: 'text', text });
      text = '';
      tokens.push({ kind: 'raw', path });
      i = end + 3;
      continue;
    }
    if (next === '{') {
      const end = src.indexOf('}}', open + 2);
      if (end === -1) throw new TemplateError(name, 'a {{ is not closed');
      const path = pathOf(src.slice(open + 2, end).trim());
      if (path === null) throw new TemplateError(name, `${JSON.stringify(src.slice(open + 2, end).trim())} is not a path`);
      text += src.slice(i, open);
      if (text !== '') tokens.push({ kind: 'text', text });
      text = '';
      tokens.push({ kind: 'var', path });
      i = end + 2;
      continue;
    }
    const end = src.indexOf('%}', open + 2);
    if (end === -1) throw new TemplateError(name, 'a {% is not closed');
    const tag = src.slice(open + 2, end).trim();
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end + 2, lineEnd));
    text += src.slice(i, open);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ kind: 'text', text });
    text = '';
    tokens.push({ kind: 'tag', tag });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end + 2;
  }
  if (text !== '') tokens.push({ kind: 'text', text });
  return tokens;
}

/** A parsed template: the list of its nodes. */
function parseTemplate(name, src) {
  const tokens = tokenize(name, src);
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind !== 'tag') {
      stack[stack.length - 1].body.push(tok);
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m = FOR.exec(tag);
    if (m !== null) {
      const path = pathOf(m[2]);
      if (path === null) throw new TemplateError(name, `${JSON.stringify(m[2])} is not a path`);
      const node = { kind: 'for', name: m[1], path, body: [] };
      top.body.push(node);
      stack.push(node);
      continue;
    }
    m = IF.exec(tag);
    if (m !== null) {
      const path = pathOf(m[2]);
      if (path === null) throw new TemplateError(name, `${JSON.stringify(m[2])} is not a path`);
      const node = { kind: 'if', not: m[1] !== undefined, path, then: [], else: null };
      node.body = node.then;
      top.body.push(node);
      stack.push(node);
      continue;
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(name, 'an else outside an if');
      top.else = [];
      top.body = top.else;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const open = tag.slice(3);
      if (top.kind !== open) throw new TemplateError(name, `an ${tag} with no open ${open}`);
      stack.pop();
      continue;
    }
    m = INCLUDE.exec(tag);
    if (m !== null) {
      top.body.push({ kind: 'include', name: m[1] });
      continue;
    }
    throw new TemplateError(name, `{% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(name, `a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

/** The value of `path` in the innermost scope that has its first name. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as template text: a string itself, a number in JS digits, true/false, an array's items joined by ", ". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as truthy for {% if %}: everything but undefined, null, false, "", 0 and an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` (an array of string chunks), under `scope`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope + one loop object reused across items: rendering is
        // synchronous, so no iteration can observe a mutated scope.
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const vars = { [n.name]: xs[0], loop };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template compile
//
// A parsed template compiled to a plain function
//   fn(out, R, C, D, L, T, E, F, H)
// where out is the chunk array, R the root vars object, C the context
// ({ compiled } map), D the include depth, L the flat locals object holding
// the currently active for-bindings (loop var + loop, save/restored per for),
// T textOf, E esc, F truthy, H Object.hasOwn.
//
// First-segment resolution is exactly lookup()'s: a name bound by an active
// for (in L) wins, else the root vars (R), else undefined — with hasOwn, so
// prototype names (e.g. "constructor") never leak in. Nested segments walk
// with the same null / non-object / hasOwn guards lookup() uses. An include
// renders the compiled callee with the same R and L, so it sees the caller's
// loop variables, exactly as the interpreter does.
// If anything here throws (codegen or new Function), build() falls back to
// the interpreter for the whole case, so a compile failure costs speed only.

let __cgNext = 0;

/** Statements resolving `path` into fresh temp `tv`; returns the temp name. */
function cgPath(lines, path) {
  const tv = `_t${__cgNext++}`;
  const first = JSON.stringify(path[0]);
  lines.push(`let ${tv} = H(L, ${first}) ? L[${first}] : (H(R, ${first}) ? R[${first}] : undefined);`);
  for (let k = 1; k < path.length; k++) {
    const seg = JSON.stringify(path[k]);
    lines.push(`if (${tv} !== null && typeof ${tv} === "object" && H(${tv}, ${seg})) ${tv} = ${tv}[${seg}]; else ${tv} = undefined;`);
  }
  return tv;
}

/** `nodes` compiled into `lines` (statements appending to `out`). */
function cgNodes(lines, nodes) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      lines.push(`_s += ${JSON.stringify(n.text)};`);
    } else if (n.kind === 'var') {
      const tv = cgPath(lines, n.path);
      lines.push(`_s += E(T(${tv}));`);
    } else if (n.kind === 'raw') {
      const tv = cgPath(lines, n.path);
      lines.push(`_s += T(${tv});`);
    } else if (n.kind === 'if') {
      const tv = cgPath(lines, n.path);
      lines.push(`if (F(${tv}) !== ${n.not}) {`);
      cgNodes(lines, n.then);
      if (n.else !== null) {
        lines.push('} else {');
        cgNodes(lines, n.else);
      }
      lines.push('}');
    } else if (n.kind === 'for') {
      const xs = cgPath(lines, n.path);
      const id = __cgNext++;
      const lp = `_lp${id}`;
      const kk = `_k${id}`;
      const hv = `_hv${id}`;
      const ov = `_ov${id}`;
      const hl = `_hl${id}`;
      const ol = `_ol${id}`;
      const name = JSON.stringify(n.name);
      lines.push(`if (Array.isArray(${xs})) {`);
      lines.push(`const ${lp} = { index: 0, first: false, last: false, length: ${xs}.length };`);
      lines.push(`const ${hv} = H(L, ${name}); const ${ov} = L[${name}];`);
      lines.push(`const ${hl} = H(L, "loop"); const ${ol} = L["loop"];`);
      lines.push(`L["loop"] = ${lp};`);
      lines.push(`for (let ${kk} = 0; ${kk} < ${xs}.length; ${kk}++) {`);
      lines.push(`L[${name}] = ${xs}[${kk}]; ${lp}.index = ${kk} + 1; ${lp}.first = ${kk} === 0; ${lp}.last = ${kk} === ${xs}.length - 1;`);
      cgNodes(lines, n.body);
      lines.push('}');
      lines.push(`if (${hv}) L[${name}] = ${ov}; else delete L[${name}];`);
      lines.push(`if (${hl}) L["loop"] = ${ol}; else delete L["loop"];`);
      lines.push('}');
    } else if (n.kind === 'include') {
      const id = __cgNext++;
      lines.push(`if (D < ${INCLUDE_DEPTH}) { const _f${id} = C.compiled.get(${JSON.stringify(n.name)}); if (_f${id} !== undefined) _s += _f${id}(R, C, D + 1, L, T, E, F, H); }`);
    }
  }
}

/** A parsed template's nodes as a callable function (throws on any failure). */
function compileTemplate(nodes) {
  __cgNext = 0;
  const lines = ["let _s = '';"];
  cgNodes(lines, nodes);
  lines.push('return _s;');
  return new Function('R', 'C', 'D', 'L', 'T', 'E', 'F', 'H', lines.join('\n'));
}

// ---------------------------------------------------------------- build

/** A source's card: the fields every list of it shares. */
function cardOf(b, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A post or page's full page view: its card, content, table of contents and neighbours. */
function pageOf(b, s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A neighbour post as a link, or null. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** A tag as a page sees it: name, slug, url, count and its posts' cards. */
function tagOf(b, t) {
  return {
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
    posts: t.posts.map((p) => b.cards.get(p)),
  };
}

/** `s`'s own tags: its tag names, each slug once, the first spelling kept. */
function ownTags(s) {
  const seen = new Set();
  const out = [];
  for (const name of s.data.tags ?? []) {
    const slug = slugify(name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ name, slug });
  }
  return out;
}

/** Everything makefun-site 1.0.0's `build` returns for one case's input. */
function build(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (e) {
      if (e instanceof TemplateError) report.push(e.message);
      else throw e;
    }
  }
  const b = {
    input, base, templates, report,
    sources: [], statics: [], bySource: new Map(), broken: new Set(),
    posts: [], tags: [], cards: new Map(), output: {},
  };

  // Sources first, sorted by path in code-unit order; only .md is a source.
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, content: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else b.statics.push(f);
  }

  // Front matter: refused sources are reported and dropped.
  const kept = [];
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const parsed = parseFrontMatter(s.content);
    if ('error' in parsed) {
      b.report.push(`refused ${s.path}: ${parsed.error}`);
      continue;
    }
    s.data = parsed.data;
    s.body = parsed.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && s.data.date === undefined) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    s.layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(s.layout)) {
      b.report.push(`refused ${s.path}: layout "${s.layout}" is no template that parses`);
      continue;
    }
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // Permalinks: one slug per source, unique in its directory.
  const taken = new Map([['', new Set(RESERVED)]]);
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set();
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // Markdown: every source's body, links resolved against its directory.
  // Resolved relative paths repeat a lot (assets, index links): memoize
  // them per case (fresh Map per build(), never shared across cases).
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const resolveCache = new Map();
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const dir = dirOf(s.path);
    const env = {
      link(target) {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path;
        if (rel === '') path = null;
        else {
          const ck = dir + '\0' + rel;
          if (resolveCache.has(ck)) path = resolveCache.get(ck);
          else { path = resolvePath(dir, rel); resolveCache.set(ck, path); }
        }
        if (path !== null && b.bySource.has(path)) return b.bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const rendered = renderMarkdown(s.body, env);
    s.html = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
  }

  // Collections: posts newest first, equal dates by slug; neighbours.
  b.posts = b.sources.filter((s) => s.post);
  b.posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < b.posts.length; k++) {
    const p = b.posts[k];
    p.newer = k === 0 ? null : b.posts[k - 1];
    p.older = k === b.posts.length - 1 ? null : b.posts[k + 1];
  }

  // Tags: each post's own tags in its own order, the first spelling kept,
  // named after the first post carrying it; ordered by post count, then slug.
  const bySlug = new Map();
  for (let k = 0; k < b.posts.length; k++) {
    const p = b.posts[k];
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    if (s.post) continue;
    s.tagRefs = [];
    for (const { name, slug } of ownTags(s)) {
      const tag = bySlug.get(slug);
      s.tagRefs.push(tag !== undefined ? tag : { name, slug, url: '', posts: [] });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every source through its layout; index, tag and tags pages.
  const site = { title: input.site.title, base_url: base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, input.site.recent).map((p) => cardOf(b, p));
  // Compile the parsed templates once per case; any failure falls back to
  // the interpreter for the whole case (correctness first, speed second).
  const compiled = new Map();
  let useCompiled = true;
  for (const [tname, tnodes] of b.templates) {
    try {
      compiled.set(tname, compileTemplate(tnodes));
    } catch {
      useCompiled = false;
      break;
    }
  }
  const ctx = { templates: b.templates, compiled };
  const render = (name, vars) => {
    const R = { site, tags: allTags, recent, ...vars };
    if (useCompiled) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      return fn(R, ctx, 0, {}, textOf, esc, truthy, Object.hasOwn);
    }
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: R, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const card = cardOf(b, s);
    if (s.post) b.cards.set(s, card);
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s, card) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let k = 0; k < b.tags.length; k++) {
    const t = b.tags[k];
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;

  // Static files at their own path, unless a built page already has it.
  for (let k = 0; k < b.statics.length; k++) {
    const f = b.statics[k];
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // Report: every report line and broken link, sorted, then the summary.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let k = 0; k < b.sources.length; k++) if (!b.sources[k].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = lines.join('\n') + '\n';
  return b.output;
}

/** The harness calls `run` for each case: the output tree for its input. */
export function run(input) {
  return build(input);
}
