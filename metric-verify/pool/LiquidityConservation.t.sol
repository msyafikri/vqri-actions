// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;
// forge-lint: disable-start(unsafe-typecast)

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MetricOmmPool} from "../../contracts/MetricOmmPool.sol";
import {PoolStateLibrary} from "../../contracts/libraries/PoolStateLibrary.sol";
import {LiquidityDelta} from "../../contracts/types/PoolOperation.sol";
import {BinState} from "../../contracts/types/PoolStorage.sol";
import {PoolExtensions, ExtensionOrders} from "../../contracts/types/PoolExtensionsConfig.sol";
import {IMetricOmmModifyLiquidityCallback} from
    "../../contracts/interfaces/callbacks/IMetricOmmModifyLiquidityCallback.sol";
import {VerifyDeployHelper} from "./VerifyDeployHelper.sol";

contract ConservationToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract ConservationProvider {
    address public token0;
    address public token1;
    uint128 internal bid;
    uint128 internal ask;

    constructor(address t0, address t1, uint128 b, uint128 a) {
        token0 = t0;
        token1 = t1;
        bid = b;
        ask = a;
    }

    function getQuote() external view returns (uint128, uint128, uint128) {
        return (bid, ask, bid); // ref == bid is inside [bid, ask]; asymmetry tolerance disabled in these pools
    }
}

contract ConservationLP is IMetricOmmModifyLiquidityCallback {
    function metricOmmModifyLiquidityCallback(uint256 a0, uint256 a1, bytes calldata data) external {
        (address t0, address t1) = abi.decode(data, (address, address));
        if (a0 > 0) IERC20(t0).transfer(msg.sender, a0);
        if (a1 > 0) IERC20(t1).transfer(msg.sender, a1);
    }

    function add(address pool, uint80 salt, LiquidityDelta calldata d, address t0, address t1)
        external
        returns (uint256, uint256)
    {
        return MetricOmmPool(pool).addLiquidity(address(this), salt, d, abi.encode(t0, t1), "");
    }

    function remove(address pool, uint80 salt, LiquidityDelta calldata d) external returns (uint256, uint256) {
        (uint256 a0, uint256 a1) = MetricOmmPool(pool).removeLiquidity(address(this), salt, d, "");
        return (a0, a1);
    }
}

