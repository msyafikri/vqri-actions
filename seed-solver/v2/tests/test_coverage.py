#!/usr/bin/env python3
"""Shard coverage self-test: on a reduced multiset space, the union of all
shard dumps must equal the unsharded dump exactly, and shards must be
pairwise disjoint (disjoint + complete partition of the permutation space).
Also spot-checks the dumped checksum-valid flags against the oracle.
"""
import random
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xcheck

BIN = Path(__file__).resolve().parent.parent / "seed_solver"

def dump(words_s, *extra):
    r = subprocess.run([str(BIN), "--dump", "--words", words_s, *extra],
                       capture_output=True, text=True)
    assert r.returncode == 0, (r.returncode, r.stderr)
    perms = {}
    for line in r.stdout.splitlines():
        parts = line.split()
        assert parts[0] == "PERM"
        rank = int(parts[1])
        idx = tuple(int(x) for x in parts[2].split(","))
        perms[rank] = (idx, int(parts[3]))
    return perms

def main():
    xcheck.self_test()
    # multiset: abandon x8, ability x2, able x2 -> 12!/(8! 2! 2!) = 2970
    words = ["abandon"] * 8 + ["ability"] * 2 + ["able"] * 2
    words_s = " ".join(words)
    full = dump(words_s)
    assert len(full) == 2970, len(full)
    assert sorted(full) == list(range(2970)), "ranks must be contiguous 0..2969"
    print("unsharded dump: 2970 perms, ranks contiguous: PASS")

    shards = 7
    seen = {}
    for s in range(shards):
        part = dump(words_s, "--shard-index", str(s), "--shard-count", str(shards))
        for rank, v in part.items():
            assert rank not in seen, f"rank {rank} in two shards"
            assert full[rank] == v, f"rank {rank} content mismatch"
            seen[rank] = v
    assert len(seen) == 2970
    print(f"shard partition ({shards} shards): disjoint + complete: PASS")

    # spot-check valid flags against the oracle on a random sample
    rng = random.Random(99)
    for rank in rng.sample(range(2970), 40):
        idx, flag = full[rank]
        mn = " ".join(xcheck.WORDLIST[i] for i in idx)
        assert xcheck.mnemonic_valid(mn) == bool(flag), (rank, mn, flag)
    nvalid = sum(v for _, v in full.values())
    print(f"checksum flags spot-check (40 samples): PASS "
          f"({nvalid}/2970 valid overall, expect ~1/16 = ~186)")

    print("ALL COVERAGE TESTS PASS")

if __name__ == "__main__":
    main()
