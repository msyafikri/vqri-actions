// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnchoredPriceProvider} from "../../contracts/AnchoredPriceProvider.sol";
import {IAnchoredProviderFactory} from "../../contracts/interfaces/IAnchoredProviderFactory.sol";
import {GenCases} from "./GenCases.sol";

/// @notice Exposes the provider's internal band math for verification.
contract APPHarness is AnchoredPriceProvider {
    constructor(
        address factory_,
        address oracle_,
        bytes32 baseFeedId_,
        bytes32 quoteFeedId_,
        uint256 minMargin_,
        uint256 maxRefStaleness_,
        uint256 maxSpreadMult_,
        bool mutableParams_,
        int256 marginStep_,
        address baseToken_,
        address quoteToken_,
        IAnchoredProviderFactory.InitialConfig memory init_
    )
        AnchoredPriceProvider(
            factory_,
            oracle_,
            baseFeedId_,
            quoteFeedId_,
            minMargin_,
            maxRefStaleness_,
            maxSpreadMult_,
            mutableParams_,
            marginStep_,
            baseToken_,
            quoteToken_,
            init_
        )
    {}

    function computeBidAsk(
        uint256 midNum,
        uint256 midDen,
        uint256 spreadBps,
        uint256 baseHalf,
        uint256 quoteHalf,
        bool synthetic
    ) external view returns (uint128, uint128, uint128) {
        return _computeBidAsk(midNum, midDen, spreadBps, baseHalf, quoteHalf, synthetic);
    }

    function scaledHalf(uint256 s, uint256 m) external pure returns (uint256) {
        return _scaledHalf(s, m);
    }
}

/// @notice Minimal standalone anchor oracle (selector-compatible with the provider's reads).
contract MockAnchorOracle {
    struct Leg {
        uint256 mid;
        uint256 spread;
        uint256 refTime;
    }

    mapping(bytes32 => Leg) public legs;

    function setLeg(bytes32 feedId, uint256 mid, uint256 spread, uint256 refTime) external {
        legs[feedId] = Leg(mid, spread, refTime);
    }

    function price(bytes32 feedId, address) external view returns (uint256, uint256, uint16, uint256) {
        Leg memory l = legs[feedId];
        return (l.mid, l.spread, 0, l.refTime);
    }

    function priceGuard(bytes32) external pure returns (uint128, uint128) {
        return (0, 0); // 0 max is treated as unbounded by the provider
    }
}

/// @notice Settable custom quote source (selector-compatible with IAnchorSource.getQuote).
contract FuzzSource {
    uint256 public b;
    uint256 public a;
    uint256 public r;

    function set(uint256 b_, uint256 a_, uint256 r_) external {
        b = b_;
        a = a_;
        r = r_;
    }

    function getQuote() external view returns (uint256, uint256, uint256) {
        return (b, a, r);
    }
}

