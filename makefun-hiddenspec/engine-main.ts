// mend — lab build (plain JavaScript, Node 22 stdlib only).
// Implements SPEC.md sections 1-10: CLI, output/exit codes, safe paths,
// format detection, three-tier line matching, unified diffs, SEARCH/REPLACE
// blocks, V4A patches, JSON edits, order and atomicity.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  constructor(line) { this.line = line; }
}
class Fail {
  constructor(code, path) { this.code = code; this.path = path; }
}

const blank = (s) => s.trim() === '';

function patchLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p) {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function leadingWs(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function rstripWs(s) {
  return s.replace(/[ \t]+$/, '');
}
function stripWs(s) {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function isWsOnly(s) {
  return /^[ \t]+$/.test(s);
}

/** A file as lines plus its own break and final-break flag (SPEC section 3). */
function parseFile(text) {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) { final = true; lines.pop(); }
  return { lines, br, final };
}
function serializeFile(st) {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  constructor() {
    this.orig = new Map();
    this.now = new Map();
    this.moves = [];
  }
  original(p) {
    if (!this.orig.has(p)) {
      let v = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p);
  }
  get(p) {
    return this.now.has(p) ? this.now.get(p) : this.original(p);
  }
}

/** Line equality at one matching tier (SPEC section 5). */
function lineEq(a, b, tier) {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return stripWs(a) === stripWs(b);
}
function findOccurrences(lines, O, tier) {
  const pos = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j], O[j], tier)) { ok = false; break; }
    }
    if (ok) pos.push(i);
  }
  return pos;
}
/** First tier (0, 1, 2 — or only 0 when strict) at which O occurs at least once. */
function findTier(lines, O, strict) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(lines, O, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
/** First line at or after `from` equal to `anchor` at the first tier with one. */
function findSingleLine(lines, anchor, from, strict) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i], anchor, t)) return i;
    }
  }
  return -1;
}

/**
 * Build the replacement lines for a matched O at `pos`: context lines are the
 * file's own matched lines; at tier 2 every other line is re-indented from
 * O's first line's leading whitespace to the file's (SPEC section 5).
 * N items: { text, ctx, oIdx }.
 */
function buildReplacement(fileLines, pos, O, N, tier) {
  const F = leadingWs(fileLines[pos] !== undefined ? fileLines[pos] : '');
  const P = leadingWs(O.length > 0 ? O[0] : '');
  return N.map((it) => {
    if (it.ctx) return fileLines[pos + it.oIdx];
    const t = it.text;
    if (tier === 2 && t !== '' && !isWsOnly(t) && t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

/** Body lines (context / old / new) of a unified hunk or V4A chunk. */
function bodyON(body) {
  const O = [];
  const N = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      O.push(l === '' ? '' : l.slice(1));
      N.push({ text: l === '' ? '' : l.slice(1), ctx: true, oIdx: O.length - 1 });
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

/** True when a `\` line follows the body's last context or `+` line. */
function backslashAfterLastCtxPlus(body) {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k] === '' || body[k].startsWith(' ') || body[k].startsWith('+')) last = k;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1].startsWith('\\');
}

function detect(lines) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC section 9), or null when it is not one. */
function jsonEdit(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = o.new_str === undefined ? '' : o.new_str;
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s) => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const st = parseFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(st));
    };
  }
  return null;
}

function jsonEdits(text, lines) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- Unified diffs (SPEC section 6) ---------------- */

