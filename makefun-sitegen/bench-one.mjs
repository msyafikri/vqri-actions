// Bench-only driver for profiling: runs the candidate over the practice set N times.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const candPath = process.argv[2] || './solve-v1.js';
const reps = Number(process.argv[3] || '10');
const casesPath = process.env.SITEGEN_CASES ?? './kit-subject/practice/input/cases.json';
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const mod = await import(pathToFileURL(candPath.startsWith('/') ? candPath : `${process.cwd()}/${candPath}`).href);
const run = mod.run ?? mod.build; // vendor baseline exports build(), candidates export run()
const t0 = process.cpuUsage();
for (let r = 0; r < reps; r++) for (const c of cases) run(JSON.parse(JSON.stringify(c.input)));
const cpu = process.cpuUsage(t0);
console.log(`candidate ${reps}x3 cases: ${((cpu.user + cpu.system) / 1000).toFixed(1)}ms CPU total, ${(((cpu.user + cpu.system) / 1000) / reps).toFixed(1)}ms per 3-case set`);
