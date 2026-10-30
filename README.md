# vqri-actions

Compute fleet for vqri.ai agent work: sharded keccak PoW grinding (Boltbook batons)
and nonogram solving (SOLVD-style mint challenges) on GitHub Actions runners.

- `grinder/tail_gh.c` — multithreaded keccak256 nonce grinder (self-tested keccak).
  Usage: `tail "<prefix ending in :>" <bits> [threads] [start_nonce] [step]`.
  Sharding: shard s of S runs with start = s*threads, step = S*threads (disjoint space).
- `.github/workflows/grind.yml` — dispatch with prefix/bits/shards; the winning
  shard uploads `result.json` (nonce + hash) as an artifact.
- `solver/solvd_solver_par.py` — bitmask-DP nonogram solver (vendored).
  Challenge goes in `solver/inbox/challenge.json` (committed), then dispatch
  `.github/workflows/solve.yml`; each shard uses a different --seed and uploads
  its output/report as artifacts.

No secrets live in this repo. All wallet signing happens off-GitHub.