contract BandMathVerifyTest is Test {
    uint256 internal constant Q64 = 1 << 64;
    uint256 internal constant BPS = 1e18;
    uint256 internal constant DEC8 = 1e8;
    uint256 internal constant U128MAX = type(uint128).max;

    // Must mirror model_app.py: MM_LIST and SHAPED_DEPLOYS.
    uint256[5] internal MM = [uint256(1), 1e12, 5e13, 1e15, 5e16];
    uint256[2] internal SHAPED_MM = [uint256(5e13), 1e15];
    int256[5] internal SHAPED_MS = [int256(-3e17), -1e17, 0, 1e17, 3e17];

    bytes32 internal constant FEED = keccak256("band-feed");
    bytes32 internal constant FEED2 = keccak256("band-feed-2");
    address internal constant TOK0 = address(0x1001);
    address internal constant TOK1 = address(0x1002);

    APPHarness[5] internal bandApps;
    APPHarness[10] internal shapedApps;
    APPHarness internal sourceApp;
    MockAnchorOracle internal mockOracle;
    FuzzSource internal fuzzSource;

    uint256 internal failures;

    function _init(uint256 staleness, uint256 mult)
        internal
        pure
        returns (IAnchoredProviderFactory.InitialConfig memory)
    {
        return IAnchoredProviderFactory.InitialConfig({
            source: address(0),
            baseMaxStaleness: staleness,
            quoteMaxStaleness: staleness,
            baseSpreadMult: mult,
            quoteSpreadMult: mult
        });
    }

    function _deploy(uint256 mm, bool mutable_, int256 ms, address factory_)
        internal
        returns (APPHarness)
    {
        return new APPHarness(
            factory_,
            address(mockOracle),
            FEED,
            FEED2,
            mm,
            7 days,
            4e18,
            mutable_,
            ms,
            TOK0,
            TOK1,
            _init(7 days, 1e18)
        );
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        mockOracle = new MockAnchorOracle();
        fuzzSource = new FuzzSource();
        for (uint256 i; i < 5; i++) {
            bandApps[i] = _deploy(MM[i], false, 0, address(0xFACC));
        }
        uint256 k;
        for (uint256 a; a < 2; a++) {
            for (uint256 b; b < 5; b++) {
                shapedApps[k++] = _deploy(SHAPED_MM[a], true, SHAPED_MS[b], address(this));
            }
        }
        sourceApp = _deploy(5e13, false, 0, address(this));
        sourceApp.setSource(address(fuzzSource));
    }

    // ── Model grid: _scaledHalf ──────────────────────────────────────────────
    function test_modelGrid_scaledHalf() public {
        uint256 rows = GenCases.halfRows();
        uint256 w = GenCases.HALF_W;
        for (uint256 c; c < GenCases.halfChunks(); c++) {
            uint256[] memory a = GenCases.halfChunk(c);
            for (uint256 i; i + w <= a.length; i += w) {
                uint256 got = bandApps[0].scaledHalf(a[i], a[i + 1]);
                if (got != a[i + 2]) {
                    failures++;
                    if (failures <= 10) {
                        emit log_named_uint("HALF mismatch row", (c * 700) + i / w);
                        emit log_named_uint("  spread", a[i]);
                        emit log_named_uint("  mult", a[i + 1]);
                        emit log_named_uint("  expected", a[i + 2]);
                        emit log_named_uint("  got", got);
                    }
                }
            }
        }
        emit log_named_uint("half rows checked", rows);
        assertEq(failures, 0, "scaledHalf mismatches");
    }

    // ── Model grid: reference band ───────────────────────────────────────────
    function test_modelGrid_band() public {
        uint256 rows = GenCases.bandRows();
        uint256 w = GenCases.BAND_W;
        for (uint256 c; c < GenCases.bandChunks(); c++) {
            uint256[] memory a = GenCases.bandChunk(c);
            for (uint256 i; i + w <= a.length; i += w) {
                bool synthetic = a[i] == 1;
                uint256 midDen = synthetic ? a[i + 2] : DEC8;
                (uint128 bid, uint128 ask, uint128 ref) =
                    bandApps[a[i + 5]].computeBidAsk(a[i + 1], midDen, 0, a[i + 3], a[i + 4], synthetic);
                if (bid != a[i + 6] || ask != a[i + 7] || ref != a[i + 8]) {
                    failures++;
                    if (failures <= 10) {
                        emit log_named_uint("BAND mismatch row", (c * 300) + i / w);
                        emit log_named_uint("  synthetic", a[i]);
                        emit log_named_uint("  mid1", a[i + 1]);
                        emit log_named_uint("  mid2", a[i + 2]);
                        emit log_named_uint("  baseHalf", a[i + 3]);
                        emit log_named_uint("  quoteHalf", a[i + 4]);
                        emit log_named_uint("  mmIdx", a[i + 5]);
                        emit log_named_uint("  expBid", a[i + 6]);
                        emit log_named_uint("  gotBid", bid);
                        emit log_named_uint("  expAsk", a[i + 7]);
                        emit log_named_uint("  gotAsk", ask);
                        emit log_named_uint("  expRef", a[i + 8]);
                        emit log_named_uint("  gotRef", ref);
                    }
                }
            }
        }
        emit log_named_uint("band rows checked", rows);
        assertEq(failures, 0, "band mismatches");
    }

    // ── Model grid: shaped quote (customizable variant, clamped) ─────────────
    function test_modelGrid_shaped() public {
        uint256 rows = GenCases.shapedRows();
        uint256 w = GenCases.SHAPED_W;
        int256[10] memory curConf;
        bool[10] memory confSet;
        for (uint256 c; c < GenCases.shapedChunks(); c++) {
            uint256[] memory a = GenCases.shapedChunk(c);
            for (uint256 i; i + w <= a.length; i += w) {
                uint256 dep = a[i];
                uint256 conf = a[i + 1];
                if (!confSet[dep] || curConf[dep] != int256(conf)) {
                    vm.warp(block.timestamp + 61);
                    shapedApps[dep].setConfidenceParam(conf);
                    curConf[dep] = int256(conf);
                    confSet[dep] = true;
                }
                bool synthetic = a[i + 2] == 1;
                uint256 midDen = synthetic ? a[i + 4] : DEC8;
                (uint128 bid, uint128 ask, uint128 ref) = shapedApps[dep].computeBidAsk(
                    a[i + 3], midDen, a[i + 5], a[i + 6], a[i + 7], synthetic
                );
                if (bid != a[i + 8] || ask != a[i + 9] || ref != a[i + 10]) {
                    failures++;
                    if (failures <= 10) {
                        emit log_named_uint("SHAPED mismatch row", (c * 200) + i / w);
                        emit log_named_uint("  dep", dep);
                        emit log_named_uint("  conf", conf);
                        emit log_named_uint("  synthetic", a[i + 2]);
                        emit log_named_uint("  mid1", a[i + 3]);
                        emit log_named_uint("  mid2", a[i + 4]);
                        emit log_named_uint("  spreadSum", a[i + 5]);
                        emit log_named_uint("  baseHalf", a[i + 6]);
                        emit log_named_uint("  quoteHalf", a[i + 7]);
                        emit log_named_uint("  expBid", a[i + 8]);
                        emit log_named_uint("  gotBid", bid);
                        emit log_named_uint("  expAsk", a[i + 9]);
                        emit log_named_uint("  gotAsk", ask);
                        emit log_named_uint("  expRef", a[i + 10]);
                        emit log_named_uint("  gotRef", ref);
                    }
                }
            }
        }
        emit log_named_uint("shaped rows checked", rows);
        assertEq(failures, 0, "shaped mismatches");
    }

    // ── Property fuzz: single-feed band ──────────────────────────────────────
    function testFuzz_bandProperties(uint256 mid, uint256 s, uint256 m) public {
        mid = bound(mid, 1, 1 << 120);
        s = bound(s, 0, 65533);
        m = bound(m, 0, 4e18);
        uint256 mm = 5e13;
        APPHarness app = bandApps[2];
        uint256 bh = app.scaledHalf(s, m);
        (uint128 bid, uint128 ask, uint128 ref) = app.computeBidAsk(mid, DEC8, s, bh, 0, false);
        if (bid == 0) {
            assertEq(ask, U128MAX, "halt sentinel shape");
            assertEq(ref, 0, "halt sentinel ref");
        } else {
            assertLt(bid, ask, "bid<ask");
            assertLe(bid, ref, "bid<=ref");
            assertLe(ref, ask, "ref<=ask");
            // Never tighter than the exact band edges (cross-multiplied, exact).
            assertLe(uint256(bid) * DEC8 * BPS, mid * Q64 * (BPS - bh - mm), "bid inside band");
            assertGe(uint256(ask) * DEC8 * BPS, (mid + 1) * Q64 * (BPS + bh + mm), "ask inside band");
        }
        // No spurious halt in the definitely-valid region.
        if (bh <= 2e17 && mid >= 1e6 && mid <= 1e12) {
            assertGt(bid, 0, "spurious halt in valid region");
        }
    }

    // ── Property fuzz: synthetic band ────────────────────────────────────────
    function testFuzz_syntheticProperties(uint256 mid1, uint256 mid2, uint256 s1, uint256 s2, uint256 m1, uint256 m2)
        public
    {
        mid1 = bound(mid1, 1, 1 << 120);
        mid2 = bound(mid2, 1, 1 << 120);
        s1 = bound(s1, 0, 65533);
        s2 = bound(s2, 0, 65533);
        m1 = bound(m1, 0, 4e18);
        m2 = bound(m2, 0, 4e18);
        APPHarness app = bandApps[2];
        uint256 bh = app.scaledHalf(s1, m1);
        uint256 qh = app.scaledHalf(s2, m2);
        (uint128 bid, uint128 ask, uint128 ref) =
            app.computeBidAsk(mid1, mid2, s1 + s2, bh, qh, true);
        if (bid == 0) {
            assertEq(ask, U128MAX, "halt sentinel shape");
        } else {
            assertLt(bid, ask, "bid<ask");
            assertLe(bid, ref, "bid<=ref");
            assertLe(ref, ask, "ref<=ask");
        }
        // No spurious halt in a moderate region: halves <= 10% each, cross in [1e-3, 1e3].
        if (bh <= 1e17 && qh <= 1e17 && mid1 * 1000 >= mid2 && mid2 * 1000 >= mid1 && mid1 >= 1e6 && mid2 >= 1e6) {
            assertGt(bid, 0, "spurious synthetic halt in valid region");
        }
    }

    // ── Property fuzz: shaping/source clamp never tighter than the band ──────
    function testFuzz_clampNeverTighter(uint256 mid, uint256 s, uint256 m, uint256 conf, uint256 srcSeed) public {
        mid = bound(mid, 1e6, 1e12);
        s = bound(s, 0, 20000);
        m = bound(m, 0, 4e18);
        conf = bound(conf, 0, 1_000_000);
        APPHarness band = bandApps[2]; // mm = 5e13, immutable
        uint256 bh = band.scaledHalf(s, m);
        (uint128 bBid, uint128 bAsk, uint128 bRef) = band.computeBidAsk(mid, DEC8, s, bh, 0, false);
        if (bBid == 0) return; // band itself halts; nothing to clamp against

        // Customizable variant, marginStep = 0 deployment (index 2), same minMargin.
        // By design the shaped path fails closed when spreadBps*confidence >=
        // CONFIDENCE_BASE (the shaped bid is zeroed) — a halt there is correct,
        // not an availability bug. Outside that region it must not halt, and
        // whenever it quotes, the clamp must keep it no tighter than the band.
        APPHarness cust = shapedApps[2];
        vm.warp(block.timestamp + 61);
        cust.setConfidenceParam(conf);
        (uint128 cBid, uint128 cAsk, uint128 cRef) = cust.computeBidAsk(mid, DEC8, s, bh, 0, false);
        bool shapedMustHalt = s * conf >= 1e10; // CONFIDENCE_BASE
        if (shapedMustHalt) {
            assertEq(cBid, 0, "shaped path quoted in the fail-closed region");
            assertEq(cAsk, type(uint128).max, "shaped path quoted in the fail-closed region");
        } else {
            assertGt(cBid, 0, "customizable halted on valid band");
            assertLe(cBid, bBid, "shaped bid tighter than band");
            assertGe(cAsk, bAsk, "shaped ask tighter than band");
            assertEq(cRef, bRef, "reference moved by shaping");
            assertLe(cBid, cRef);
            assertLe(cRef, cAsk);
        }

        // Source mode: arbitrary source quote must be clamped to the band or halt.
        uint256 sb = bound(srcSeed, 0, uint256(bAsk) * 2 + 10);
        uint256 sa = sb + bound(srcSeed >> 128, 0, uint256(bAsk) + 10);
        uint256 sr = bound(srcSeed >> 64, sb, sa == sb ? sb : sa);
        fuzzSource.set(sb, sa, sr);
        (uint128 sBid, uint128 sAsk, uint128 sRef) = sourceApp.computeBidAsk(mid, DEC8, s, bh, 0, false);
        bool srcValid = sb > 0 && sb < sa && sa <= U128MAX && sr >= sb && sr <= sa;
        if (!srcValid) {
            assertEq(sBid, 0, "invalid source quote accepted");
        } else {
            assertLe(sBid, bBid, "source bid tighter than band");
            assertGe(sAsk, bAsk, "source ask tighter than band");
            assertEq(sRef, bRef, "reference moved by source");
            assertLe(sBid, sRef);
            assertLe(sRef, sAsk);
        }
    }

    // ── End-to-end wiring: getQuote through the mock oracle equals the model path ──
    function testFuzz_getQuoteWiring(uint256 mid, uint256 s, uint256 m, bool synthetic) public {
        mid = bound(mid, 1, 1 << 120);
        s = bound(s, 0, 65533);
        m = bound(m, 0, 4e18);
        uint256 nowTs = block.timestamp;
        mockOracle.setLeg(FEED, mid, s, nowTs);
        // Provider with per-leg multipliers = m (both legs), minMargin 5e13, staleness 7d.
        APPHarness app = new APPHarness(
            address(0xFACC),
            address(mockOracle),
            FEED,
            synthetic ? FEED2 : bytes32(0),
            5e13,
            7 days,
            4e18,
            false,
            0,
            TOK0,
            TOK1,
            _init(7 days, m)
        );
        uint256 bh = app.scaledHalf(s, m);
        uint128 eBid;
        uint128 eAsk;
        uint128 eRef;
        if (!synthetic) {
            (eBid, eAsk, eRef) = app.computeBidAsk(mid, DEC8, s, bh, 0, false);
        } else {
            uint256 mid2 = bound(mid >> 3, 1, 1 << 120);
            mockOracle.setLeg(FEED2, mid2, s, nowTs);
            (eBid, eAsk, eRef) = app.computeBidAsk(mid, mid2, s + s, bh, bh, true);
        }
        // getQuote reverts FeedStalled exactly when the band path halts.
        try app.getQuote() returns (uint128 bid, uint128 ask, uint128 ref) {
            assertGt(eBid, 0, "getQuote returned while model path halts");
            assertEq(bid, eBid);
            assertEq(ask, eAsk);
            assertEq(ref, eRef);
        } catch {
            assertEq(eBid, 0, "getQuote reverted while model path quotes");
        }
    }
}
