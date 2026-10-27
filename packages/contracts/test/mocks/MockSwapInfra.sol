// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IAggregatorV3} from "../../src/interfaces/IChainlink.sol";
import {ISwapRouter02} from "../../src/interfaces/IUniswapV3.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev Chainlink feed stand-in with settable answer / timestamps / rounds.
contract MockAggregator is IAggregatorV3 {
    uint8 public immutable decimals;
    uint80 public roundId = 10;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound = 10;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_, uint256 updatedAt_, uint80 roundId_, uint80 answeredInRound_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        roundId = roundId_;
        answeredInRound = answeredInRound_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @dev SwapRouter02 stand-in: pulls `amountIn` of tokenIn from the caller, mints `amountIn * rate / 1e20`
///      of tokenOut (18 dp -> 6 dp at `rate` with 8 dp) minus `skimBps` to `recipient`, honours
///      `amountOutMinimum`, and can be told to pay someone else (to prove the helper checks the output).
contract MockSwapRouter is ISwapRouter02 {
    uint256 public rate; // 8 dp USD per ETH
    uint256 public skimBps;
    address public divert;

    constructor(uint256 rate_) {
        rate = rate_;
    }

    function set(uint256 rate_, uint256 skimBps_, address divert_) external {
        rate = rate_;
        skimBps = skimBps_;
        divert = divert_;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = (p.amountIn * rate * (10_000 - skimBps)) / (10_000 * 1e20);
        require(amountOut >= p.amountOutMinimum, "Too little received");
        MockERC20(p.tokenOut).mint(divert == address(0) ? p.recipient : divert, amountOut);
    }
}
