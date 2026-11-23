// Mutation + generated-set differential fuzzer: candidate run() vs baseline build().
// A divergence (any byte difference in any output value) is a FAIL and the mutated
// input is saved for inspection. Usage:
//   node fuzz.mjs --candidate ./solve-v4.js --cases <cases.json> --mutations 300 --seed 7
//   node fuzz.mjs --candidate ./solve-v4.js --cases <cases.json> --generated <dir-of-cases-files>
//   --save-dir <dir>  (default ./fuzz-failures)
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VENDOR_DIR = process.env.SITEGEN_VENDOR ?? '/home/hatch/workspace/makefun/sitegen-kit-fresh/site-generator-speed-01-run-20261122-kit/baselines/makefun-site/vendor/makefun-site';
const BASE_URL = pathToFileURL(`${VENDOR_DIR}/index.js`).href;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const candidatePath = opt('--candidate', './solve-v4.js');
const casesPath = opt('--cases', process.env.SITEGEN_CASES ?? './kit-subject/practice/input/cases.json');
const mutations = Number(opt('--mutations', '300'));
const saveDir = opt('--save-dir', './fuzz-failures');
const generatedDir = opt('--generated', '');

const { build: baselineBuild } = await import(BASE_URL);
const candMod = await import(pathToFileURL(candidatePath.startsWith('/') ? candidatePath : `${process.cwd()}/${candidatePath}`).href);
const candidateRun = candMod.run ?? candMod.default?.run;

function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: ${JSON.stringify(a)?.slice(0, 160)} !== ${JSON.stringify(b)?.slice(0, 160)}`;
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
    return `${path}: keys differ onlyA=${ka.filter((k) => !Object.hasOwn(b, k)).slice(0, 5)} onlyB=${kb.filter((k) => !Object.hasOwn(a, k)).slice(0, 5)}`;
  }
  for (const k of ka) {
    const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

// Deterministic PRNG (mulberry32) so a failing seed reproduces the same mutations.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  '*', '**', '***', '****', '`', '``', '```', '[', ']', '(', ')', '\\', '\\*', '\\`', '\\[', '#', '## ',
  '- ', '* ', '1. ', '> ', '---', '***', '___', '===', '\n', '\n\n', ' ', '  ', '<', '>', '&', '"', "'",
  '_', '__', '!', '+', '.', 'a', 'Z', '0', 'é', 'Δ', 'λ', '😀', 'ﬁ', 'Ｗ', '\t', '\r', '\r\n',
  '```js\n', '```\n', '[x](y)', '[x](y z)', '[x]()', '[a **b** c](d)', '**a *b* c**', '*a **b** c*',
  'a*b', 'a ** b', '**', '*', '`code`', '`unclosed', '**unclosed', '*unclosed', '[unclosed', '[a](b',
  'http://x.example/a', 'mailto:a@b.c', '#frag', '/abs', '../up', './here', 'posts/2026/x',
  '\n---\n', 'title: ', 'tags: [a, b]', 'draft: true', '---\n', '<div class="x">', '&amp;', '&#39;',
];
const TITLES = [
  'Café Δelta', 'Ærøskøbing', 'Ｗｉｄｅ Ｆｉｎａｌ', 'Łódź', 'Straße', 'São Paulo', 'naïve résumé',
  'a'.repeat(100), '---', '***', '', '   ', '"quoted"', '"unclosed', '"a\\"b"', '"a\\qb"',
  '[bracket]', 'UPPER Title', 'trailing   ', '  leading', 'a-b_c d', 'x'.repeat(64), 'x'.repeat(65),
  'emoji 😀 title', 'tab\ttitle', 'dot. dot', "it's", 'a & b <c>', '100% sure',
];

