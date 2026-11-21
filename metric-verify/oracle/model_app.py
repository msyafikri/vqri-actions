#!/usr/bin/env python3
"""
Exact integer model of the AnchoredPriceProvider documented construction
(contract header spec), used to cross-check AnchoredPriceProvider._computeBidAsk
and _shapedQuote outputs case-by-case.

All arithmetic is exact integer mulDiv with explicit floor/ceil, mirroring the
documented construction steps:
  _scaledHalf(s, m)            = ceil(s * 1e12 * m / 1e18)
  _bandEdge(num, den, f, rnd)  = rnd(num * 2^64 * f / (den * 1e18))
  reference band (single)      = floor/ceil edges on mid, ask recomputed on mid+1 (E8 cover)
  reference band (synthetic)   = opposing-edge interval division +/- additive margin (ceil)
  shaped quote                 = mid * (CB -/+ n) / (den * CB) scaled by step factors, then
                                 clamped: bid = min(refBid, sBid), ask = max(refAsk, sAsk)
Halt sentinel: (0, 2**128 - 1, 0).
"""
import random
import sys

Q64 = 1 << 64
BPS = 10**18
ONE_SPREAD_UNIT_E18 = 10**12
ORACLE_DECIMALS = 10**8
CONFIDENCE_BASE = 10**10
CONFIDENCE_MAX = 1_000_000
SATURATED_SPREAD = 65534
UINT128_MAX = (1 << 128) - 1
HALT = (0, UINT128_MAX, 0)


def muldiv(a, b, c, ceil_=False):
    q, r = divmod(a * b, c)
    if ceil_ and r:
        q += 1
    return q


def scaled_half(s, m):
    return muldiv(s * ONE_SPREAD_UNIT_E18, m, BPS, ceil_=True)


def band_edge(num, den, factor, ceil_=False):
    return muldiv(num, Q64 * factor, den * BPS, ceil_=ceil_)


def compute_bid_ask(mid_num, mid_den, spread_bps, base_half, quote_half, mm, synthetic):
    """Reference band only (immutable variant / source=0 path). Returns (bid, ask, ref)."""
    if base_half >= BPS or quote_half >= BPS or mm >= BPS:
        return HALT
    if synthetic:
        ask_half = muldiv(base_half + quote_half, BPS, BPS - quote_half, ceil_=True)
    else:
        ask_half = base_half
    if ask_half >= BPS - mm:
        return HALT
    if synthetic:
        ref_bid = muldiv(mid_num, Q64 * (BPS - base_half), (mid_den + 1) * (BPS + quote_half))
        ref_ask = muldiv(mid_num + 1, Q64 * (BPS + base_half), mid_den * (BPS - quote_half), ceil_=True)
        margin = band_edge(mid_num, mid_den, mm, ceil_=True)
        if ref_bid <= margin:
            return HALT
        ref_bid -= margin
        ref_ask += margin
    else:
        half = base_half + mm
        ref_bid = band_edge(mid_num, mid_den, BPS - half)
        ref_ask = band_edge(mid_num, mid_den, BPS + half, ceil_=True)
    ref_mid = band_edge(mid_num, mid_den, BPS)
    if ref_bid == 0 or ref_ask > UINT128_MAX or ref_bid >= ref_ask:
        return HALT
    if not synthetic:
        ref_ask = band_edge(mid_num + 1, mid_den, BPS + base_half + mm, ceil_=True)
    if ref_ask > UINT128_MAX:
        return HALT
    return (ref_bid, ref_ask, ref_mid)


def shaped_quote(num, den, spread_bps, confidence, margin_step):
    """Returns (ok, s_bid, s_ask)."""
    n = spread_bps * confidence
    shaped_den = den * CONFIDENCE_BASE
    bid_num = 0 if n >= CONFIDENCE_BASE else num * (CONFIDENCE_BASE - n)
    ask_num = num * (CONFIDENCE_BASE + n)
    step_bid = BPS - margin_step
    step_ask = BPS + margin_step
    s_bid = band_edge(bid_num, shaped_den, step_bid)
    s_ask = band_edge(ask_num, shaped_den, step_ask, ceil_=True)
    if s_bid == 0 or s_ask > UINT128_MAX:
        return (False, 0, 0)
    return (True, s_bid, s_ask)