function headerPath(line) {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function newSection(diffOld, diffNew) {
  return {
    diffOld, diffNew,
    oldPath: null, newPath: null, hasPair: false,
    renameFrom: undefined, renameTo: undefined,
    newFile: false, deletedFile: false,
    hunks: [],
  };
}

/** Parse one section's header and hunks; returns the index after the section. */
function parseSection(lines, i, sec) {
  const n = lines.length;
  let inHeader = true;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) {
      if (!inHeader) break;
      sec.oldPath = headerPath(line);
      sec.newPath = headerPath(lines[i + 1]);
      sec.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1], 10);
      i++;
      const body = [];
      while (i < n) {
        const l = lines[i];
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') { body.push(l); i++; }
        else break;
      }
      // Empty lines at the end of a body are not part of it (SPEC 6): a context
      // line whose text is empty, written as '' or as ' '.
      while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
      sec.hunks.push({ a, body });
      inHeader = false;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) { sec.renameFrom = line.slice(12).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { sec.renameTo = line.slice(10).trim(); i++; continue; }
      if (line === 'new file mode' || line.startsWith('new file mode ')) { sec.newFile = true; i++; continue; }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) { sec.deletedFile = true; i++; continue; }
      i++;
      continue;
    }
    i++;
  }
  return i;
}

/** Apply a section's hunks in order to a file state (SPEC section 6). */
function applyHunks(st, hunks, strict, path) {
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), st.lines.length);
      const atEnd = h.a + d >= st.lines.length;
      const ins = N.map((it) => it.text);
      st.lines.splice(pos, 0, ...ins);
      if (atEnd) st.final = !backslashAfterLastCtxPlus(h.body);
      d += N.length;
    } else {
      const found = findTier(st.lines, O, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = -1;
      let bestDist = Infinity;
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      const atEnd = best + O.length === st.lines.length;
      const rep = buildReplacement(st.lines, best, O, N, found.tier);
      st.lines.splice(best, O.length, ...rep);
      if (atEnd) st.final = !backslashAfterLastCtxPlus(h.body);
      d += N.length - O.length;
    }
  }
}

function sectionToEdit(sec) {
  let oldP = sec.hasPair ? sec.oldPath : (sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld);
  let newP = sec.hasPair ? sec.newPath : (sec.renameTo !== undefined ? sec.renameTo : sec.diffNew);
  const oldRaw = oldP;
  const newRaw = newP;
  if (oldP === '/dev/null') oldP = null;
  if (newP === '/dev/null') newP = null;
  const isCreate = oldP === null || sec.newFile;
  const isDelete = newP === null || sec.deletedFile;
  if (isCreate) {
    const p = newP === null ? newRaw : newP;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus = [];
      let lastPlus = null;
      for (const h of sec.hunks) {
        for (let bi = 0; bi < h.body.length; bi++) {
          if (h.body[bi].startsWith('+')) { plus.push(h.body[bi].slice(1)); lastPlus = { h, bi }; }
        }
      }
      let final = true;
      if (lastPlus && lastPlus.h.body[lastPlus.bi + 1] !== undefined && lastPlus.h.body[lastPlus.bi + 1].startsWith('\\')) final = false;
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
    };
  }
  if (isDelete) {
    const p = oldP === null ? oldRaw : oldP;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== newP) {
    return (tree, strict) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const st = parseFile(before);
      applyHunks(st, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeFile(st));
      tree.moves.push([oldP, newP]);
    };
  }
  return (tree, strict) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const st = parseFile(before);
    applyHunks(st, sec.hunks, strict, oldP);
    tree.now.set(oldP, serializeFile(st));
  };
}

