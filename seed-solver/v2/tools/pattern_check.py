#!/usr/bin/env python3
"""Pattern checker for seed_solver --hunt output.

Reads lines "<rank> <base58 address>" on stdin and matches each address
against a set of masked-address patterns (visible prefix + visible suffix,
as published in event clues). Patterns are given as one string:
"prefix1:suffix1;prefix2:suffix2;..." (1-based pattern index = position).

On a match prints:  HIT rank=<r> address=<a> pat=<idx>
At EOF prints:      COVERAGE total=<n> checked=<n> failed=0 hits=<h> status=OK
(checked == total always: matching is local, there is no network to fail.)
"""
import sys


def main() -> int:
    args = sys.argv[1:]
    pat_arg = ""
    inp = sys.stdin
    i = 0
    while i < len(args):
        if args[i] == "--patterns" and i + 1 < len(args):
            pat_arg = args[i + 1]
            i += 2
        elif args[i] == "--input" and i + 1 < len(args):
            inp = open(args[i + 1], "r")
            i += 2
        else:
            i += 1
    patterns = []
    for part in pat_arg.split(";"):
        part = part.strip()
        if not part:
            continue
        pre, _, suf = part.partition(":")
        patterns.append((pre, suf))
    if not patterns:
        print("COVERAGE total=0 checked=0 failed=0 hits=0 status=UNVERIFIED")
        print("pattern_check: no patterns given", file=sys.stderr)
        return 1
    total = 0
    hits = 0
    for line in inp:
        parts = line.split()
        if len(parts) < 2:
            continue
        rank, addr = parts[0], parts[1]
        total += 1
        for idx, (pre, suf) in enumerate(patterns, start=1):
            if addr.startswith(pre) and addr.endswith(suf):
                print(f"HIT rank={rank} address={addr} pat={idx}", flush=True)
                hits += 1
    print(f"COVERAGE total={total} checked={total} failed=0 hits={hits} status=OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
