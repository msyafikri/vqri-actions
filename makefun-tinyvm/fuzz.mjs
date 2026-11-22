// Differential fuzzer: candidate vm.js vs the kit oracle vm.mjs.
// Sources: (a) the kit practice set, (b) N generated sets via the kit's own
// generate.mjs (NORMAL + EDGE kinds, seeded), (c) random-byte programs,
// (d) mutations of generated programs, (e) hand-built boundary programs.
// Exits 0 when zero divergences, 1 otherwise. Usage:
//   node fuzz.mjs --seed 1 --sets 20 --mutations 3000 --random 3000
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const KIT = process.argv.includes('--kit')
  ? process.argv[process.argv.indexOf('--kit') + 1]
  : '/home/hatch/workspace/makefun/tinyvm-01/tinyvm-kit-fresh/tiny-stack-vm-01-run-20261122-kit';
const SUBJECT = join(KIT, 'program/generator/subject');

const { run: oracle } = await import(join(SUBJECT, 'vm.mjs'));
const { generate } = await import(join(SUBJECT, 'generate.mjs'));
const { assemble } = await import(join(SUBJECT, 'asm.mjs'));
const { run: candidate } = await import('./vm.js');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
}
const SEED = arg('--seed', 1);
const SETS = arg('--sets', 20);
const MUTATIONS = arg('--mutations', 3000);
const RANDOM = arg('--random', 3000);

// Minimal Rng compatible with the kit generator (xoshiro128**, sha256-seeded).
const rotl = (x, k) => (x << k) | (x >>> (32 - k));
function makeRng(seedStr) {
  const key = createHash('sha256').update(seedStr).digest();
  const v = new DataView(key.buffer, key.byteOffset, 16);
  let a = v.getUint32(0) | 0, b = v.getUint32(4) | 0, c = v.getUint32(8) | 0, d = v.getUint32(12) | 0;
  const u32 = () => {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    let cc = c ^ a, dd = d ^ b;
    const nb = b ^ cc, na = a ^ dd;
    cc ^= t; dd = rotl(dd, 11);
    a = na; b = nb; c = cc; d = dd;
    return r;
  };
  const int = (lo, hi) => {
    const span = hi - lo + 1;
    if (span === 2 ** 32) return lo + u32();
    const limit = Math.floor(2 ** 32 / span) * span;
    let x = u32();
    while (x >= limit) x = u32();
    return lo + (x % span);
  };
  const float = () => u32() / 2 ** 32;
  return {
    u32,
    int,
    float,
    pick: (xs) => xs[int(0, xs.length - 1)],
    chance: (p) => float() < p,
    shuffle: (xs) => { for (let i = xs.length - 1; i > 0; i--) { const j = int(0, i); const t = xs[i]; xs[i] = xs[j]; xs[j] = t; } return xs; },
  };
}

let total = 0;
let diverged = 0;
const failures = [];
function check(tag, program, input) {
  total++;
  let o, c;
  try { o = oracle(program, input); } catch (e) { o = { error: String(e) }; }
  try { c = candidate(program, input); } catch (e) { c = { error: String(e) }; }
  const same = o.error === undefined && c.error === undefined &&
    o.exit === c.exit && o.stdout.length === c.stdout.length &&
    Buffer.from(o.stdout).equals(Buffer.from(c.stdout));
  if (!same) {
    diverged++;
    if (failures.length < 10) {
      failures.push({ tag, exitOracle: o.exit, exitOurs: c.exit,
        lenOracle: o.stdout?.length, lenOurs: c.stdout?.length,
        errOracle: o.error, errOurs: c.error,
        programHex: Buffer.from(program).toString('hex').slice(0, 400),
        inputHex: Buffer.from(input).toString('hex').slice(0, 200) });
    }
  }
  return same;
}

// (a) practice set
const practice = join(KIT, 'practice/input');
for (const id of readdirSync(practice).sort()) {
  const program = new Uint8Array(readFileSync(join(practice, id, 'program.bin')));
  const input = new Uint8Array(readFileSync(join(practice, id, 'input.bin')));
  check('practice/' + id, program, input);
}

// (b) generated sets (each set = 40 instances; kinds rotate by index)
for (let s = 0; s < SETS; s++) {
  for (let k = 0; k < 40; k++) {
    const rng = makeRng(`fuzz-seed-${SEED}-set-${s}-instance-${k}`);
    let g;
    try { g = generate(rng, k); } catch { continue; }
    check(`gen/s${s}/i${k}`, g.files['program.bin'], g.files['input.bin']);
  }
}

