// Entry runner for the fleet prototype: runs candidate vm.js over a directory of
// instances (each <id>/program.bin + input.bin) and writes <id>/stdout.bin +
// <id>/exit.txt, exactly the entry contract in the kit's ISA.md.
// Usage: node entry.js <input-dir> <output-dir>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './vm.js';

const I = process.argv[2] ?? process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.argv[3] ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const program = new Uint8Array(readFileSync(join(I, id, 'program.bin')));
  const input = new Uint8Array(readFileSync(join(I, id, 'input.bin')));
  const r = run(program, input);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.stdout);
  writeFileSync(join(O, id, 'exit.txt'), String(r.exit) + '\n');
}
