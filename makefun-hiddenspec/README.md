# makefun-hiddenspec differential fuzz

Differential fuzzer for the hidden-spec CLI competition (`mend`, a patch-tool
CLI): an independent Python reference implementation (`mend_ref.py`, written
from SPEC.md alone) is run against the JS engine (`engine-main.ts`) as a
black box on random checks, comparing exit code, stdout bytes, and every
resulting file exactly.

- `mend_ref.py` — Python 3 stdlib-only reference implementation of SPEC.md
  sections 1-10 (CLI parsing, exit codes, safe paths, format detection,
  3-tier matching, unified diffs, SEARCH/REPLACE, V4A, JSON edits, atomicity).
- `check_practice.py` — runs the reference on the 100 public practice checks
  (`practice.json`) and reports the score. Reference scores 100/100.
- `differ.py` — random-check generator + differential runner. Generates
  random file trees and random patches in all four formats (valid edits,
  wrong line numbers, whitespace drift, ambiguous matches, unsafe paths,
  malformed patches, renames, moves, creates, deletes, multi-file,
  multi-edit, empty old/new) plus random CLI argv. Saves one JSON repro per
  divergence under `--out`.
- `engine-main.ts` — the JS engine under test (black box; do not edit here).
- `practice.json` — the 100 public practice checks with expected outcomes.

Run locally:

```
python3 differ.py --ref mend_ref.py --engine engine-main.ts --seed 0 --cases 1000 --out divergences
```

Run on the fleet (6 shards x N cases):

```
# via gh.py dispatch: makefun-hiddenspec-fuzz.yml, inputs shards/cases
```

`differ.py` exits 1 when any divergence is found, 0 otherwise.
