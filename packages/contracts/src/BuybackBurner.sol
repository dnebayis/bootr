// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IClankerFeeLocker} from "./interfaces/IClanker.sol";
import {IPermit2, IUniversalRouter, IV4Router, PoolKey, V4Constants} from "./interfaces/IUniswapV4.sol";

/// @title BuybackBurner
/// @notice Minimal clone (one per token) that is a Clanker LP-fee reward recipient. The launcher
///         registers it with `FeeIn.Clanker` in the ClankerLpLockerFeeConversion locker, so the
///         locker converts the burner's WETH share into the token on-chain before storing it in
///         the FeeLocker. `burn()` therefore only has to claim and send to 0x...dEaD.
///         `swapAndBurn(minTokenOut)` is a fallback for stray WETH (anything sent directly to this
///         contract): it swaps WETH -> token through the Uniswap v4 pool via the Universal Router
///         and burns the proceeds. It is restricted to the launcher's owner (the platform admin), who
///         supplies `minTokenOut` from an off-chain quote: there is no trustworthy on-chain price for
///         a fresh Clanker coin (Chainlink prices ETH, not the agent token, and the pool spot price is
///         exactly what a sandwicher moves), so a permissionless `minOut` was a standing griefing
///         primitive (BOOTR-03). `burn()` stays permissionless. No owner of its own, no parameters
///         after `initialize`.
contract BuybackBurner is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bool public initialized;
    IERC20 public token;
    IERC20 public weth;
    IClankerFeeLocker public feeLocker;
    IUniversalRouter public universalRouter;
    IPermit2 public permit2;
    /// @notice The BootrLauncher that created this clone; `Ownable(launcher).owner()` may `swapAndBurn`.
    address public launcher;
    PoolKey private _poolKey;

    event Initialized(address indexed token, bytes32 poolId);
    event FeesClaimed(uint256 tokenAmount, uint256 wethAmount);
    event Swapped(uint256 wethIn, uint256 tokenOut);
    event Burned(uint256 amount);

    error AlreadyInitialized();
    error ZeroAddress();
    error InsufficientOutput(uint256 out, uint256 minOut);
    error NothingToSwap();
    error NotKeeper(address caller);

    constructor() {
        // lock the implementation
        initialized = true;
    }

    function initialize(
        address token_,
        address weth_,
        address feeLocker_,
        PoolKey calldata poolKey_,
        address universalRouter_,
        address permit2_,
        address launcher_
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (
            token_ == address(0) || weth_ == address(0) || feeLocker_ == address(0) || universalRouter_ == address(0)
                || permit2_ == address(0) || launcher_ == address(0)
        ) revert ZeroAddress();
        initialized = true;
        token = IERC20(token_);
        weth = IERC20(weth_);
        feeLocker = IClankerFeeLocker(feeLocker_);
        universalRouter = IUniversalRouter(universalRouter_);
        permit2 = IPermit2(permit2_);
        launcher = launcher_;
        _poolKey = poolKey_;
        emit Initialized(token_, V4Constants.poolId(poolKey_));
    }

    function poolKey() external view returns (PoolKey memory) {
        return _poolKey;
    }

    function pendingFees() external view returns (uint256 tokenFees, uint256 wethFees) {
        tokenFees = feeLocker.availableFees(address(this), address(token));
        wethFees = feeLocker.availableFees(address(this), address(weth));
    }

    /// @notice Claim accrued fees from the FeeLocker and burn the whole token balance.
    function burn() external nonReentrant returns (uint256 burned) {
        _claimFees();
        burned = _burnAll();
    }

    /// @notice The address allowed to call `swapAndBurn`: the launcher's current owner.
    function keeper() public view returns (address) {
        return Ownable(launcher).owner();
    }

    /// @notice Claim, swap the whole WETH balance into the token (>= `minTokenOut`) and burn everything.
    ///         Keeper only (see the contract NatSpec); `minTokenOut` must come from a fresh off-chain quote.
    function swapAndBurn(uint256 minTokenOut) external nonReentrant returns (uint256 bought, uint256 burned) {
        if (msg.sender != keeper()) revert NotKeeper(msg.sender);
        _claimFees();
        uint256 wethBalance = weth.balanceOf(address(this));
        if (wethBalance == 0) revert NothingToSwap();
        bought = _swapWethForToken(wethBalance, minTokenOut);
        burned = _burnAll();
    }

    function _claimFees() internal {
        uint256 tokenFees = feeLocker.availableFees(address(this), address(token));
        if (tokenFees > 0) feeLocker.claim(address(this), address(token));
        uint256 wethFees = feeLocker.availableFees(address(this), address(weth));
        if (wethFees > 0) feeLocker.claim(address(this), address(weth));
        if (tokenFees > 0 || wethFees > 0) emit FeesClaimed(tokenFees, wethFees);
    }

    function _burnAll() internal returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount > 0) {
            token.safeTransfer(DEAD, amount);
            emit Burned(amount);
        }
    }

    function _swapWethForToken(uint256 amountIn, uint256 minTokenOut) internal returns (uint256 out) {
        PoolKey memory key = _poolKey;
        bool zeroForOne = key.currency0 == address(weth);

        bytes memory commands = abi.encodePacked(V4Constants.CMD_V4_SWAP);
        bytes memory actions = abi.encodePacked(
            V4Constants.ACTION_SWAP_EXACT_IN_SINGLE, V4Constants.ACTION_SETTLE_ALL, V4Constants.ACTION_TAKE_ALL
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minTokenOut),
                hookData: ""
            })
        );
        params[1] = abi.encode(address(weth), amountIn);
        params[2] = abi.encode(address(token), minTokenOut);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        weth.forceApprove(address(permit2), amountIn);
        permit2.approve(address(weth), address(universalRouter), uint160(amountIn), uint48(block.timestamp));

        uint256 before = token.balanceOf(address(this));
        universalRouter.execute(commands, inputs, block.timestamp);
        out = token.balanceOf(address(this)) - before;
        if (out < minTokenOut) revert InsufficientOutput(out, minTokenOut);
        emit Swapped(amountIn, out);
    }
}
