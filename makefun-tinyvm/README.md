# makefun-tinyvm — Tiny Stack VM (fleet prototype + differential fuzz)

Competition: make.fun `tiny-stack-vm-01-run-20261122` ($100, top 10 x $10).
Deadline: Wed 25 Nov 2026 11:00 WIB. Final set drawn from drand round 34258812.

## What this is

A prototype VM for the make.fun tiny stack ISA, plus a differential fuzzer
that checks it byte-for-byte against the kit's reference VM (the oracle).
This folder is DEVELOPMENT + TESTING ONLY. The submitted entry is written
fresh by the builder session from BLUEPRINT.md (prose spec, no code) — the
files here are never copied into the entry.

## Files

- `vm.js` — candidate VM. `run(program, input) => { stdout, exit }`.
  Written from ISA.md; semantics must match kit `vm.mjs` exactly.
- `entry.js` — entry runner: `<input-dir>` of instances to `<output-dir>`
  of `stdout.bin` + `exit.txt` (the entry contract).
- `fuzz.mjs` — differential fuzzer (oracle vs candidate) over the practice
  set, generated sets (kit generator, seeded), random-byte programs,
  mutations, and hand-built boundary programs (stack/call/output/step
  limits, division edges, shifts, sign extension, truncated immediates).
- `score-practice.mjs` — runs the entry over the kit practice set and
  scores it with the kit checker (target 1,000,000, 40/40).
- `kit-subject/` — mirror of the kit files the fuzzer needs (reference VM,
  generator, assembler, practice inputs), verified sha256 against the kit
  manifest. Public kit content, no credentials.
- `BLUEPRINT.md` — prose spec for the builder session (no code blocks).
- `.github/workflows/makefun-tinyvm-fuzz.yml` — parallel fuzz shards.

## Local results (this VM)

- Practice set: 1,000,000 (40/40, every instance 1000 points).
- Differential fuzz seed 1: 2,285 programs, 0 divergences.

## Leaderboard reality (22 Nov 16:50 WIB)

5,422 of 5,428 entries score a perfect 1,000,000. Rank is decided by
`size_bytes` alone: top 10 are all 27-byte secret loaders (52 entries at
27 bytes, none smaller). The winning shape is therefore a minimal loader
in the repo plus the VM in a pushed secret (the kit's own secrets feature:
a secret becomes an environment variable of the entry at grading time).
A source-bundle entry cannot go below ~336 bytes (freshness.json alone),
so it can prove a perfect score but cannot reach the paid places. The
paid-places path needs a GitHub-route entry whose repo owner is the
account's linked GitHub login (no owner.json) — currently NOT linked on
this account; that is a user-side action, reported separately.

## Run

```
node fuzz.mjs --seed 1 --sets 5 --mutations 1000 --random 1000
node score-practice.mjs
```

GitHub (dispatch `makefun-tinyvm-fuzz.yml`, inputs shards/sets/mutations/
random) runs the same fuzz in parallel shards and uploads each shard's
JSON result as an artifact.
