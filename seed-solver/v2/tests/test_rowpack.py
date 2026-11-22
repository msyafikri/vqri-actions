#!/usr/bin/env python3
"""Unit test for the multi-row packed-secret parsing used by the
seed-solve-v2 workflow. Synthetic data only."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rowpack import select_row, split_packed

W1 = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima"
W2 = "mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray"
T1 = "AddrOne1111111111111111111111111111111111"
T2 = "AddrTwo2222222222222222222222222222222222"

def expect_err(fn, needle):
    try:
        fn()
    except ValueError as e:
        assert needle in str(e), (needle, e)
        return
    raise AssertionError(f"expected ValueError containing {needle!r}")

def main():
    # single row, no ';' (backward compatible with v1 secrets)
    assert select_row(W1, T1, 1) == (W1, T1)
    # two packed rows with ' ; ' separators
    pw, pt = f"{W1} ; {W2}", f"{T1} ; {T2}"
    assert select_row(pw, pt, 1) == (W1, T1)
    assert select_row(pw, pt, 2) == (W2, T2)
    # tight separators, stray whitespace, trailing ';'
    pw2, pt2 = f"  {W1};{W2} ; ", f"{T1};  {T2};"
    assert select_row(pw2, pt2, 2) == (W2, T2)
    assert split_packed("") == []
    # errors: mismatched list lengths, row out of range, empty secrets
    expect_err(lambda: select_row(pw, T1, 1), "mismatch")
    expect_err(lambda: select_row(pw, pt, 3), "out of range")
    expect_err(lambda: select_row(pw, pt, 0), "out of range")
    expect_err(lambda: select_row("", "", 1), "mismatch")
    print("rowpack parsing (single-row compat, 2-row select, whitespace, errors): PASS")

if __name__ == "__main__":
    main()
