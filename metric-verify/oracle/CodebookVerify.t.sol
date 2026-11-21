// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Codebook256} from "../../contracts/oracles/utils/Codebook256.sol";
import {U64x32} from "../../contracts/oracles/utils/U64x32.sol";
import {CompressedOracleV1} from "../../contracts/oracles/compressed/CompressedOracle.sol";
import {IOffchainOracle} from "../../contracts/interfaces/IOffchainOracle.sol";

/// @notice Exposes the internal codebook library functions.
contract CodebookHarness {
    function decode(uint8 i) external pure returns (uint16, bool) {
        return Codebook256.decode(i);
    }

    function getTable() external pure returns (uint16[] memory) {
        return Codebook256.getTable();
    }

    function u64x32Decode(uint32 p) external pure returns (uint64) {
        return U64x32.decode(p);
    }
}

contract CodebookVerifyTest is Test {
    CodebookHarness internal cb;
    CompressedOracleV1 internal oracle;

    uint256 internal failures;

    function setUp() public {
        cb = new CodebookHarness();
        oracle = new CompressedOracleV1(address(this), 3600);
        vm.warp(1_700_000_000);
    }

    // ── Table properties through the on-chain API ────────────────────────────
    function test_tableProperties() public {
        uint16[] memory t = cb.getTable();
        assertEq(t.length, 256, "getTable length (index 255 must be present)");
        uint256 prev;
        for (uint256 i; i < 256; i++) {
            (uint16 v, bool ok) = cb.decode(uint8(i));
            assertTrue(ok, "decode ok");
            assertEq(v, t[i], "decode == getTable entry");
            assertLe(v, Codebook256.MAX_VALUE, "value above MAX_VALUE");
            if (i > 0) assertGe(v, prev, "monotonicity");
            prev = v;
        }
        assertEq(t[255], Codebook256.MAX_VALUE, "saturated tail at 255");
        emit log_named_uint("table entries verified", 256);
    }

    // ── Round-trip: every value 0..10000 encodes to the first index whose
    //    entry is >= the value, and decodes back to that entry ────────────────
    function test_roundTrip() public {
        uint16[] memory t = cb.getTable();
        uint256 idx;
        for (uint256 v; v <= 10000; v++) {
            while (idx < 255 && t[idx] < v) idx++;
            (uint16 dv, bool ok) = cb.decode(uint8(idx));
            assertTrue(ok);
            assertEq(dv, t[idx], "round-trip decode");
            assertGe(dv, v, "round-trip covers value");
            if (idx > 0) assertLt(t[idx - 1], v, "first-index-minimality");
        }
        emit log_named_uint("round-trip values verified", 10001);
    }

    // ── U64x32 decode consistency on structured samples ─────────────────────
    function test_u64x32Samples() public {
        uint256 checked;
        for (uint256 e; e < 32; e++) {
            uint32[6] memory ms = [uint32(0), 1, 2, (1 << 26), (1 << 27) - 1, 0x5555555];
            for (uint256 k; k < 6; k++) {
                uint32 packed = uint32((e << 27) | ms[k]);
                uint64 got = cb.u64x32Decode(packed);
                uint64 exp = uint64(ms[k]) << e;
                assertEq(got, exp, "u64x32 decode");
                checked++;
            }
        }
        emit log_named_uint("u64x32 samples verified", checked);
    }

    // ── End-to-end: exhaustive (s0, s1) sweep through CompressedOracle ──────
    // 64 creators x 256 slots x 4 positions = 65536 packed entries covering
    // every (s0, s1) index pair exactly once. Slot words are written directly
    // to the oracle's storage slots (decode path under test; push auth is
    // covered by the repo's own suites).
    uint32 internal constant P_SAMPLE = 0x4E6A5A00; // arbitrary U64x32-packed price
    uint56 internal constant TS_MS = 1_700_000_000_000;

    function _writePair(uint256 pairIdx) internal {
        uint8 s0 = uint8(pairIdx >> 8);
        uint8 s1 = uint8(pairIdx & 0xff);
        uint256 within = pairIdx & 0x3ff; // position within creator namespace (1024)
        uint256 creatorIdx = pairIdx >> 10;
        address creator = address(uint160(0xC0DE0000 + creatorIdx));
        uint8 slotIdx = uint8(within >> 2);
        uint256 pos = within & 3;
        // Read-modify-write the slot word so sibling positions survive.
        bytes32 key = bytes32((uint256(uint160(creator)) << 96) | uint256(slotIdx));
        uint256 word = uint256(vm.load(address(oracle), key));
        uint48 data = (uint48(P_SAMPLE) << 16) | (uint48(s0) << 8) | uint48(s1);
        uint256 shift = 208 - 48 * pos;
        word = (word & ~(uint256(0xFFFFFFFFFFFF) << shift)) | (uint256(data) << shift);
        word = (word & ~(uint256(0xFFFFFFFFFFFFFF) << 8)) | (uint256(TS_MS) << 8);
        vm.store(address(oracle), key, bytes32(word));
    }

    function _checkPair(uint256 pairIdx, uint16[] memory t) internal {
        uint8 s0 = uint8(pairIdx >> 8);
        uint8 s1 = uint8(pairIdx & 0xff);
        uint256 within = pairIdx & 0x3ff;
        uint256 creatorIdx = pairIdx >> 10;
        address creator = address(uint160(0xC0DE0000 + creatorIdx));
        uint8 slotIdx = uint8(within >> 2);
        uint8 pos = uint8(within & 3);
        bytes32 feedId = oracle.feedIdOf(creator, slotIdx, pos);
        IOffchainOracle.OracleData memory d = oracle.getOracleData(feedId);
        if (s0 == 0xff && s1 == 0xff) {
            if (!(d.spread0 == 65535 && d.spread1 == 65535 && d.price == 0)) {
                failures++;
                emit log_named_uint("STALL pair mishandled", pairIdx);
            }
            return;
        }
        if (d.spread0 != t[s0] || d.spread1 != t[s1] || d.price != U64x32.decode(P_SAMPLE)) {
            failures++;
            if (failures <= 10) {
                emit log_named_uint("PAIR mismatch", pairIdx);
                emit log_named_uint("  s0", s0);
                emit log_named_uint("  s1", s1);
                emit log_named_uint("  expSpread0", t[s0]);
                emit log_named_uint("  gotSpread0", d.spread0);
                emit log_named_uint("  expSpread1", t[s1]);
                emit log_named_uint("  gotSpread1", d.spread1);
            }
        }
        // Spread clamp: a compressed feed's spread never exceeds MAX_VALUE on
        // the read path (stall sentinel aside).
        if (d.spread0 > 10000 || d.spread1 > 10000) {
            failures++;
            emit log_named_uint("SPREAD above MAX_VALUE", pairIdx);
        }
    }

    function _sweep(uint256 from, uint256 to) internal {
        uint16[] memory t = cb.getTable();
        for (uint256 p = from; p < to; p++) _writePair(p);
        for (uint256 p = from; p < to; p++) _checkPair(p, t);
        emit log_named_uint("pairs checked in sweep", to - from);
    }

    function test_sweep_0() public { _sweep(0, 8192); assertEq(failures, 0); }
    function test_sweep_1() public { _sweep(8192, 16384); assertEq(failures, 0); }
    function test_sweep_2() public { _sweep(16384, 24576); assertEq(failures, 0); }
    function test_sweep_3() public { _sweep(24576, 32768); assertEq(failures, 0); }
    function test_sweep_4() public { _sweep(32768, 40960); assertEq(failures, 0); }
    function test_sweep_5() public { _sweep(40960, 49152); assertEq(failures, 0); }
    function test_sweep_6() public { _sweep(49152, 57344); assertEq(failures, 0); }
    function test_sweep_7() public { _sweep(57344, 65536); assertEq(failures, 0); }

    // ── price() read path spot-check incl. stall sentinel ────────────────────
    function test_pricePath() public {
        uint16[] memory t = cb.getTable();
        _writePair(0x1234); // s0=0x12, s1=0x34
        _writePair(0xffff); // stall pair
        uint256 within = 0x1234 & 0x3ff;
        address creator = address(uint160(0xC0DE0000 + (0x1234 >> 10)));
        bytes32 feedId = oracle.feedIdOf(creator, uint8(within >> 2), uint8(within & 3));
        (uint256 mid, uint256 spread, uint16 spread1, uint256 refTime) = oracle.price(feedId, address(this));
        assertEq(mid, U64x32.decode(P_SAMPLE));
        assertEq(spread, t[0x12]);
        assertEq(spread1, t[0x34]);
        assertEq(refTime, TS_MS / 1000);

        uint256 w2 = 0xffff & 0x3ff;
        address creator2 = address(uint160(0xC0DE0000 + (0xffff >> 10)));
        bytes32 stallFeed = oracle.feedIdOf(creator2, uint8(w2 >> 2), uint8(w2 & 3));
        (uint256 mid2, uint256 spread2, uint16 spread12, uint256 refTime2) = oracle.price(stallFeed, address(this));
        assertEq(mid2, 0);
        assertEq(spread2, 65535);
        assertEq(spread12, 65535);
        assertEq(refTime2, 0);
    }
}
