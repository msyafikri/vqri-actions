// Fleet sweep for GETAWAY HEAT balance proof.
// Reads game-snapshot.html (test snapshot only — the submitted game is
// authored fresh from the design doc, never copied from here), drives the
// pure core headless: demo-autopilot games across seeds + input fuzz.
// Usage: node sweep.mjs --seed0 N --games M --out sweep-shard-N.json
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./game-snapshot.html', import.meta.url), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('no script block found'); process.exit(2); }
const ctx = vm.createContext({ console });
vm.runInContext(m[1], ctx);
const GH = ctx.GH;

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.replace(/^--/, '');
  if (key.includes('=')) { const [k, v] = key.split('='); args[k] = v; }
  else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
  else args[key] = true;
}
const SEED0 = parseInt(args.seed0 || '0', 10);
const GAMES = parseInt(args.games || '40', 10);
const OUT = args.out || 'sweep.json';
const DT = 1 / 60;

function playGame(seed) {
  const s = GH.createState(seed);
  s.phase = 'playing';
  let frames = 0;
  while (s.phase === 'playing' && frames < 60 * 70) {
    GH.step(s, GH.aiInput(s), DT);
    frames++;
  }
  return {
    seed, seconds: +(frames / 60).toFixed(1),
    survived: s.timeLeft <= 0, reason: s.overReason,
    score: s.score, cash: s.cash, nearMisses: s.nearMisses,
    crashes: s.crashes, maxWanted: s.wanted,
    crashLog: s.crashLog,
  };
}

function fuzz(seed) {
  const s = GH.createState(seed);
  s.phase = 'playing';
  const rand = (() => { let a = seed; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
  const bad = [];
  for (let f = 0; f < 60 * 60 && s.phase === 'playing'; f++) {
    GH.step(s, {
      left: rand() < 0.5, right: rand() < 0.5,
      boost: rand() < 0.3,
      mouseX: rand() < 0.4 ? rand() * 1920 : null,
    }, DT);
    if (!(s.player.x >= 300 && s.player.x <= 1620)) bad.push(`x=${s.player.x} f=${f}`);
    if (s.lives < 0 || s.lives > 3) bad.push(`lives=${s.lives} f=${f}`);
    if (!Number.isFinite(s.score) || s.score < 0) bad.push(`score=${s.score} f=${f}`);
    if (s.combo < 1 || s.combo > 8) bad.push(`combo=${s.combo} f=${f}`);
    if (bad.length > 5) break;
  }
  return { seed, phase: s.phase, score: s.score, bad: bad.slice(0, 5) };
}

const results = [];
for (let g = 0; g < GAMES; g++) results.push(playGame(SEED0 + g));
const det = JSON.stringify(playGame(424242)) === JSON.stringify(playGame(424242));
const fuzzRuns = [fuzz(SEED0 + 9001), fuzz(SEED0 + 9002)];
const scores = results.map(r => r.score);
const out = {
  shard: SEED0, games: results.length, determinism: det,
  survived: results.filter(r => r.survived).length,
  scoreMin: Math.min(...scores), scoreMax: Math.max(...scores),
  scoreMedian: scores.slice().sort((a, b) => a - b)[Math.floor(scores.length / 2)],
  scoreMean: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1),
  crashesMean: +(results.reduce((a, r) => a + r.crashes, 0) / results.length).toFixed(2),
  cashMean: +(results.reduce((a, r) => a + r.cash, 0) / results.length).toFixed(1),
  nearMissMean: +(results.reduce((a, r) => a + r.nearMisses, 0) / results.length).toFixed(1),
  maxWantedSeen: Math.max(...results.map(r => r.maxWanted)),
  fuzzFailures: fuzzRuns.filter(f => f.bad.length > 0).length,
  results,
};
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify({
  shard: SEED0, games: out.games, determinism: det,
  survived: out.survived + '/' + out.games,
  scoreMedian: out.scoreMedian, scoreMean: out.scoreMean,
  crashesMean: out.crashesMean, nearMissMean: out.nearMissMean,
  fuzzFailures: out.fuzzFailures,
}));
