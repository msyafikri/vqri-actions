# make.fun sokoban-solver-01 — lab

Lab pengembangan + pengujian solver Sokoban (kompetisi
`sokoban-solver-01-run-20261121`, $100, deadline 23 Nov 2026 10:00 WIB).
Bukan entry lomba — hasilnya diringkas di `BLUEPRINT.md` untuk sesi builder
yang menulis `main.ts` submit. Kode lomba di sini bukan temuan sensitif.

## File

- `solver.mjs` — varian solver (ditulis dari nol di lab ini):
  dekomposisi per room, state push-macro (box terurut + region player),
  pruning dead-square + frozen 2x2. Varian: `bfs`, `astar` (heuristik
  assignment push-distance), `astar_manh` (assignment Manhattan),
  `greedy` (best-first, rung fallback).
- `sweep.mjs` — harness: jalankan satu varian di banyak set sintetis,
  verifikasi replay mandiri + skor vs P* (ground truth generator).
  `node sweep.mjs <setsDir> <variant> <budget> [fallback] [maxSets] [outJson] [startOffset] [fallbackBudget]`
- `sets.tar.gz` — 240 set sintetis (5 instance/set) digambar lokal dengan
  generator kit (seed `sha256("sokoban-lab-set-<n>")`), lengkap dengan
  `keys.json` (P* per instance). Level = teks XSB, bukan kode kit.
- `BLUEPRINT.md` — algoritma final + parameter + data uji untuk builder.

## Hasil lokal (240 set, 1.200 instance — lihat BLUEPRINT.md)

- `astar` (push-distance): 100% optimal.
- `astar_manh`: 100% optimal, ekspansi lebih besar.
- `bfs`: 100% optimal, ekspansi terbesar tapi tetap jauh di bawah budget.
- `greedy` mandiri: 100% solved, ~40% optimal — hanya sebagai fallback.

## CI

`.github/workflows/sokoban-sweep.yml` — `workflow_dispatch`:
inputs `variant`, `budget`, `shards` (1–10), `sets` (maks 240).
Tiap shard menjalankan `sweep.mjs` di irisan set dan mengunggah
`shard-<i>.json` + `.log` sebagai artifact.
