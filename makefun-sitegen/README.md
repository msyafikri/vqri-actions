# makefun-sitegen — site-generator-speed-01-run-20261122 fleet dev

GitHub-first dev for the make.fun "Build a static site faster" competition
($100 pot, entries close 2026-11-24T20:00:00Z). The fleet holds the OPTIMISATION
workbench only: candidate `solve.js` variants, the differential/bench harness, and
the kit's own generator (plain-JS port) for fresh case sets. The submitted entry is
authored fresh from `BLUEPRINT.md` in the builder session — never a raw copy of
these files. This repo is PUBLIC: no secrets, API keys, personal data, or make.fun
credentials anywhere in here — only generic parameters in workflow inputs/logs.

## Layout

- `solve-v1.js` … `solve-v4.js` — candidate variants (v4 = current best).
  - v1: fused single-pass Markdown (regex-dispatch inline, one-shot escaping) +
    compiled templates (flattened scope, prebuilt getters) + include memoisation.
  - v2: + hand-rolled wordsOf/trimLine, longDate cache, reading_minutes memoised.
  - v3: + first-char block dispatch in the Markdown lexer.
  - v4: + inline() no-special fast path, resolvePath cache, pageOf reuses cached card.
- `diff.mjs` — practice-set differential (candidate vs vendor baseline) + warm bench.
- `fuzz.mjs` — mutation fuzzer (bodies, front matter, templates, site params) +
  fresh generated sets. Any byte difference = FAIL, input saved.
- `bench-one.mjs` — warm `run()` CPU per 3-case set (process.cpuUsage).
- `kit-subject/vendor/makefun-site/` — the house baseline (makefun-site 1.0.0), the oracle.
- `kit-subject/practice/input/cases.json` — the kit's practice set (3 cases).
- `kit-subject/generator/` — plain-JS port of the kit case generator
  (`rng.mjs` + `sites.mjs` + `gen.mjs`); draws fresh sets from a seed hex.

## Workflow

`.github/workflows/makefun-sitegen.yml` (workflow_dispatch):
- `bench`: practice differential + warm bench for the chosen variant, plus all
  variants side by side on the same runner (node 22, the grader's version).
- `fuzz`: N shards; each generates fresh sets from shard seeds, then runs the
  mutation fuzzer against the variant. Logs + any failing inputs are artifacts.

## Local results (this box, node v24.22.1, loaded — ratios only)

| variant | warm run() / 3-case set | vs baseline |
|---------|------------------------|-------------|
| baseline (vendor) | ~560–610 ms | 1.00× |
| v1 | ~218 ms | 2.58× |
| v2 | ~186 ms | 3.05× |
| v3 | ~166 ms | 3.56× |
| v4 | ~166 ms | 3.67× |

## Fleet results (node 22, GitHub runners — run 45123280915, 2026-11-23, success)

- Practice differential: 3/3 PASS (v4 vs vendor baseline).
- Warm bench, median of 7 reps: **v4 123.1 ms vs baseline 490.7 ms = 3.98×**
  (g-0001 34.0 ms / 3.26×, g-0002 53.9 ms / 3.98×, g-0003 71.2 ms / 2.77×).
- All-variants side-by-side (`bench-one.mjs`, deep-copy overhead included):
  v1 226.1 ms, v2 193.2 ms, v3 193.9 ms, v4 189.2 ms, baseline 615.8 ms.
- Fuzz: 4 shards × 512 programs = **2,048 programs, 0 divergences, 0 crashes**
  (3 base + 500 mutations + 9 fresh generated cases per shard).

Differential: practice 3/3 + 663 mutation/fresh programs, 0 divergences (local),
plus 2,048 programs on the fleet, 0 divergences.