// (c) random-byte programs + (d) mutations of generated programs
const rngR = makeRng(`fuzz-seed-${SEED}-random`);
const OPCODES = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x20, 0x21, 0x22, 0x30, 0x31, 0x32, 0x33, 0x34, 0x40, 0x41, 0x50, 0x51, 0x52, 0x53];
for (let i = 0; i < RANDOM; i++) {
  const len = rngR.int(0, 400);
  const program = new Uint8Array(len);
  for (let j = 0; j < len; j++) program[j] = rngR.chance(0.7) ? rngR.pick(OPCODES) : rngR.int(0, 255);
  const input = new Uint8Array(rngR.int(0, 64));
  for (let j = 0; j < input.length; j++) input[j] = rngR.int(0, 255);
  check('random/' + i, program, input);
}
for (let i = 0; i < MUTATIONS; i++) {
  const rng = makeRng(`fuzz-seed-${SEED}-mut-${i}`);
  let g;
  try { g = generate(rng, rng.int(0, 39)); } catch { continue; }
  const program = Uint8Array.from(g.files['program.bin']);
  const ops = rng.int(1, 4);
  for (let o = 0; o < ops; o++) {
    const kind = rng.int(0, 2);
    if (kind === 0 && program.length) program[rng.int(0, program.length - 1)] = rng.int(0, 255);
    else if (kind === 1 && program.length > 1) program[rng.int(0, program.length - 1)] = rng.pick(OPCODES);
    else if (kind === 2) { /* truncate */ program.fill(0, 0, 0); }
  }
  const input = g.files['input.bin'];
  check('mut/' + i, program, input);
}

