// gen.mjs — draw a fresh 3-case set from a seed (plain JS, node22-safe).
// Usage: node gen.mjs <seed-hex-64> <out-cases.json>
// The seed is a generic 64-hex string (e.g. sha256 of "sitegen-fleet-seed-N").
// The drawn cases use the kit's own subject/sites.mjs generator, so they have the
// same shape/size bands as the scored set; only the content differs.
import { writeFileSync } from 'node:fs';
import { streamFor } from './rng.mjs';
import { generate } from './sites.mjs';

const seed = process.argv[2];
const out = process.argv[3];
if (!seed || !/^[0-9a-f]{64}$/.test(seed) || !out) {
  console.error('usage: node gen.mjs <64-hex-seed> <out-cases.json>');
  process.exit(2);
}
const pad = (n) => String(n).padStart(4, '0');
const cases = [];
for (let i = 0; i < 3; i++) cases.push({ id: `g-${pad(i + 1)}`, input: generate(streamFor(seed, 'case', i), i) });
writeFileSync(out, JSON.stringify(cases.map((c) => ({ id: c.id, input: c.input }))));
console.log(`wrote ${out}: ${cases.map((c) => c.input.files.length).join(',')} files`);
