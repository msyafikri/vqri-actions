// Sweep harness: run one solver variant over many generated sets, verify vs P*.
// Usage: node sweep.mjs <setsDir> <variant> <budget> [fallback] [maxSets] [outJson]
// variant: bfs | astar | astar_manh | greedy
// Prints per-instance rows to stdout and writes a JSON summary to outJson (default sweep.json).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLevel, solveLevel } from './solver.mjs';

const STEP = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };

// Independent replay verifier (same rules as the kit checker, reimplemented here).
export function replay(text, moves) {
  const m = moves.replace(/\s+/g, '');
  if (/[^udlrUDLR]/.test(m)) return { ok: false, pushes: -1, why: 'bad char' };
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * rows.length;
  const wall = new Uint8Array(size).fill(1);
  const goal = new Uint8Array(size);
  const box = new Uint8Array(size);
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') box[i] = 1;
      if (ch === '@' || ch === '+') player = i;
    }
  });
  let pushes = 0;
  for (let k = 0; k < m.length; k++) {
    const [dx, dy] = STEP[m[k].toLowerCase()];
    const d = dy * w + dx;
    const next = player + d;
    if (wall[next]) return { ok: false, pushes, why: `move ${k + 1} into wall` };
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return { ok: false, pushes, why: `move ${k + 1} bad push` };
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < size; i++) if (box[i] && !goal[i]) return { ok: false, pushes, why: 'box off goal' };
  return { ok: true, pushes, why: '' };
}

const setsDir = process.argv[2];
const variant = process.argv[3] ?? 'astar';
const budget = Number(process.argv[4] ?? 300000);
const fallback = process.argv[5] || null;
const maxSets = Number(process.argv[6] ?? 1e9);
const outJson = process.argv[7] ?? 'sweep.json';
const startOffset = Number(process.argv[8] ?? 0);
const fallbackBudget = Number(process.argv[9] ?? budget);

const setNames = readdirSync(setsDir).filter((d) => d.startsWith('set')).sort().slice(startOffset, startOffset + maxSets);
const rows = [];
let nInst = 0, nOptimal = 0, nSolved = 0, nFailed = 0;
let worstRatio = 0, worstRow = null;
let maxRoomExpanded = 0, maxSetMs = 0, totalSetMs = 0;
let sumPoints = 0;
for (const setName of setNames) {
  const keys = JSON.parse(readFileSync(join(setsDir, setName, 'keys.json'), 'utf8'));
  let setPoints = 0;
  const t0 = performance.now();
  for (const k of keys) {
    const text = readFileSync(join(setsDir, setName, k.id, 'level.txt'), 'utf8');
    const level = parseLevel(text);
    const rs = [];
    const res = solveLevel(level, budget, variant, fallback, rs, fallbackBudget);
    const v = res.ok ? replay(text, res.moves) : { ok: false, pushes: -1, why: 'unsolved' };
    const points = v.ok ? (v.pushes <= k.pushes ? 1000 : (500 * k.pushes) / v.pushes) : 0;
    setPoints += points;
    sumPoints += points;
    nInst++;
    if (v.ok) nSolved++;
    if (v.ok && v.pushes === k.pushes) nOptimal++;
    if (!res.ok || !v.ok) nFailed++;
    const ratio = v.ok ? v.pushes / k.pushes : Infinity;
    if (Number.isFinite(ratio) && ratio > worstRatio) { worstRatio = ratio; worstRow = `${setName}/${k.id}`; }
    for (const r of rs) if (r.expanded > maxRoomExpanded) maxRoomExpanded = r.expanded;
    const roomStr = rs.map((r) => `${r.mode}:${r.expanded}`).join(',');
    rows.push({ set: setName, id: k.id, P: k.pushes, pushes: v.ok ? v.pushes : -1, points: Math.round(points * 10) / 10, ok: res.ok && v.ok, optimal: v.ok && v.pushes === k.pushes, rooms: roomStr, why: v.why || '' });
    console.log(`${setName}/${k.id} P*=${k.pushes} pushes=${v.ok ? v.pushes : 'X'} pts=${points.toFixed(1)} ok=${res.ok && v.ok} rooms[${roomStr}] ${v.why || ''}`);
  }
  const setMs = performance.now() - t0;
  totalSetMs += setMs;
  if (setMs > maxSetMs) maxSetMs = setMs;
  console.log(`-- ${setName} setScore=${(1000 * (setPoints / 5)).toFixed(0)} setMs=${setMs.toFixed(0)}`);
}
const summary = {
  variant, budget, fallback, sets: setNames.length, instances: nInst,
  solved: nSolved, optimal: nOptimal, failed: nFailed,
  pctOptimal: nInst ? +(100 * nOptimal / nInst).toFixed(2) : 0,
  meanPoints: nInst ? +(sumPoints / nInst).toFixed(2) : 0,
  worstRatio: worstRatio === Infinity ? null : +worstRatio.toFixed(4), worstRow,
  maxRoomExpanded, maxSetMs: +maxSetMs.toFixed(0), meanSetMs: setNames.length ? +(totalSetMs / setNames.length).toFixed(0) : 0,
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(outJson, JSON.stringify({ summary, rows }, null, 1) + '\n');