// (e) hand-built boundary programs
const edgeCases = [];
{
  // exactly 256 pushes then PRINT (ok) vs 257th push (trap 3)
  const fill256 = [];
  for (let i = 0; i < 256; i++) fill256.push(['PUSH', 1]);
  edgeCases.push(['stack-256-ok', [...fill256, 'PRINT', 'HALT'], []]);
  edgeCases.push(['stack-257-trap', [...fill256, ['PUSH', 1], 'HALT'], []]);
  const fill255 = [];
  for (let i = 0; i < 255; i++) fill255.push(['PUSH', 1]);
  edgeCases.push(['stack-255-dup-ok', [...fill255, 'DUP', 'HALT'], []]);
  edgeCases.push(['stack-255-over-ok', [...fill255, ['PUSH', 1], 'OVER', 'HALT'], []]);
  // call depth: 64 nested CALLs then RET chain (ok) vs 65th (trap 7)
  edgeCases.push(['call-64-ok', [['CALL', 'f'], 'HALT', { label: 'f' }, ['PUSH', 65], 'PUTC', 'RET'], []]);
  // deep recursion to depth 64 via self-call with counter
  const deep = [['PUSH', 0], ['PUSH', 0], 'STORE', ['CALL', 'rec'], 'HALT',
    { label: 'rec' }, ['PUSH', 0], 'LOAD', ['PUSH', 1], 'ADD', 'DUP', ['PUSH', 0], 'STORE',
    ['PUSH', 64], 'LT', ['JZ', 'done'], ['CALL', 'rec'], { label: 'done' }, 'RET'];
  edgeCases.push(['call-depth-64', deep, []]);
  edgeCases.push(['ret-empty', ['RET'], []]);
  edgeCases.push(['jmp-neg', [['JMP', { rel: -5 }]], []]);
  edgeCases.push(['jmp-far', [['JMP', { rel: 30000 }]], []]);
  edgeCases.push(['call-far', [['CALL', { abs: 60000 }]], []]);
  edgeCases.push(['push32-truncated', [{ bytes: [0x02, 0x01, 0x02] }], []]);
  edgeCases.push(['push8-truncated', [{ bytes: [0x01] }], []]);
  edgeCases.push(['jmp-truncated', [{ bytes: [0x30, 0x05] }], []]);
  edgeCases.push(['empty-program', [], []]);
  edgeCases.push(['only-halt', ['HALT'], []]);
  edgeCases.push(['fall-off', [['PUSH', 7], 'POP'], []]);
  edgeCases.push(['bad-opcode-ff', [{ bytes: [0xff] }], []]);
  edgeCases.push(['bad-opcode-08', [{ bytes: [0x08] }], []]);
  edgeCases.push(['div-min-neg1', [['PUSH', -2147483648], ['PUSH', -1], 'DIV', 'PRINT', ['PUSH', 10], 'PUTC', 'HALT'], []]);
  edgeCases.push(['mod-min-neg1', [['PUSH', -2147483648], ['PUSH', -1], 'MOD', 'PRINT', 'HALT'], []]);
  edgeCases.push(['neg-min', [['PUSH', -2147483648], 'NEG', 'PRINT', 'HALT'], []]);
  edgeCases.push(['divu-neg', [['PUSH', -1], ['PUSH', 2], 'DIVU', 'PRINT', 'HALT'], []]);
  edgeCases.push(['modu-neg', [['PUSH', -1], ['PUSH', 2], 'MODU', 'PRINT', 'HALT'], []]);
  edgeCases.push(['ltu-neg', [['PUSH', -1], ['PUSH', 1], 'LTU', 'PRINT', 'HALT'], []]);
  edgeCases.push(['shift-32', [['PUSH', 1], ['PUSH', 32], 'SHL', 'PRINT', 'HALT'], []]);
  edgeCases.push(['shift-neg', [['PUSH', 1], ['PUSH', -1], 'SHL', 'PRINT', 'HALT'], []]);
  edgeCases.push(['shru-neg', [['PUSH', -8], ['PUSH', 1], 'SHRU', 'PRINT', 'HALT'], []]);
  edgeCases.push(['shr-neg', [['PUSH', -8], ['PUSH', 1], 'SHR', 'PRINT', 'HALT'], []]);
  edgeCases.push(['push8-neg', [['PUSH8', -1], 'PRINT', 'HALT'], []]);
  edgeCases.push(['push8-127', [['PUSH8', 127], 'PRINT', 'HALT'], []]);
  edgeCases.push(['push8-neg128', [['PUSH8', -128], 'PRINT', 'HALT'], []]);
  edgeCases.push(['exit-neg1', [['PUSH', -1], 'EXIT'], []]);
  edgeCases.push(['exit-256', [['PUSH', 256], 'EXIT'], []]);
  edgeCases.push(['exit-511', [['PUSH', 511], 'EXIT'], []]);
  edgeCases.push(['print-neg', [['PUSH', -2147483648], 'PRINT', 'HALT'], []]);
  edgeCases.push(['load-neg-addr', [['PUSH', -1], 'LOAD', 'HALT'], []]);
  edgeCases.push(['load-256', [['PUSH', 256], 'LOAD', 'HALT'], []]);
  edgeCases.push(['load-255', [['PUSH', 255], 'LOAD', 'PRINT', 'HALT'], []]);
  edgeCases.push(['store-neg-addr', [['PUSH', 9], ['PUSH', -5], 'STORE', 'HALT'], []]);
  edgeCases.push(['in-eof', ['IN', 'IN', 'IN', 'PRINT', 'HALT'], [65]]);
  edgeCases.push(['in-eof-empty', ['IN', 'PRINT', 'HALT'], []]);
  edgeCases.push(['putc-300', [['PUSH', 300], 'PUTC', 'HALT'], []]);
  edgeCases.push(['putc-neg', [['PUSH', -1], 'PUTC', 'HALT'], []]);
  edgeCases.push(['mul-wrap-big', [['PUSH', 65537], 'DUP', 'MUL', 'DUP', 'MUL', 'PRINT', 'HALT'], []]);
  edgeCases.push(['jmp-zero-loop-print', [['PUSH', 0], ['PUSH', 1], 'STORE', { label: 'l' }, ['PUSH', 0], 'LOAD', 'PRINT', ['PUSH', 10], 'PUTC', ['PUSH', 0], 'LOAD', ['PUSH', 1], 'ADD', 'DUP', ['PUSH', 0], 'STORE', ['PUSH', 5], 'LT', ['JNZ', 'l'], 'HALT'], []]);
}
for (const [tag, items, input] of edgeCases) {
  let program;
  try { program = assemble(items); } catch (e) { console.error('assemble fail', tag, e.message); continue; }
  check('edge/' + tag, program, Uint8Array.from(input));
}

console.log(JSON.stringify({ seed: SEED, sets: SETS, mutations: MUTATIONS, random: RANDOM, total, diverged, failures }, null, 2));
process.exit(diverged === 0 ? 0 : 1);
