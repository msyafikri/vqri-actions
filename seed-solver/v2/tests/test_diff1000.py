#!/usr/bin/env python3
"""Differential gate for v2:
- 1000 random valid phrases (12w + some 24w): v2 --derive must equal
  v1 --derive byte-for-byte (seed + 5 hardened paths).
- v2 'raw' path output must equal the independent oracle's
  base58(rfc8032_pubkey(seed[:32])).
"""
import random
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xcheck

V2 = Path(__file__).resolve().parent.parent / "seed_solver"
V1 = Path(__file__).resolve().parent.parent.parent / "seed_solver"
PATHS = "44'/501'/0'/0';44'/501'/0';44'/501'/0'/0'/0';44'/501'/1'/0';44'/501'/0'/1'"

def run(binpath, *args):
    r = subprocess.run([str(binpath), *args], capture_output=True, text=True)
    assert r.returncode == 0, (binpath, args, r.returncode, r.stdout, r.stderr)
    return r.stdout

def main():
    xcheck.self_test()
    rng = random.Random(20261122)
    n_checked = 0
    for i in range(1000):
        nbytes = 16 if i < 900 else 32
        ent = bytes(rng.randrange(256) for _ in range(nbytes))
        mn = xcheck.mnemonic_from_entropy(ent)
        o1 = run(V1, "--derive", "--words", mn, "--print-seed",
                 "--paths", PATHS)
        o2 = run(V2, "--derive", "--words", mn, "--print-seed",
                 "--paths", PATHS)
        assert o1 == o2, (mn, o1, o2)
        # raw path vs oracle
        o3 = run(V2, "--derive", "--words", mn, "--paths", "raw")
        seed = xcheck.seed_from_mnemonic(mn)
        want = xcheck.base58_encode(xcheck.rfc8032_pubkey(seed[:32]))
        assert o3.strip() == f"raw {want}", (mn, o3, want)
        n_checked += 1
    print(f"differential v1-vs-v2 (1000 phrases x seed+5 paths): PASS")
    print(f"v2 raw path vs oracle (1000 phrases): PASS")

if __name__ == "__main__":
    main()
