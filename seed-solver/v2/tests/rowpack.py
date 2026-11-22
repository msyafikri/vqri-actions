"""Packed multi-row secret parsing for the seed-solve-v2 workflow.

The real event drops several rows (word set + address) at once, but repo
secrets hold single values, so rows are packed as parallel ';'-separated
lists:

    SEED_WORDS  = "w1 w2 ... w12 ; w1 w2 ... w12 ; ..."
    SEED_TARGET = "addr1 ; addr2 ; ..."

select_row() picks one 1-based row. A secret without ';' is a single row
(backward compatible with the v1 workflow). This module is the single
source of truth: the GitHub workflow imports it from the checked-out
repo, and tests/test_rowpack.py verifies it locally with synthetic data.
"""


def split_packed(s):
    return [p.strip() for p in s.split(";") if p.strip()]


def select_row(words_s, targets_s, row):
    words = split_packed(words_s)
    targets = split_packed(targets_s)
    if not words or len(words) != len(targets):
        raise ValueError("packed secrets length mismatch")
    if row < 1 or row > len(words):
        raise ValueError("row out of range")
    return words[row - 1], targets[row - 1]


def select_row_words(words_s, row):
    """Words-only variant for balance-hunt events, which publish word
    sets with NO target addresses (SEED_TARGET is absent/empty there).
    Same ';' packing and 1-based row indexing as select_row()."""
    words = split_packed(words_s)
    if not words:
        raise ValueError("no packed rows")
    if row < 1 or row > len(words):
        raise ValueError("row out of range")
    return words[row - 1]
