// sitegen v1 — fused single-pass Markdown + compiled templates, byte-exact vs makefun-site 1.0.0.
// Design: see ../BLUEPRINT.md (written after fleet verification). This file is the fleet dev
// implementation; the submitted entry is authored fresh from the blueprint, never copied raw.

// ---------------------------------------------------------------- text
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
export function escapeHtml(text) { return text.replace(ESC_RE, (c) => ESCAPES[c]); }

const NONASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;
const slugCache = new Map();
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  // ASCII-only input: NFKD is the identity and there are no combining marks, so the
  // normalise + mark-strip step is a provable no-op and is skipped.
  const plain = NONASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDateCache = new Map();
export function longDate(date) {
  const hit = longDateCache.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  longDateCache.set(date, out);
  return out;
}

// Exact /\S+/ run count, hand-scanned: no regex, no match-array allocation.
// Whitespace set is exactly JS \s (White_Space + LineTerminator); no astral member exists.
function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
      (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter (indexOf-driven; body via slice, no split/join)
const KEYS_SET = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

export function parseFrontMatter(text) {
  // lines[0] must be exactly '---'
  if (text.length < 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-') return { error: 'no front matter' };
  if (text.length === 3) return { error: 'the front matter is not closed' };
  if (text[3] !== '\n') return { error: 'no front matter' };
  // find the closing '---' line: a '\n---' whose next char is '\n' or end-of-text
  let closeStart = -1;
  let closeEnd = -1;
  let from = 4;
  for (;;) {
    const k = text.indexOf('\n---', from);
    if (k === -1) break;
    const after = k + 4;
    if (after === text.length || text[after] === '\n') { closeStart = k + 1; closeEnd = after; break; }
    from = k + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = 4;
  let i = 1; // 0-based line index of the line starting at p
  while (p < closeStart) {
    const q = text.indexOf('\n', p);
    const end = q === -1 ? closeStart - 1 : q; // line ends before '\n'; last FM line ends at closeStart-1 ('\n')
    const line = text.slice(p, end);
    if (!/^[ \t]*$/.test(line) && line.charCodeAt(0) !== 35) { // not blank, not '#'-comment
      // hand-parse /^([a-z_]+):(?: (.*))?$/
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      if (j === 0 || j >= line.length || line[j] !== ':') return { error: `line ${i + 1} is not "key: value"` };
      const key = line.slice(0, j);
      const rest = line.slice(j + 1);
      let raw;
      if (rest === '') raw = '';
      else if (rest[0] === ' ') raw = rest.slice(1);
      else return { error: `line ${i + 1} is not "key: value"` };
      raw = raw.replace(/[ \t]+$/, '');
      if (!KEYS_SET.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (q === -1) break;
    p = q + 1;
    i++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown: fused single pass
const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

const GT_RE = /^> ?/;
const WS_RE = /\s/;

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}
// First-char dispatch: a line can only end a paragraph (blank / fence / heading / hr)
// when its first character allows it; anything else is paragraph text.
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 96) return FENCE_OPEN.test(line); // '`'
  if (c === 35) return headingOf(line) !== null; // '#'
  if (c === 45) return HR.test(line); // '-': '---' is a break; '- x' is not
  if (c === 42) return HR.test(line); // '*': '***' is a break; '* x' is not
  return false;
}
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

const ESCAPABLE_STR = '\\`*_[]()#+-.!>';
// Is position k consumed by a backslash-escape pair that starts in [from, k)?
// (Sequential escape parsing, reproduced with indexOf jumps instead of a char loop.)
function escapedAt(s, from, k) {
  let b = from;
  for (;;) {
    const bs = s.indexOf('\\', b);
    if (bs === -1 || bs >= k) return false;
    if (bs + 1 < s.length && ESCAPABLE_STR.includes(s[bs + 1])) {
      b = bs + 2;
      if (b > k) return true;
    } else b = bs + 1;
  }
}
// First index >= from where `what` occurs outside a backslash escape, or -1.
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    if (!escapedAt(s, j, k)) return k;
    j = k + 1;
  }
}
// First single * >= from (a * whose run is not **), outside an escape, or -1.
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    if (escapedAt(s, j, k)) { j = k + 1; continue; }
    if (s[k + 1] === '*') { j = k + 2; continue; }
    return k;
  }
}