function mutateCase(input, r) {
  const c = JSON.parse(JSON.stringify(input));
  const nMut = 1 + Math.floor(r() * 4);
  for (let m = 0; m < nMut; m++) {
    const kind = r();
    if (kind < 0.55) {
      // body mutation
      const mds = c.files.filter((f) => f.path.endsWith('.md'));
      if (!mds.length) continue;
      const f = mds[Math.floor(r() * mds.length)];
      const s = f.content;
      const pos = Math.floor(r() * (s.length + 1));
      const piece = PIECES[Math.floor(r() * PIECES.length)];
      const op = r();
      if (op < 0.6) f.content = s.slice(0, pos) + piece + s.slice(pos);
      else if (op < 0.8 && s.length > 0) f.content = s.slice(0, pos) + s.slice(pos + 1 + Math.floor(r() * 10));
      else if (s.length > 0) f.content = s.slice(0, pos) + piece + s.slice(pos + 1 + Math.floor(r() * 10));
      if (r() < 0.08) f.content = f.content.replace(/\n/g, '\r\n'); // CRLF the whole file
    } else if (kind < 0.72) {
      // front-matter mutation: retitle / redates / retag a random source
      const mds = c.files.filter((f) => f.path.endsWith('.md'));
      if (!mds.length) continue;
      const f = mds[Math.floor(r() * mds.length)];
      const t = TITLES[Math.floor(r() * TITLES.length)];
      const op = r();
      if (op < 0.4) f.content = f.content.replace(/^title: .*$/m, `title: ${t}`);
      else if (op < 0.55) f.content = f.content.replace(/^title: .*$/m, `title: "${t}"`);
      else if (op < 0.65) f.content = f.content.replace(/^date: .*$/m, ['date: 2026-02-29', 'date: 2026-13-01', 'date: 1969-12-31', 'date: 2100-01-01', 'date: not-a-date', 'date: 2026-11-09'][Math.floor(r() * 6)]);
      else if (op < 0.75) f.content = f.content.replace(/^tags: .*$/m, ['tags: []', 'tags: [a, a, b]', 'tags: [Café, café]', 'tags: [a,,b]', 'tags: no-list', 'tags: ["q"]'][Math.floor(r() * 6)]);
      else if (op < 0.85) f.content = f.content.replace(/^slug: .*$/m, ['slug: BAD_SLUG', 'slug: a--b', 'slug: ' + 'x'.repeat(65), 'slug: ok-slug-2'][Math.floor(r() * 4)]);
      else if (op < 0.92) f.content = f.content.replace(/^draft: .*$/m, ['draft: True', 'draft: 1', 'draft: false'][Math.floor(r() * 3)]);
      else f.content = f.content.replace(/^layout: .*$/m, ['layout: missing', 'layout: Bad Name', 'layout: post'][Math.floor(r() * 3)]);
      if (r() < 0.06) f.content = f.content.replace(/^---\n/, ''); // strip opening ---
      if (r() < 0.06) f.content = f.content.replace(/\n---\n/, '\n'); // strip closing ---
      if (r() < 0.05) f.content = f.content.replace(/^title: .*$/m, 'Title: Capital'); // capitalised key
      if (r() < 0.05) f.content = f.content.replace(/^title: .*$/m, 'title: first\ntitle: second'); // dup key
      if (r() < 0.05) f.content = f.content.replace(/^title: .*$/m, 'bogus: 1\ntitle: T'); // unknown key
    } else if (kind < 0.88) {
      // template mutation
      const names = Object.keys(c.templates);
      if (!names.length) continue;
      const name = names[Math.floor(r() * names.length)];
      const op = r();
      if (op < 0.3) delete c.templates[name];
      else if (op < 0.55) c.templates[name] += PIECES[Math.floor(r() * PIECES.length)];
      else if (op < 0.7) c.templates[name] = c.templates[name].replace('{{', '{{{').replace('}}', '}}}');
      else if (op < 0.8) c.templates[name] = '{% for x in posts %}{{ x.title }}{% endfor %}';
      else if (op < 0.9) c.templates[name] = '{% if page %}{{ page.title }}{% else %}none{% endif %}{% include "missing" %}';
      else c.templates[name] = 'A\n{% include "head" %}\nB {% if not page %}C{% endif %}\n{% for t in tags %}{{ t.name }}{% endfor %}';
      if (r() < 0.1) c.templates[`filler-${Math.floor(r() * 100)}`] = 'plain {{ site.title }} text';
    } else {
      // site param mutation
      const op = r();
      if (op < 0.35) c.site.per_page = [1, 2, 3, 100, 1000][Math.floor(r() * 5)];
      else if (op < 0.6) c.site.recent = [0, 1, 2, 50][Math.floor(r() * 4)];
      else if (op < 0.8) c.site.base_url = ['https://x.example/', 'https://x.example///', 'https://x.example/blog', ''][Math.floor(r() * 4)];
      else if (op < 0.9) c.site.title = TITLES[Math.floor(r() * TITLES.length)];
      else {
        // duplicate a file path / add a static that shadows a built page
        const f = c.files[Math.floor(r() * c.files.length)];
        c.files.push({ path: f.path, content: 'DUPLICATE ' + f.content.slice(0, 20) });
        if (r() < 0.5) c.files.push({ path: 'index.html', content: 'static index' });
        if (r() < 0.3) c.files.push({ path: 'build-report.txt', content: 'static report' });
      }
    }
  }
  return c;
}

let total = 0;
let diverged = 0;
let crashed = 0;

function checkOne(input, label) {
  total++;
  let baseOut, candOut;
  try {
    baseOut = baselineBuild(JSON.parse(JSON.stringify(input)));
  } catch (e) {
    console.log(`${label}: BASELINE THREW ${e.message} — skipping (candidate cannot be compared)`);
    return;
  }
  try {
    candOut = candidateRun(JSON.parse(JSON.stringify(input)));
  } catch (e) {
    crashed++;
    console.log(`${label}: CANDIDATE THREW ${e.constructor.name}: ${e.message}`);
    mkdirSync(saveDir, { recursive: true });
    writeFileSync(`${saveDir}/${label}.json`, JSON.stringify(input));
    return;
  }
  const d = firstDiff(baseOut, candOut);
  if (d !== null) {
    diverged++;
    console.log(`${label}: DIVERGENCE: ${d}`);
    mkdirSync(saveDir, { recursive: true });
    writeFileSync(`${saveDir}/${label}.json`, JSON.stringify(input));
  }
}

const baseCases = JSON.parse(readFileSync(casesPath, 'utf8'));
const seed0 = Number(opt('--seed', '7'));
const r = rng(seed0);

// 1. unmutated base cases first
for (const c of baseCases) checkOne(c.input, `base-${c.id}`);

// 2. mutation fuzz
for (let m = 0; m < mutations; m++) {
  const c = baseCases[Math.floor(r() * baseCases.length)];
  checkOne(mutateCase(c.input, r), `mut-${seed0}-${m}`);
}

// 3. fresh generated sets, if supplied
if (generatedDir) {
  for (const fn of readdirSync(generatedDir).filter((f) => f.endsWith('.json')).sort()) {
    const gen = JSON.parse(readFileSync(`${generatedDir}/${fn}`, 'utf8'));
    for (const c of gen) checkOne(c.input, `gen-${fn.replace('.json', '')}-${c.id}`);
  }
}

console.log(`FUZZ RESULT: ${total} programs, ${diverged} divergences, ${crashed} candidate crashes, ${total - diverged - crashed} clean`);
process.exit(diverged === 0 && crashed === 0 ? 0 : 1);
