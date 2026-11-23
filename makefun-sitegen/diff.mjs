// Differential + benchmark harness: candidate solve.js vs the house baseline (vendor
// makefun-site) on the practice set, plus fresh generated sets and mutation fuzz sets.
// Usage:
//   node diff.mjs --candidate ./solve-v1.js [--cases <cases.json>] [--expected <expected.json>]
//   node diff.mjs --candidate ./solve-v1.js --bench [--reps 5]
//   node diff.mjs --candidate ./solve-v1.js --fuzz <cases.json> --mutations 200 --seed 7
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VENDOR_DIR = process.env.SITEGEN_VENDOR ?? '/home/hatch/workspace/makefun/sitegen-kit-fresh/site-generator-speed-01-run-20261122-kit/baselines/makefun-site/vendor/makefun-site';
const BASE_URL = pathToFileURL(`${VENDOR_DIR}/index.js`).href;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const has = (name) => args.includes(name);

const candidatePath = opt('--candidate', './solve-v1.js');
const casesPath = opt('--cases', process.env.SITEGEN_CASES ?? `${process.env.SITEGEN_KIT ?? '/home/hatch/workspace/makefun/sitegen-kit-fresh/site-generator-speed-01-run-20261122-kit'}/practice/input/cases.json`);
const expectedPath = opt('--expected', process.env.SITEGEN_EXPECTED ?? '');

const { build: baselineBuild } = await import(BASE_URL);
const candMod = await import(pathToFileURL(candidatePath.startsWith('/') ? candidatePath : `${process.cwd()}/${candidatePath}`).href);
const candidateRun = candMod.run ?? candMod.default?.run;
if (typeof candidateRun !== 'function') { console.error('candidate exports no run()'); process.exit(2); }

// Canonical deep compare: sort object keys recursively, then JSON.stringify.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: ${JSON.stringify(a)?.slice(0, 120)} !== ${JSON.stringify(b)?.slice(0, 120)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join(',') !== kb.join(',')) {
    const onlyA = ka.filter((k) => !Object.hasOwn(b, k));
    const onlyB = kb.filter((k) => !Object.hasOwn(a, k));
    return `${path}: keys differ onlyA=${onlyA.slice(0, 5)} onlyB=${onlyB.slice(0, 5)}`;
  }
  for (const k of ka) {
    const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

function cpuRun(fn, input) {
  const t0 = process.cpuUsage();
  const w0 = Date.now();
  const out = fn(input);
  const cpu = process.cpuUsage(t0);
  return { out, cpuMs: (cpu.user + cpu.system) / 1000, wallMs: Date.now() - w0 };
}

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
let expected = null;
if (expectedPath) { try { expected = JSON.parse(readFileSync(expectedPath, 'utf8')); } catch { /* no expected file */ } }

const reps = Number(opt('--reps', '5'));
const doBench = has('--bench');

let pass = 0;
let fail = 0;
const benchRows = [];

for (const c of cases) {
  const input = JSON.parse(JSON.stringify(c.input)); // fresh copy per run (candidate must not mutate input)
  const base = cpuRun(baselineBuild, JSON.parse(JSON.stringify(c.input)));
  const cand = cpuRun(candidateRun, input);
  const d = firstDiff(base.out, cand.out);
  let expOk = null;
  if (expected) {
    const expCase = expected.cases.find((e) => e.id === c.id);
    if (expCase) expOk = firstDiff(expCase.output, cand.out) === null;
  }
  const ok = d === null;
  if (ok) pass++; else fail++;
  console.log(`${c.id}: ${ok ? 'PASS' : 'FAIL'}  base=${base.cpuMs.toFixed(1)}ms cand=${cand.cpuMs.toFixed(1)}ms ratio=${(base.cpuMs / Math.max(cand.cpuMs, 0.01)).toFixed(2)}x expected=${expOk === null ? 'n/a' : expOk ? 'match' : 'MISMATCH'}`);
  if (!ok) console.log(`  first diff: ${d}`);
  if (expOk === false) console.log(`  expected diff: ${firstDiff(expected.cases.find((e) => e.id === c.id).output, cand.out)}`);
  benchRows.push({ id: c.id, base: base.cpuMs, cand: cand.cpuMs });
}

if (doBench) {
  console.log('--- bench (warm, median of reps) ---');
  for (const c of cases) {
    // warm up
    candidateRun(JSON.parse(JSON.stringify(c.input)));
    baselineBuild(JSON.parse(JSON.stringify(c.input)));
    const cb = [];
    const bb = [];
    for (let r = 0; r < reps; r++) {
      cb.push(cpuRun(candidateRun, JSON.parse(JSON.stringify(c.input))).cpuMs);
      bb.push(cpuRun(baselineBuild, JSON.parse(JSON.stringify(c.input))).cpuMs);
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    console.log(`${c.id}: cand median=${med(cb).toFixed(1)}ms (reps ${cb.map((x) => x.toFixed(0)).join(',')}) base median=${med(bb).toFixed(1)}ms ratio=${(med(bb) / med(cb)).toFixed(2)}x`);
  }
  // whole-set totals
  const tot = (fn) => {
    const ts = [];
    for (let r = 0; r < reps; r++) {
      const t0 = process.cpuUsage();
      for (const c of cases) fn(JSON.parse(JSON.stringify(c.input)));
      const cpu = process.cpuUsage(t0);
      ts.push((cpu.user + cpu.system) / 1000);
    }
    return ts;
  };
  const tc = tot(candidateRun);
  const tb = tot(baselineBuild);
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`TOTAL 3-case set: cand median=${med(tc).toFixed(1)}ms base median=${med(tb).toFixed(1)}ms ratio=${(med(tb) / med(tc)).toFixed(2)}x`);
  console.log(`  cand reps: ${tc.map((x) => x.toFixed(0)).join(',')}  base reps: ${tb.map((x) => x.toFixed(0)).join(',')}`);
}

console.log(`RESULT: ${pass} pass, ${fail} fail of ${cases.length} cases`);
process.exit(fail === 0 ? 0 : 1);