// One regex finds the next interesting character; the text between two specials holds
// no escapable character, so it is appended verbatim — no per-char escaping, no second pass.
const INLINE_RE = /\\|`|\*|\[|[&<>"']/g;

function inline(s, env) {
  const out = [];
  let i = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null) {
    const k = m.index;
    if (k > i) out.push(s.slice(i, k));
    const c = s[k];
    if (c === '\\') {
      const n = s[k + 1];
      if (n !== undefined && ESCAPABLE_STR.includes(n)) { out.push(ESCAPES[n] ?? n); i = k + 2; }
      else { out.push('\\'); i = k + 1; }
    } else if (c === '`') {
      const j = s.indexOf('`', k + 1);
      if (j > k + 1) { out.push('<code>', escapeHtml(s.slice(k + 1, j)), '</code>'); i = j + 1; }
      else { out.push('`'); i = k + 1; }
    } else if (c === '*') {
      if (s[k + 1] === '*') {
        const j = findUnescaped(s, '**', k + 2);
        if (j > k + 2) { out.push('<strong>', inline(s.slice(k + 2, j), env), '</strong>'); i = j + 2; }
        else { out.push('**'); i = k + 2; }
      } else {
        const j = findSingleStar(s, k + 1);
        if (j > k + 1) { out.push('<em>', inline(s.slice(k + 1, j), env), '</em>'); i = j + 1; }
        else { out.push('*'); i = k + 1; }
      }
    } else if (c === '[') {
      const cl = findUnescaped(s, ']', k + 1);
      const m2 = cl !== -1 && s[cl + 1] === '(' ? s.indexOf(')', cl + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(cl + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(k + 1, cl), env), '</a>');
        i = m2 + 1;
      } else { out.push('['); i = k + 1; }
    } else { // one of & < > " '
      out.push(ESCAPES[c]);
      i = k + 1;
    }
    INLINE_RE.lastIndex = i;
  }
  if (i < s.length) out.push(s.slice(i));
  return out.join('');
}

