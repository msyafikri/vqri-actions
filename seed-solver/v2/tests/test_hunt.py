#!/usr/bin/env python3
"""Balance-hunt mode tests (seed_solver --hunt + tools/balance_check.py).

1. Pipeline: shuffle a synthetic valid phrase, run --hunt on a small rank
   window containing the true ordering, feed the output to the checker in
   stub mode (true address = funded): exactly one HIT, at the true rank,
   and the coverage line must account for every emitted survivor.
2. Slice partition: hunt slices of a small multiset space are disjoint
   and their union equals the full-range run (ranks compared as sets).
3. Duplicate-word multiset: --rank total is 12!/2 = 239500800 for a
   one-pair phrase, and hunt never emits the same rank twice.
All phrases are synthetic (xcheck oracle); no real event words.
"""
import random
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xcheck

HERE = Path(__file__).resolve().parent
BIN = HERE.parent / "seed_solver"
CHECKER = HERE.parent / "tools" / "balance_check.py"


def run(*args, **kw):
    return subprocess.run([str(BIN), *args], capture_output=True, text=True, **kw)


def hunt_lines(words_s, start, end):
    r = run("--hunt", "--words", words_s, "--start", str(start),
            "--end", str(end))
    assert r.returncode == 0, (r.returncode, r.stderr)
    return [l for l in r.stdout.splitlines() if l.strip()]


def main():
    xcheck.self_test()

    # ---------- 1. pipeline with stub checker ----------
    phrase = xcheck.mnemonic_from_entropy(bytes([0x80] * 16))
    target = xcheck.solana_address(phrase)
    out = run("--derive", "--words", phrase)
    assert target in out.stdout, out.stdout
    r = run("--rank", "--words", phrase)
    parts = r.stdout.split()
    rank_true, total = int(parts[1]), int(parts[3])

    words = phrase.split()
    shuffled = words[:]
    random.Random(99).shuffle(shuffled)
    shuffled_s = " ".join(shuffled)

    lo = max(0, rank_true - 20000)
    hi = min(total, rank_true + 20000)
    lines = hunt_lines(shuffled_s, lo, hi)
    assert f"{rank_true} {target}" in lines, "true ordering not emitted"
    ranks = [int(l.split()[0]) for l in lines]
    assert len(ranks) == len(set(ranks)), "duplicate ranks emitted"

    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write("\n".join(lines) + "\n")
        fname = f.name
    c = subprocess.run([sys.executable, str(CHECKER), "--input", fname,
                        "--stub-funded", target],
                       capture_output=True, text=True)
    assert c.returncode == 0, (c.returncode, c.stdout, c.stderr)
    hits = [l for l in c.stdout.splitlines() if l.startswith("HIT ")]
    assert len(hits) == 1, c.stdout
    assert f"rank={rank_true}" in hits[0] and f"address={target}" in hits[0], hits
    cov = [l for l in c.stdout.splitlines() if l.startswith("COVERAGE ")]
    assert len(cov) == 1 and f"total={len(lines)}" in cov[0] \
        and f"checked={len(lines)}" in cov[0] and "failed=0" in cov[0] \
        and "status=OK" in cov[0], cov
    print(f"1. pipeline stub test: PASS (1 HIT at rank {rank_true}, "
          f"coverage {len(lines)}/{len(lines)})")

    # ---------- 2. slice partition on a small multiset space ----------
    # counts (6,3,2,1) -> total = 12!/(6! 3! 2! 1!) = 55440
    small = " ".join(["abandon"] * 6 + ["ability"] * 3 + ["able"] * 2
                     + ["about"])
    r = run("--rank", "--words", small)
    tot = int(r.stdout.split()[3])
    assert tot == 55440, tot
    full = hunt_lines(small, 0, tot)
    full_ranks = {int(l.split()[0]) for l in full}
    assert len(full_ranks) == len(full), "full run emitted duplicate ranks"
    bounds = [(0, 20000), (20000, 40000), (40000, tot)]
    union = set()
    for lo, hi in bounds:
        part = hunt_lines(small, lo, hi)
        pranks = {int(l.split()[0]) for l in part}
        assert len(pranks) == len(part), "slice emitted duplicate ranks"
        assert not (union & pranks), "slices overlap"
        union |= pranks
    assert union == full_ranks, "slice union != full range"
    print(f"2. slice partition: PASS ({len(full_ranks)} survivors, "
          f"3 disjoint slices == full range)")

    # shard-style partition too (same resolve_range path as the workflow)
    shard_sets = []
    for si in range(4):
        r = run("--hunt", "--words", small, "--shard-index", str(si),
                "--shard-count", "4")
        assert r.returncode == 0, r.stderr
        shard_sets.append({int(l.split()[0])
                           for l in r.stdout.splitlines() if l.strip()})
    u = set().union(*shard_sets)
    assert u == full_ranks and sum(len(s) for s in shard_sets) == len(u), \
        "shard partition broken"
    print("2b. shard partition (--shard-index/--shard-count): PASS")

    # ---------- 3. duplicate-word row: total = 12!/2 ----------
    rng = random.Random(2026)
    phrase1 = None
    for _ in range(2000):
        cand = xcheck.mnemonic_from_entropy(rng.randbytes(16))
        ws = cand.split()
        counts = sorted(ws.count(w) for w in set(ws))
        if counts == [1] * 10 + [2]:
            phrase1 = cand
            break
    assert phrase1 is not None, "no one-pair phrase found"
    r = run("--rank", "--words", phrase1)
    tot1 = int(r.stdout.split()[3])
    assert tot1 == 239500800, tot1  # 12! / 2
    print(f"3. duplicate-word total: PASS (12!/2 = {tot1})")

    print("ALL HUNT TESTS PASS")


if __name__ == "__main__":
    main()
