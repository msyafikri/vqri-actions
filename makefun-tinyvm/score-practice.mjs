// Local practice-set score for the fleet prototype entry.
// Runs entry.js over the kit practice/input, then scores every instance with
// the kit checker against practice/reference/manifest.json.
// Usage: node score-practice.mjs [--kit <path>]
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const KIT = resolve(process.argv.includes('--kit')
  ? process.argv[process.argv.indexOf('--kit') + 1]
  : '/home/hatch/workspace/makefun/tinyvm-01/tinyvm-kit-fresh/tiny-stack-vm-01-run-20261122-kit');

const { points } = await import(join(KIT, 'program/scorer/checker/check.mjs'));
const manifest = JSON.parse(readFileSync(join(KIT, 'practice/reference/manifest.json'), 'utf8'));
const outDir = mkdtempSync(join(tmpdir(), 'tinyvm-out-'));
execFileSync(process.execPath, [join(HERE, 'entry.js'), join(KIT, 'practice/input'), outDir], { stdio: 'inherit' });

let total = 0;
const rows = [];
for (const inst of manifest.instances) {
  const key = inst.key;
  const outputs = {
    'stdout.bin': new Uint8Array(readFileSync(join(outDir, inst.id, 'stdout.bin'))),
    'exit.txt': readFileSync(join(outDir, inst.id, 'exit.txt'), 'utf8'),
  };
  const files = {};
  for (const f of inst.files) {
    const bytes = new Uint8Array(readFileSync(join(KIT, 'practice/reference', inst.id, f.name)));
    files[f.name] = f.kind === 'text' ? new TextDecoder().decode(bytes) : bytes;
  }
  const r = points(files, key, outputs);
  total += r.points;
  rows.push({ id: inst.id, kind: key.kind, points: r.points, valid: r.valid, detail: r.detail });
}
const score = Math.floor((total * 1000) / rows.length + 0.5);
console.log(JSON.stringify({ score, answered: rows.filter((r) => r.valid).length, instances: rows.length, rows }, null, 2));
rmSync(outDir, { recursive: true, force: true });
process.exit(score === 1000000 ? 0 : 1);