export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // A space/tab-first line is blank or a paragraph line (never fence/heading/hr/list).
      if (BLANK.test(line)) { i++; continue; }
    } else if (c0 === 96) { // '`': only a fence can start here
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : escapeHtml(`${body.join('\n')}\n`)}</code></pre>\n`);
        continue;
      }
    } else if (c0 === 35) { // '#': heading or paragraph
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // '-' / '*': hr, bullet, or paragraph
      if (HR.test(line)) { blocks.push('<hr>\n'); i++; continue; }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < n) {
          const mm = BULLET.exec(lines[i]);
          if (mm !== null) { items.push([trimLine(mm[1])]); i++; }
          else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        let html = '<ul>\n';
        for (const item of items) html += `<li>${inline(item.join('\n'), env)}</li>\n`;
        html += '</ul>\n';
        blocks.push(html);
        continue;
      }
    } else if (c0 === 62) { // '>': blockquote
      const body = [];
      while (i < n && QUOTE.test(lines[i])) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') kept.push(t); }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // digit: ordered list or paragraph
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        const items = [];
        while (i < n) {
          const mm = ORDERED.exec(lines[i]);
          if (mm !== null) { items.push([trimLine(mm[2])]); i++; }
          else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
          else break;
        }
        const start = Number(ordered[1]);
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let html = `${open}\n`;
        for (const item of items) html += `<li>${inline(item.join('\n'), env)}</li>\n`;
        html += '</ol>\n';
        blocks.push(html);
        continue;
      }
    }
    // paragraph: this line plus following lines until a blank / fence / heading / hr
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates: parse (reference logic) + compile to ops
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
export const INCLUDE_DEPTH = 8;

export class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Prebuilt lookup closures over the FLATTENED scope object (one vars object per render;
// for-loops mutate it and restore, so a lookup is a single own-property check + walk).
function makeGetter(path) {
  if (path.length === 1) {
    const a = path[0];
    return (vars) => (Object.hasOwn(vars, a) ? vars[a] : undefined);
  }
  if (path.length === 2) {
    const a = path[0];
    const b = path[1];
    return (vars) => {
      const v = Object.hasOwn(vars, a) ? vars[a] : undefined;
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
      return v[b];
    };
  }
  const segs = path;
  return (vars) => {
    let v = Object.hasOwn(vars, segs[0]) ? vars[segs[0]] : undefined;
    for (let k = 1; k < segs.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, segs[k])) return undefined;
      v = v[segs[k]];
    }
    return v;
  };
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// op kinds: 0 var/raw, 1 if, 2 for, 3 include. Strings in the ops array are literal text.
function compileNodes(nodes) {
  const ops = [];
  for (const n of nodes) {
    if (n.kind === 'text') ops.push(n.text);
    else if (n.kind === 'var' || n.kind === 'raw') ops.push({ k: 0, get: makeGetter(n.path), raw: n.kind === 'raw' });
    else if (n.kind === 'if') ops.push({ k: 1, get: makeGetter(n.path), not: n.not, t: compileNodes(n.then), e: n.else === null ? null : compileNodes(n.else) });
    else if (n.kind === 'for') ops.push({ k: 2, name: n.name, get: makeGetter(n.path), b: compileNodes(n.body) });
    else if (n.kind === 'include') ops.push({ k: 3, name: n.name, cache: null }); // cache filled in later
  }
  return ops;
}

// Free root names of a template's own nodes (names bound by its own fors excluded;
// includes NOT descended — the caller unions over the include graph).
function collectOwnFree(nodes, bound, out) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      collectOwnFree(n.then, bound, out);
      if (n.else) collectOwnFree(n.else, bound, out);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      collectOwnFree(n.body, b2, out);
    }
  }
}

// Transitive free names of a template (through its include graph, cycle-safe: every
// reachable template's own names are collected exactly once).
function freeNamesOf(parsed, name) {
  const out = new Set();
  const seen = new Set();
  const stack = [name];
  while (stack.length > 0) {
    const t = stack.pop();
    if (seen.has(t)) continue;
    seen.add(t);
    const nodes = parsed.get(t);
    if (nodes === undefined) continue;
    collectOwnFree(nodes, new Set(), out);
    for (const n of nodes) if (n.kind === 'include') stack.push(n.name);
  }
  return out;
}

const CASE_CONST = new Set(['site', 'tags', 'recent']);

// Decide the include-memo key for every include op, once per case. The key is decided by
// the INCLUDED template's own transitive free names (see cacheForInclude).
function planMemo(parsed, compiled) {
  for (const ops of compiled.values()) {
    for (const op of ops) {
      if (typeof op === 'object' && op.k === 3) op.cache = cacheForInclude(parsed, op.name);
    }
  }
}

// The cache key of an include is decided by the INCLUDED template's own free names:
//  - free names ⊆ {site,tags,recent} → 'const': render once per (template, depth)
//  - free names minus constants is exactly one name N ≠ 'loop' → N: render once per
//    (template, depth, vars[N]) — vars[N] is a stable object (a post/card/tag) or a value
//  - anything else (incl. 'loop', whose object is mutated in place per iteration) → null
function cacheForInclude(parsed, targetName) {
  const free = freeNamesOf(parsed, targetName);
  for (const f of CASE_CONST) free.delete(f);
  if (free.size === 0) return 'const';
  if (free.size === 1) {
    const only = free.values().next().value;
    if (only !== 'loop') return only;
  }
  return null;
}

function renderOps(ops, vars, out, ctx, depth) {
  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi];
    if (typeof op === 'string') { out.push(op); continue; }
    if (op.k === 0) {
      const t = textOf(op.get(vars));
      out.push(op.raw ? t : escapeHtml(t));
    } else if (op.k === 1) {
      const br = truthy(op.get(vars)) !== op.not ? op.t : op.e;
      if (br !== null) renderOps(br, vars, out, ctx, depth);
    } else if (op.k === 2) {
      const xs = op.get(vars);
      if (!Array.isArray(xs)) continue;
      const name = op.name;
      const hadName = Object.hasOwn(vars, name);
      const oldName = vars[name];
      const hadLoop = Object.hasOwn(vars, 'loop');
      const oldLoop = vars.loop;
      // One loop object per for-node, mutated per iteration: it is only ever read
      // during the synchronous body render, never stored, so reuse is exact.
      const loopObj = { index: 0, first: false, last: false, length: xs.length };
      for (let k = 0; k < xs.length; k++) {
        vars[name] = xs[k];
        loopObj.index = k + 1;
        loopObj.first = k === 0;
        loopObj.last = k === xs.length - 1;
        vars.loop = loopObj;
        renderOps(op.b, vars, out, ctx, depth);
      }
      if (hadName) vars[name] = oldName; else delete vars[name];
      if (hadLoop) vars.loop = oldLoop; else delete vars.loop;
    } else { // include
      const t = ctx.compiled.get(op.name);
      if (t === undefined || depth >= INCLUDE_DEPTH) continue;
      const ck = op.cache;
      if (ck === null) { renderOps(t, vars, out, ctx, depth + 1); continue; }
      let m = ctx.memo.get(op.name);
      if (ck === 'const') {
        const s = m === undefined ? undefined : m.get(depth);
        if (s !== undefined) { out.push(s); continue; }
        const sub = [];
        renderOps(t, vars, sub, ctx, depth + 1);
        const html = sub.join('');
        if (m === undefined) { m = new Map(); ctx.memo.set(op.name, m); }
        m.set(depth, html);
        out.push(html);
      } else {
        const key = vars[ck];
        const dm = m === undefined ? undefined : m.get(depth);
        const s = dm === undefined ? undefined : dm.get(key);
        if (s !== undefined) { out.push(s); continue; }
        const sub = [];
        renderOps(t, vars, sub, ctx, depth + 1);
        const html = sub.join('');
        if (m === undefined) { m = new Map(); ctx.memo.set(op.name, m); }
        let dm2 = m.get(depth);
        if (dm2 === undefined) { dm2 = new Map(); m.set(depth, dm2); }
        dm2.set(key, html);
        out.push(html);
      }
    }
  }
}

// ---------------------------------------------------------------- build pipeline
const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function build(input) {
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = new Map();
  for (const [name, nodes] of parsed) compiled.set(name, compileNodes(nodes));
  planMemo(parsed, compiled);

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: parsed,
    compiled,
    memo: new Map(),
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. sources, code-unit order; \r normalisation skipped when no \r is present
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter + refusal/draft checks
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { b.report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { b.report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { b.report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) { b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { b.report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  b.sources = kept;

  // 3. permalinks
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. markdown + link resolution
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading_minutes ??= Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { compiled: b.compiled, memo: b.memo };
  const render = (name, vars) => {
    const ops = b.compiled.get(name);
    if (ops === undefined) return null;
    const out = [];
    renderOps(ops, { site, tags: allTags, recent, ...vars }, out, ctx, 0);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. report
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pagesN = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pagesN} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return b.output;
}

export function run(input) {
  return build(input);
}
