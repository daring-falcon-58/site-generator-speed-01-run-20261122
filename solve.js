// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// run(input) returns, for one case's { site, templates, files }, exactly the
// output tree makefun-site 1.0.0's build returns, byte for byte — as a JSON
// object of every path it writes and that file's text. Written from the
// reference spec (its README + code) as a single-pass implementation:
//  - fused block lexer+renderer (no token objects, no second pass),
//  - bulk-escape inline renderer (plain runs escaped in one replace, not
//    one regex call per character),
//  - ASCII fast-path slugify (no NFKD normalise for plain-ASCII text),
//  - allocation-light template walk (array output + join).
// No cross-case caching: every case is answered alone, from its input only.

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/** `text` with & < > " and ' escaped, in one regex pass. */
function esc(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
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
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
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

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
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
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (BLANK_LINE.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(TRAIL_WS, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
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
const TRIM = /^[ \t]+|[ \t]+$/g;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return BLANK.test(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR.test(line);
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => line.replace(TRIM, '');

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline into `out` (an array of string chunks); `env.link`
 * resolves a link's href. Plain runs are escaped in bulk — one regex pass
 * per run, never one call per character. Constructs that fail to close stay
 * in the plain run, exactly as the reference renders them literally.
 */
function inline(s, env, out) {
  const n = s.length;
  let i = 0;
  let plain = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash: escaped only before an escapable character
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) out.push(esc(s.slice(plain, i)));
        const d = s[i + 1];
        out.push(d === '>' ? '&gt;' : d);
        i += 2;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      // backtick: code span closed by the next backtick (plain indexOf)
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) out.push(esc(s.slice(plain, i)));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
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
          if (i > plain) out.push(esc(s.slice(plain, i)));
          out.push('<strong>');
          inline(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) out.push(esc(s.slice(plain, i)));
        out.push('<em>');
        inline(s.slice(i + 1, j), env, out);
        out.push('</em>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === 91) {
      // [: [text](target)
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > plain) out.push(esc(s.slice(plain, i)));
        out.push('<a href="', esc(env.link(target)), '">');
        inline(s.slice(i + 1, k), env, out);
        out.push('</a>');
        i = m + 1;
        plain = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (n > plain) out.push(esc(s.slice(plain, n)));
}

/** `s` rendered inline, as one string. */
function inlineStr(s, env) {
  const out = [];
  inline(s, env, out);
  return out.join('');
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
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (BLANK.test(line)) {
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${esc(fence[1])}"`;
      out.push(`<pre><code${cls}>`);
      for (let k = 0; k < body.length; k++) out.push(esc(body[k]), '\n');
      out.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, env);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const inner = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') inner.push(t);
      }
      if (inner.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inline(inner.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const start = isOrdered ? Number(ordered[1]) : 1;
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      out.push(open, '\n');
      for (let k = 0; k < items.length; k++) {
        out.push('<li>');
        inline(items[k].join('\n'), env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    if (excerpt === null) {
      const html = inlineStr(body.join('\n'), env);
      excerpt = html;
      out.push(`<p>${html}</p>\n`);
    } else {
      out.push('<p>');
      inline(body.join('\n'), env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
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
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
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
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, content: f.content.replace(/\r\n?/g, '\n') });
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
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const dir = dirOf(s.path);
    const env = {
      link(target) {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
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
  const ctx = { templates: b.templates };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
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
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = lines.join('\n') + '\n';
  return b.output;
}

/** The harness calls `run` for each case: the output tree for its input. */
export function run(input) {
  return build(input);
}