def full_quote(mid_num, mid_den, spread_bps, base_half, quote_half, mm, synthetic,
               confidence, margin_step):
    """Customizable variant, reference mode (source = 0): band + shaped + clamp."""
    band = compute_bid_ask(mid_num, mid_den, spread_bps, base_half, quote_half, mm, synthetic)
    if band == HALT:
        return HALT
    ok, s_bid, s_ask = shaped_quote(mid_num, mid_den, spread_bps, confidence, margin_step)
    if not ok:
        return HALT
    bid_out = min(band[0], s_bid)
    ask_out = max(band[1], s_ask)
    if bid_out == 0 or bid_out >= ask_out:
        return HALT
    return (bid_out, ask_out, band[2])


# ---------------------------------------------------------------------------
# Case generation. Case tuple layouts (all uint256 unless noted):
#   BAND:   [synthetic, mid1, mid2, baseHalf, quoteHalf, mmIdx,
#            expBid, expAsk, expRef]
#           (expBid==0 and expAsk==UINT128_MAX encodes HALT)
#   SHAPED: [deployIdx, confidence, synthetic, mid1, mid2, spreadSum,
#            baseHalf, quoteHalf, expBid, expAsk, expRef]
#           deployIdx indexes SHAPED_DEPLOYS = [(mm, marginStep), ...]
#   HALF:   [spread, mult, expHalf]  (verifies _scaledHalf itself)
# ---------------------------------------------------------------------------

MM_LIST = [1, 10**12, 5 * 10**13, 10**15, 5 * 10**16]
SHAPED_DEPLOYS = [(mm, ms) for mm in (5 * 10**13, 10**15)
                  for ms in (-3 * 10**17, -10**17, 0, 10**17, 3 * 10**17)]

MIDS = [1, 2, 7, 100, 12345, 99999999, 100000000, 100000001, 250000000,
        6723456789012, 10**14, 10**16, (1 << 127) + 12345]
SPREADS = [0, 1, 2, 50, 500, 5000, 20000, 40000, 65533]
MULTS = [0, 10**16, 5 * 10**17, 10**18, 2 * 10**18, 3 * 10**18, 4 * 10**18]


def band_case(rng, synthetic):
    mm_idx = rng.randrange(len(MM_LIST))
    mm = MM_LIST[mm_idx]
    if not synthetic:
        mid = rng.choice(MIDS)
        s = rng.choice(SPREADS)
        m = rng.choice(MULTS)
        bh = scaled_half(s, m)
        exp = compute_bid_ask(mid, ORACLE_DECIMALS, s, bh, 0, mm, False)
        return [0, mid, 0, bh, 0, mm_idx, exp[0], exp[1], exp[2]]
    else:
        mid1 = rng.choice(MIDS)
        mid2 = rng.choice(MIDS)
        s1, s2 = rng.choice(SPREADS), rng.choice(SPREADS)
        m1, m2 = rng.choice(MULTS), rng.choice(MULTS)
        bh, qh = scaled_half(s1, m1), scaled_half(s2, m2)
        exp = compute_bid_ask(mid1, mid2, s1 + s2, bh, qh, mm, True)
        return [1, mid1, mid2, bh, qh, mm_idx, exp[0], exp[1], exp[2]]


def band_case_random(rng, synthetic):
    """Fully random (log-uniform) inputs for broader coverage."""
    mm_idx = rng.randrange(len(MM_LIST))
    mm = MM_LIST[mm_idx]

    def rmid():
        return rng.randrange(1, 1 << rng.choice([7, 14, 27, 40, 53, 66, 90, 127]))

    def rspread():
        return rng.choice([rng.randrange(0, 100), rng.randrange(0, 5000),
                           rng.randrange(0, 65534)])

    def rmult():
        return rng.choice([0, rng.randrange(0, 4 * 10**18), rng.randrange(0, 10**17)])

    if not synthetic:
        mid, s, m = rmid(), rspread(), rmult()
        bh = scaled_half(s, m)
        exp = compute_bid_ask(mid, ORACLE_DECIMALS, s, bh, 0, mm, False)
        return [0, mid, 0, bh, 0, mm_idx, exp[0], exp[1], exp[2]]
    mid1, mid2 = rmid(), rmid()
    s1, s2 = rspread(), rspread()
    m1, m2 = rmult(), rmult()
    bh, qh = scaled_half(s1, m1), scaled_half(s2, m2)
    exp = compute_bid_ask(mid1, mid2, s1 + s2, bh, qh, mm, True)
    return [1, mid1, mid2, bh, qh, mm_idx, exp[0], exp[1], exp[2]]


