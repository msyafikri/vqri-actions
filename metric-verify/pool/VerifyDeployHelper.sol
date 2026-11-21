// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {MetricOmmPoolDeployer} from "../../contracts/MetricOmmPoolDeployer.sol";
import {BinState} from "../../contracts/types/PoolStorage.sol";
import {PoolExtensions, ExtensionOrders} from "../../contracts/types/PoolExtensionsConfig.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @notice Small standalone deployer for verification pools. Exists so the pool
///         DeployParams construction compiles in its own small unit (the
///         via-IR stack budget of the main verification contract is tight).
///         The deployed pool's FACTORY immutable is the caller-supplied factory
///         (the test contract, which implements the factory stub interface);
///         this helper owns only the MetricOmmPoolDeployer instance.
contract VerifyDeployHelper {
    MetricOmmPoolDeployer internal deployer;
    uint256 internal nonce;

    function _scales(address t0, address t1) internal view returns (uint256 s0, uint256 s1) {
        uint8 d0 = IERC20Metadata(t0).decimals();
        uint8 d1 = IERC20Metadata(t1).decimals();
        uint8 internalDecimals = 18;
        if (d0 > internalDecimals) internalDecimals = d0;
        if (d1 > internalDecimals) internalDecimals = d1;
        s0 = 10 ** (internalDecimals - d0);
        s1 = 10 ** (internalDecimals - d1);
    }

    function deployPool(
        address factory,
        address token0,
        address token1,
        address priceProvider,
        int24 curBinDistFromProvidedPriceE6,
        uint24 spreadFeeE6,
        BinState[] memory nonNegativeBinStates,
        BinState[] memory negativeBinStates,
        PoolExtensions memory extensions,
        ExtensionOrders memory extensionOrders
    ) external returns (address pool) {
        if (address(deployer) == address(0)) {
            deployer = new MetricOmmPoolDeployer(address(this));
        }
        (uint256 s0, uint256 s1) = _scales(token0, token1);
        pool = deployer.deploy(
            MetricOmmPoolDeployer.DeployParams({
                salt: keccak256(abi.encodePacked("VerifyDeployHelper", nonce++)),
                factory: factory,
                token0: token0,
                token1: token1,
                priceProvider: priceProvider,
                extensions: extensions,
                extensionOrders: extensionOrders,
                immutablePriceProvider: true,
                token0ScaleMultiplier: s0,
                token1ScaleMultiplier: s1,
                initialScaledAmount0PerShareE18: 1e18,
                initialScaledAmount1PerShareE18: 1e18,
                minimalOperationalLiquidity: 1e6,
                spreadFeeE6: spreadFeeE6,
                curBinDistFromProvidedPriceE6: curBinDistFromProvidedPriceE6,
                nonNegativeBinStates: nonNegativeBinStates,
                negativeBinStates: negativeBinStates,
                notionalFeeE8: 0,
                bidAskRefAsymmetryX8: type(uint16).max
            })
        );
    }
}
