#!/usr/bin/env python3
"""Find-the-phrase tests: shuffle a synthetic valid phrase, run the solver
on the shard that contains the true ordering, assert it recovers the exact
original ordering; a neighbouring shard must find nothing.
Also exercises the 24-word path (8-bit checksum) end to end.
"""
import random
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xcheck

BIN = Path(__file__).resolve().parent.parent / "seed_solver"

def run(*args):
    return subprocess.run([str(BIN), *args], capture_output=True, text=True)

def main():
    xcheck.self_test()

    # ---------- 12 words, three duplicate pairs ----------
    phrase = xcheck.mnemonic_from_entropy(bytes([0x80] * 16))
    words = phrase.split()
    assert len(words) == 12
    target = xcheck.solana_address(phrase)
    # C --derive must agree on the target before we hunt for it
    out = run("--derive", "--words", phrase)
    assert target in out.stdout, out.stdout

    r = run("--rank", "--words", phrase)
    parts = r.stdout.split()
    rank_true, total = int(parts[1]), int(parts[3])
    assert total == 59875200, total  # 12! / (2! 2! 2!)

    shuffled = words[:]
    random.Random(404).shuffle(shuffled)
    shuffled_s = " ".join(shuffled)
    assert shuffled_s != phrase

    shards = 512
    shard = rank_true * shards // total
    r = run("--words", shuffled_s, "--targets", target,
            "--shard-index", str(shard), "--shard-count", str(shards))
    assert r.returncode == 0, (r.returncode, r.stdout, r.stderr)
    mlines = [l for l in r.stdout.splitlines() if l.startswith("MATCH ")]
    assert len(mlines) == 1, r.stdout
    got_phrase = mlines[0].split(" ", 3)[3]
    assert got_phrase == phrase, (got_phrase, phrase)
    assert mlines[0].split()[1] == target
    print(f"12-word find: PASS (shard {shard}/{shards}, rank {rank_true}/{total}, "
          f"exact original ordering recovered)")

    # neighbouring shard: no match, exit 1
    other = (shard + 1) % shards
    r = run("--words", shuffled_s, "--targets", target,
            "--shard-index", str(other), "--shard-count", str(shards))
    assert r.returncode == 1 and "MATCH" not in r.stdout, (r.returncode, r.stdout)
    print(f"12-word negative shard {other}/{shards}: PASS (no match, exit 1)")

    # multi-target + second path: target on the Solflare-style path too
    target2 = xcheck.solana_address(phrase, (44, 501, 0))
    r = run("--words", shuffled_s, "--targets", f"{target},{target2}",
            "--paths", "44'/501'/0'/0';44'/501'/0'",
            "--shard-index", str(shard), "--shard-count", str(shards),
            "--continue")
    assert r.returncode == 0 and r.stdout.count("MATCH ") == 2, r.stdout
    print("multi-target + multi-path find: PASS (both paths matched)")

    # ---------- 24 words (8-bit checksum), tiny distinct space ----------
    phrase24 = xcheck.mnemonic_from_entropy(bytes(32))
    w24 = phrase24.split()
    assert len(w24) == 24 and xcheck.mnemonic_valid(phrase24)
    target24 = xcheck.solana_address(phrase24)
    out = run("--derive", "--words", phrase24)
    assert target24 in out.stdout, out.stdout
    sh24 = w24[:]
    random.Random(7).shuffle(sh24)
    r = run("--words", " ".join(sh24), "--targets", target24)
    assert r.returncode == 0, (r.returncode, r.stdout, r.stderr)
    mlines = [l for l in r.stdout.splitlines() if l.startswith("MATCH ")]
    assert len(mlines) == 1 and mlines[0].split(" ", 3)[3] == phrase24, r.stdout
    print("24-word find: PASS (exact ordering recovered, 8-bit checksum path)")

    print("ALL FIND TESTS PASS")

if __name__ == "__main__":
    main()