/// @notice Add/remove-only conservation campaign for LiquidityLib paths.
///         No swaps are executed, so SwapMath never runs. A shadow ledger tracks
///         every position; after every operation the test asserts:
///           (1) sum of per-bin balances == binTotals (both tokens),
///           (2) pool token balances == binTotals (scale multipliers are 1 here),
///           (3) shadow position shares == on-chain position shares,
///         and at the end, after draining every position:
///           (4) pool and bins are empty, and totalOut <= totalIn per token.
contract LiquidityConservationTest is Test {
    uint256 internal constant MIN_OP_LIQ = 1e6;
    uint128 internal constant Q64 = uint128(1) << 64;

    ConservationToken internal token0;
    ConservationToken internal token1;
    ConservationLP[3] internal lps;
    MetricOmmPool internal poolA;
    MetricOmmPool internal poolB;
    MetricOmmPool internal poolC;

    mapping(address => mapping(bytes32 => uint256)) internal shadowPos;
    mapping(address => uint256) internal totalIn0;
    mapping(address => uint256) internal totalIn1;
    mapping(address => uint256) internal totalOut0;
    mapping(address => uint256) internal totalOut1;
    uint256 internal opReverts;

    function setUp() public {
        token0 = new ConservationToken("Token0", "TK0");
        token1 = new ConservationToken("Token1", "TK1");
        for (uint256 i; i < 3; i++) {
            lps[i] = new ConservationLP();
            token0.mint(address(lps[i]), 10**24);
            token1.mint(address(lps[i]), 10**24);
        }
        VerifyDeployHelper helper = new VerifyDeployHelper();
        ConservationProvider provA =
            new ConservationProvider(address(token0), address(token1), Q64, Q64 + 1);
        poolA = MetricOmmPool(_deploy(helper, address(provA), 0, 5));
        poolB = MetricOmmPool(_deploy(helper, address(provA), 0, 10));
        ConservationProvider provC =
            new ConservationProvider(address(token0), address(token1), 5 * Q64 / 2, 5 * Q64 / 2 + 1);
        poolC = MetricOmmPool(_deploy(helper, address(provC), 250000, 10));
    }

    function _deploy(VerifyDeployHelper helper, address provider, int24 curDist, uint256 binsPerSide)
        internal
        returns (address)
    {
        BinState[] memory nn = new BinState[](binsPerSide);
        BinState[] memory ng = new BinState[](binsPerSide);
        for (uint256 i; i < binsPerSide; i++) {
            nn[i] = BinState(0, 0, 100, 0, 0);
            ng[i] = BinState(0, 0, 100, 0, 0);
        }
        return helper.deployPool(
            address(this),
            address(token0),
            address(token1),
            provider,
            curDist,
            15000,
            nn,
            ng,
            PoolExtensions(
                address(0), address(0), address(0), address(0), address(0), address(0), address(0)
            ),
            ExtensionOrders(0, 0, 0, 0, 0, 0)
        );
    }

    function _posKey(address owner, uint80 salt, int16 bin) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt, bin));
    }

    function _checkBooks(MetricOmmPool p, int16 lo, int16 hi) internal view {
        uint256 sum0;
        uint256 sum1;
        for (int16 b = lo; b <= hi; b++) {
            (uint104 b0, uint104 b1,,,) = PoolStateLibrary._binState(address(p), b);
            sum0 += b0;
            sum1 += b1;
        }
        (uint128 t0, uint128 t1) = PoolStateLibrary._slot1(address(p));
        assertEq(sum0, uint256(t0), "sum(bin balances) != binTotals (token0)");
        assertEq(sum1, uint256(t1), "sum(bin balances) != binTotals (token1)");
        assertEq(token0.balanceOf(address(p)), uint256(t0), "pool balance != binTotals (token0)");
        assertEq(token1.balanceOf(address(p)), uint256(t1), "pool balance != binTotals (token1)");
    }

    function _checkPositions(MetricOmmPool p, int16 lo, int16 hi) internal view {
        for (uint256 u; u < 3; u++) {
            for (uint80 salt = 0; salt < 2; salt++) {
                for (int16 b = lo; b <= hi; b++) {
                    uint256 onChain =
                        PoolStateLibrary._positionBinShares(address(p), address(lps[u]), salt, b);
                    assertEq(
                        onChain, shadowPos[address(p)][_posKey(address(lps[u]), salt, b)], "position shares mismatch"
                    );
                }
            }
        }
    }

    function _applyAdd(MetricOmmPool p, uint256 u, uint80 salt, LiquidityDelta memory d) internal {
        try lps[u].add(address(p), salt, d, address(token0), address(token1)) returns (uint256 a0, uint256 a1) {
            totalIn0[address(p)] += a0;
            totalIn1[address(p)] += a1;
            for (uint256 i; i < d.binIdxs.length; i++) {
                shadowPos[address(p)][_posKey(address(lps[u]), salt, int16(d.binIdxs[i]))] += d.shares[i];
            }
        } catch {
            opReverts++;
        }
    }

    function _applyRemove(MetricOmmPool p, uint256 u, uint80 salt, LiquidityDelta memory d) internal {
        try lps[u].remove(address(p), salt, d) returns (uint256 a0, uint256 a1) {
            totalOut0[address(p)] += a0;
            totalOut1[address(p)] += a1;
            for (uint256 i; i < d.binIdxs.length; i++) {
                shadowPos[address(p)][_posKey(address(lps[u]), salt, int16(d.binIdxs[i]))] -= d.shares[i];
            }
        } catch {
            opReverts++;
        }
    }

    function _oneOp(MetricOmmPool p, int16 lo, int16 hi, uint256 r) internal {
        uint256 u = r % 3;
        uint80 salt = uint80((r >> 8) % 2);
        int16 start = int16(lo + int16(int256((r >> 16) % uint256(int256(hi - lo + 1)))));
        uint256 len = 1 + (r >> 24) % 6;
        if (int256(start) + int256(len) - 1 > hi) len = uint256(int256(hi - start + 1));
        bool isAdd = ((r >> 7) & 1) == 0;
        int256[] memory bins = new int256[](len);
        uint256[] memory shares = new uint256[](len);
        uint256 kept;
        for (uint256 k; k < len; k++) {
            int16 bin = int16(int256(start) + int256(k));
            uint256 want = MIN_OP_LIQ + ((r >> (32 + 8 * k)) % (9 * MIN_OP_LIQ));
            if (((r >> 200) % 7) == 0) want += (r >> 40) % (5 * 10**8);
            if (isAdd) {
                bins[kept] = bin;
                shares[kept] = want;
                kept++;
            } else {
                uint256 pos = shadowPos[address(p)][_posKey(address(lps[u]), salt, bin)];
                if (pos == 0) continue;
                uint256 rem = want < pos ? want : pos;
                if (pos - rem > 0 && pos - rem < MIN_OP_LIQ) rem = pos;
                if (rem < MIN_OP_LIQ && rem != pos) continue;
                bins[kept] = bin;
                shares[kept] = rem;
                kept++;
            }
        }
        if (kept == 0) return;
        int256[] memory b2 = new int256[](kept);
        uint256[] memory s2 = new uint256[](kept);
        for (uint256 k; k < kept; k++) {
            b2[k] = bins[k];
            s2[k] = shares[k];
        }
        LiquidityDelta memory d = LiquidityDelta({binIdxs: b2, shares: s2});
        if (isAdd) _applyAdd(p, u, salt, d);
        else _applyRemove(p, u, salt, d);
    }

    function _drain(MetricOmmPool p, int16 lo, int16 hi) internal {
        for (uint256 u; u < 3; u++) {
            for (uint80 salt = 0; salt < 2; salt++) {
                uint256 span = uint256(int256(hi - lo + 1));
                int256[] memory db = new int256[](span);
                uint256[] memory ds = new uint256[](span);
                uint256 kept;
                for (int16 b = lo; b <= hi; b++) {
                    uint256 pos = shadowPos[address(p)][_posKey(address(lps[u]), salt, b)];
                    if (pos > 0) {
                        db[kept] = b;
                        ds[kept] = pos;
                        kept++;
                    }
                }
                if (kept == 0) continue;
                int256[] memory b2 = new int256[](kept);
                uint256[] memory s2 = new uint256[](kept);
                for (uint256 k; k < kept; k++) {
                    b2[k] = db[k];
                    s2[k] = ds[k];
                }
                _applyRemove(p, u, salt, LiquidityDelta({binIdxs: b2, shares: s2}));
            }
        }
    }

    function _runSequence(MetricOmmPool p, int16 lo, int16 hi, uint256 seed, uint256 ops) internal {
        for (uint256 i; i < ops; i++) {
            _oneOp(p, lo, hi, uint256(keccak256(abi.encode(seed, i))));
            _checkBooks(p, lo, hi);
        }
        _checkPositions(p, lo, hi);
        _drain(p, lo, hi);
        _checkBooks(p, lo, hi);
        _checkPositions(p, lo, hi);
        assertEq(token0.balanceOf(address(p)), 0, "pool not empty after drain (token0)");
        assertEq(token1.balanceOf(address(p)), 0, "pool not empty after drain (token1)");
        assertLe(totalOut0[address(p)], totalIn0[address(p)], "token0 created from nothing");
        assertLe(totalOut1[address(p)], totalIn1[address(p)], "token1 created from nothing");
        emit log_named_uint("drain dust token0 (in-out)", totalIn0[address(p)] - totalOut0[address(p)]);
        emit log_named_uint("drain dust token1 (in-out)", totalIn1[address(p)] - totalOut1[address(p)]);
        emit log_named_uint("op reverts", opReverts);
        assertEq(opReverts, 0, "well-formed add/remove reverted");
    }

    function testFuzz_conservation_defaultPool(uint256 seed) public {
        _runSequence(poolA, -3, 2, seed, 40);
    }

    function testFuzz_conservation_widePool(uint256 seed) public {
        _runSequence(poolB, -8, 7, seed, 48);
    }

    function testFuzz_conservation_offCenterPool(uint256 seed) public {
        _runSequence(poolC, -8, 7, seed, 48);
    }

    function testFuzz_roundTrip(uint256 seed, uint256 shareSeed) public {
        uint256 r = uint256(keccak256(abi.encode(seed, shareSeed)));
        int16 lo = int16(-8 + int16(int256(r % 6)));
        int16 hi = int16(lo + int16(int256((r >> 8) % 6)));
        uint256 sharesPerBin = MIN_OP_LIQ + (r >> 16) % (50 * MIN_OP_LIQ);
        uint256 len = uint256(int256(hi - lo + 1));
        int256[] memory bins = new int256[](len);
        uint256[] memory shares = new uint256[](len);
        for (uint256 k; k < len; k++) {
            bins[k] = lo + int16(int256(k));
            shares[k] = sharesPerBin;
        }
        LiquidityDelta memory d = LiquidityDelta({binIdxs: bins, shares: shares});
        (uint256 a0, uint256 a1) = lps[0].add(address(poolB), 7, d, address(token0), address(token1));
        (uint256 b0, uint256 b1) = lps[0].remove(address(poolB), 7, d);
        assertLe(b0, a0, "round-trip created token0");
        assertLe(b1, a1, "round-trip created token1");
        assertLe(a0 - b0, 16 * len, "round-trip dust token0 above bound");
        assertLe(a1 - b1, 16 * len, "round-trip dust token1 above bound");
        emit log_named_uint("round-trip dust token0", a0 - b0);
        emit log_named_uint("round-trip dust token1", a1 - b1);
    }
}