function parseUnified(lines) {
  const edits = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec = newSection(m[1], m[2]);
      i = parseSection(lines, i + 1, sec);
      edits.push(sectionToEdit(sec));
    } else if (line.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) {
      const sec = newSection(null, null);
      i = parseSection(lines, i, sec);
      edits.push(sectionToEdit(sec));
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------- SEARCH/REPLACE blocks (SPEC section 7) ---------------- */

function srEdit(p, oldLines, newLines) {
  return (tree, strict) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const st = parseFile(before);
    const found = findTier(st.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const pos = found.pos[0];
    const F = leadingWs(st.lines[pos] !== undefined ? st.lines[pos] : '');
    const P = leadingWs(oldLines[0]);
    const rep = newLines.map((t) => {
      if (found.tier === 2 && t !== '' && !isWsOnly(t) && t.startsWith(P)) return F + t.slice(P.length);
      return t;
    });
    st.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(p, serializeFile(st));
  };
}

function parseSearchReplace(lines) {
  const edits = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath = null;
  let i = 0;
  while (i < n) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let p = null;
      for (let k = i - 1; k > prevEnd; k--) {
        const t = lines[k];
        if (blank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        p = t.trim();
        break;
      }
      if (p === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        p = prevPath;
      }
      let j = i + 1;
      while (j < n && lines[j].trimEnd() !== '=======') j++;
      if (j >= n) throw new Exit2(`error: parse ${searchLine}`);
      let k = j + 1;
      while (k < n && lines[k].trimEnd() !== '>>>>>>> REPLACE') k++;
      if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
      const oldLines = lines.slice(i + 1, j);
      const newLines = lines.slice(j + 1, k);
      edits.push(srEdit(p, oldLines, newLines));
      prevPath = p;
      prevEnd = k;
      i = k + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------- V4A patches (SPEC section 8) ---------------- */

function v4aAddEdit(p, ls) {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
  };
}

function v4aDeleteEdit(p) {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

function findChunkOccurrence(lines, O, cursor, strict, eof) {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i + O.length <= lines.length; i++) {
      if (eof && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!lineEq(lines[i + j], O[j], t)) { ok = false; break; }
      }
      if (ok) return { tier: t, pos: i };
    }
  }
  return null;
}

function v4aUpdateEdit(p, moveTo, chunks) {
  return (tree, strict) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const found = findSingleLine(st.lines, ch.anchor, cursor, strict);
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? st.lines.length : cursor;
        const ins = N.map((it) => it.text);
        st.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        const occ = findChunkOccurrence(st.lines, O, cursor, strict, ch.eof);
        if (!occ) throw new Fail('no-match', p);
        const rep = buildReplacement(st.lines, occ.pos, O, N, occ.tier);
        st.lines.splice(occ.pos, O.length, ...rep);
        cursor = occ.pos + rep.length;
      }
    }
    const text = serializeFile(st);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, text);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function parseV4a(lines) {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k])) { last = k; break; }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice(14).trim();
      i++;
      const ls = [];
      while (i < last) {
        const l = lines[i];
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('+')) { ls.push(l.slice(1)); i++; }
        else if (l === '') { ls.push(''); i++; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (ls.length > 0 && blank(ls[ls.length - 1])) ls.pop();
      edits.push(v4aAddEdit(p, ls));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice(17).trim();
      i++;
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const p = line.slice(17).trim();
      i++;
      let moveTo = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) { moveTo = lines[i].slice(13).trim(); i++; }
      const chunks = [];
      let cur = null;
      const endChunk = () => { if (cur) { chunks.push(cur); cur = null; } };
      while (i < last) {
        const l = lines[i];
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l === '*** End of File') {
          if (cur) cur.eof = true;
          endChunk();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          endChunk();
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: '', eof: false, body: [] };
            } else {
              throw new Exit2(`error: parse ${i + 1}`);
            }
          }
          cur.body.push(l);
          i++;
          continue;
        }
        if (blank(l) && cur === null && chunks.length > 0) { i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk();
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1];
        while (lc.body.length > 0 && blank(lc.body[lc.body.length - 1])) lc.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------- Invocation, output, exit codes (SPEC sections 1, 2, 10) ---------------- */

function run(args) {
  let format = null;
  let check = false;
  let strict = false;
  const pos = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file === null ? 0 : file, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits;
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map();
  const byteCmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p);
    if (was === now) continue;
    rows.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.delete(oldP);
      rows.delete(newP);
      rows.set(newP, { key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => byteCmp(a.key, b.key));
  const outLines = sorted.map((r) => r.line);
  if (!check) {
    for (const r of sorted) {
      const p = r.key;
      const now = tree.now.get(p);
      if (r.line.startsWith('R ')) {
        const oldP = r.line.slice(2, r.line.indexOf(' -> '));
        rmSync(oldP, { force: true });
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      } else if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
