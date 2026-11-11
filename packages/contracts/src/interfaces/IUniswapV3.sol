// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Uniswap v3 `SwapRouter02` (`swap-router-contracts` `IV3SwapRouter`): `exactInputSingle` without a
///      deadline field (SwapRouter02 takes the deadline through `multicall(deadline, ...)` only).
///      Base: 0x2626664c2603336E57B271c5C0b26F421741e481, Base Sepolia: 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev Uniswap v3 `UniswapV3Factory` (`getPool` is order-insensitive and returns `address(0)` for no pool).
///      Base: 0x33128a8fC17869897dcE68Ed026d694621f6FDfD (the factory Clanker v5's launch-buy adapter accepts).
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}