def shaped_case(rng):
    dep = rng.randrange(len(SHAPED_DEPLOYS))
    mm, ms = SHAPED_DEPLOYS[dep]
    conf = rng.choice([0, 1, 10, 1000, 100000, CONFIDENCE_MAX])
    synthetic = rng.random() < 0.5
    if not synthetic:
        mid = rng.choice(MIDS)
        s = rng.choice(SPREADS)
        m = rng.choice(MULTS)
        bh = scaled_half(s, m)
        exp = full_quote(mid, ORACLE_DECIMALS, s, bh, 0, mm, False, conf, ms)
        return [dep, conf, 0, mid, 0, s, bh, 0, exp[0], exp[1], exp[2]]
    mid1, mid2 = rng.choice(MIDS), rng.choice(MIDS)
    s1, s2 = rng.choice(SPREADS), rng.choice(SPREADS)
    m1, m2 = rng.choice(MULTS), rng.choice(MULTS)
    bh, qh = scaled_half(s1, m1), scaled_half(s2, m2)
    exp = full_quote(mid1, mid2, s1 + s2, bh, qh, mm, True, conf, ms)
    return [dep, conf, 1, mid1, mid2, s1 + s2, bh, qh, exp[0], exp[1], exp[2]]


def half_cases():
    out = []
    for s in list(range(0, 300)) + SPREADS + [65534, 65535, 100000]:
        for m in MULTS + [1, 10**17, 999999999999999999]:
            out.append([s, m, scaled_half(s, m)])
    return out


def _chunk_fn(prefix, idx, rows):
    flat = []
    for r in rows:
        flat.extend(str(x) for x in r)
    lines = [f"    function _{prefix}{idx}() private pure returns (uint256[] memory a) {{"]
    lines.append(f"        a = new uint256[]({len(flat)});")
    for i, v in enumerate(flat):
        lines.append(f"        a[{i}] = {v};")
    lines.append("    }")
    return "\n".join(lines) + "\n"


def _emit_table(f, name, rows, width, chunk_rows):
    for r in rows:
        assert len(r) == width, (name, r)
    chunks = [rows[i:i + chunk_rows] for i in range(0, len(rows), chunk_rows)] or [[]]
    f.write(f"    function {name}Chunks() internal pure returns (uint256) {{ return {len(chunks)}; }}\n")
    f.write(f"    function {name}Rows() internal pure returns (uint256) {{ return {len(rows)}; }}\n")
    dispatch = [f"    function {name}Chunk(uint256 k) internal pure returns (uint256[] memory) {{"]
    for i in range(len(chunks)):
        dispatch.append(f"        if (k == {i}) return _{name}{i}();")
    dispatch.append("        revert(\"chunk\");\n    }")
    f.write("\n".join(dispatch) + "\n")
    for i, ch in enumerate(chunks):
        f.write(_chunk_fn(name, i, ch))


def emit_solidity(path, band, shaped, halves):
    with open(path, "w") as f:
        f.write("// SPDX-License-Identifier: MIT\npragma solidity ^0.8.28;\n\n")
        f.write("/// @notice GENERATED case tables (exact-model expectations). Do not edit.\nlibrary GenCases {\n")
        f.write("    uint256 internal constant BAND_W = 9;\n    uint256 internal constant SHAPED_W = 11;\n    uint256 internal constant HALF_W = 3;\n")
        _emit_table(f, "band", band, 9, 300)
        _emit_table(f, "shaped", shaped, 11, 200)
        _emit_table(f, "half", halves, 3, 700)
        f.write("}\n")


def main():
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    n_band = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
    n_shaped = int(sys.argv[3]) if len(sys.argv) > 3 else 1200
    out = sys.argv[4] if len(sys.argv) > 4 else "VerifyCases.sol"
    rng = random.Random(seed)
    band = []
    for i in range(n_band):
        synthetic = i % 2 == 1
        if i % 3 == 2:
            band.append(band_case_random(rng, synthetic))
        else:
            band.append(band_case(rng, synthetic))
    shaped = [shaped_case(rng) for _ in range(n_shaped)]
    shaped.sort(key=lambda c: (c[0], c[1]))  # group by (deploy, confidence) for the runner
    halves = half_cases()
    emit_solidity(out, band, shaped, halves)
    halts = sum(1 for c in band if c[6] == 0)
    print(f"seed={seed} band={len(band)} (halts {halts}) shaped={len(shaped)} halves={len(halves)} -> {out}")


if __name__ == "__main__":
    main()
