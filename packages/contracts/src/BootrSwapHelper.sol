// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAggregatorV3} from "./interfaces/IChainlink.sol";
import {ISwapRouter02} from "./interfaces/IUniswapV3.sol";

/// @title BootrSwapHelper
/// @notice Immutable WETH -> USDC swap helper for Bootr agent treasuries. It replaces the generic
///         `UniversalRouter.execute(bytes,bytes[],uint256)` + `WETH.transfer(router, *)` session rules
///         (finding C-02: a session key could route the kernel's whole WETH balance anywhere through
///         SWEEP / TRANSFER / recipient fields) with two rules whose only possible effect is "the
///         kernel's WETH becomes the kernel's USDC":
///
///           * `WETH.approve(helper, *)`
///           * `helper.swapWethToUsdc(uint256 amountIn, uint256 maxSlippageBps)`
///
///         `swapWethToUsdc` pulls `amountIn` WETH from `msg.sender` (`transferFrom`, so the helper never
///         holds funds between calls and nobody but the caller can spend the caller's allowance), swaps it
///         through Uniswap v3 `SwapRouter02` on the fixed `poolFee` WETH/USDC pool and pays ALL output
///         USDC to `msg.sender`. The minimum output is derived on-chain from Chainlink ETH/USD:
///         `floor = amountIn * ethUsd * (10000 - maxSlippageBps) / 10000`, `maxSlippageBps <=
///         MAX_SLIPPAGE_BPS` (3%), and the feed must be fresh (`updatedAt >= now - MAX_PRICE_AGE`, answer
///         > 0, `answeredInRound >= roundId`). A caller - including a compromised session key - therefore
///         cannot set `minOut = 0` and sandwich the swap for more than 3% once.
///
///         Why approve + transferFrom rather than transfer + sweep: with "transfer WETH to the helper, then
///         swap its balance" a session key could transfer WETH and stop; whoever then called the swap
///         would receive the USDC. With `transferFrom` the WETH only ever moves inside one call that pays
///         its own caller.
///
///         No owner, no fee, no parameters after deployment.
contract BootrSwapHelper is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice Hard cap on the slippage a caller may request (bps of the oracle price).
    uint256 public constant MAX_SLIPPAGE_BPS = 300;
    /// @notice Oldest acceptable Chainlink answer.
    uint256 public constant MAX_PRICE_AGE = 1 hours;
    uint256 internal constant BPS = 10_000;

    IERC20 public immutable weth;
    IERC20 public immutable usdc;
    ISwapRouter02 public immutable swapRouter;
    IAggregatorV3 public immutable ethUsdFeed;
    /// @notice Uniswap v3 fee tier of the WETH/USDC pool used (500 = 0.05%).
    uint24 public immutable poolFee;
    uint8 public immutable feedDecimals;

    event Swapped(address indexed account, uint256 wethIn, uint256 usdcOut, uint256 floor, uint256 ethUsd);

    error ZeroAddress();
    error ZeroAmount();
    error SlippageTooHigh(uint256 requested, uint256 max);
    error StalePrice(uint256 updatedAt, uint256 nowTs);
    error InvalidPrice(int256 answer);
    error InsufficientOutput(uint256 out, uint256 floor);

    constructor(address weth_, address usdc_, address swapRouter_, address ethUsdFeed_, uint24 poolFee_) {
        if (weth_ == address(0) || usdc_ == address(0) || swapRouter_ == address(0) || ethUsdFeed_ == address(0)) {
            revert ZeroAddress();
        }
        weth = IERC20(weth_);
        usdc = IERC20(usdc_);
        swapRouter = ISwapRouter02(swapRouter_);
        ethUsdFeed = IAggregatorV3(ethUsdFeed_);
        poolFee = poolFee_;
        feedDecimals = IAggregatorV3(ethUsdFeed_).decimals();
        // the router pulls exactly `amountIn` per swap from this contract, which never holds WETH otherwise
        IERC20(weth_).forceApprove(swapRouter_, type(uint256).max);
    }

    /// @notice Fresh Chainlink ETH/USD price scaled to 8 decimals; reverts when stale or invalid.
    function ethUsdPrice() public view returns (uint256 price) {
        (uint80 roundId, int256 answer, , uint256 updatedAt, uint80 answeredInRound) = ethUsdFeed.latestRoundData();
        if (answer <= 0) revert InvalidPrice(answer);
        if (updatedAt == 0 || updatedAt + MAX_PRICE_AGE < block.timestamp || answeredInRound < roundId) {
            revert StalePrice(updatedAt, block.timestamp);
        }
        price = uint256(answer);
        if (feedDecimals > 8) price /= 10 ** (feedDecimals - 8);
        else if (feedDecimals < 8) price *= 10 ** (8 - feedDecimals);
    }

    /// @notice Minimum USDC (6 dp) for `amountIn` WETH (18 dp) at the oracle price minus `maxSlippageBps`.
    function minUsdcOut(uint256 amountIn, uint256 maxSlippageBps) public view returns (uint256) {
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(maxSlippageBps, MAX_SLIPPAGE_BPS);
        // amountIn (1e18) * price (1e8) -> USDC (1e6): divide by 1e20
        return (amountIn * ethUsdPrice() * (BPS - maxSlippageBps)) / (BPS * 1e20);
    }

    /// @notice Swaps `amountIn` of the caller's WETH into USDC paid to the caller, at no worse than the
    ///         Chainlink price minus `maxSlippageBps` (capped at `MAX_SLIPPAGE_BPS`).
    /// @dev The caller must have approved this contract for `amountIn` WETH.
    function swapWethToUsdc(uint256 amountIn, uint256 maxSlippageBps) external nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        uint256 floor = minUsdcOut(amountIn, maxSlippageBps);
        weth.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 before = usdc.balanceOf(msg.sender);
        swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(usdc),
                fee: poolFee,
                recipient: msg.sender,
                amountIn: amountIn,
                amountOutMinimum: floor,
                sqrtPriceLimitX96: 0
            })
        );
        amountOut = usdc.balanceOf(msg.sender) - before;
        if (amountOut < floor) revert InsufficientOutput(amountOut, floor);
        emit Swapped(msg.sender, amountIn, amountOut, floor, ethUsdPrice());
    }
}
