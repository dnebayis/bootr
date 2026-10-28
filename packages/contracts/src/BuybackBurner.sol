// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IRwagmiLpLockerV3} from "./interfaces/IRwagmi.sol";
import {IPermit2, IUniversalRouter, IV4Router, PoolKey, V4Constants} from "./interfaces/IUniswapV4.sol";

/// @title BuybackBurner
/// @notice Minimal clone (one per coin) that owns one reward slot of the coin's RWAGMI v3 launch. The hook
///         charges swap fees in WETH only, so the burner's share arrives as WETH in the RWAGMI LP locker and
///         is claimable only by the burner itself (`claimableQuote[msg.sender]`).
///         `claim()` is permissionless: it settles the pool and pulls the burner's WETH here.
///         `swapAndBurn(minTokenOut)` swaps the whole WETH balance into the coin through the Uniswap v4 pool
///         via the Universal Router and sends the proceeds to 0x…dEaD. It is restricted to the launcher's
///         owner (the platform admin), who supplies `minTokenOut` from an off-chain quote: there is no
///         trustworthy on-chain price for a fresh coin (the pool spot price is exactly what a sandwicher
///         moves), so a permissionless `minOut` was a standing griefing primitive (BOOTR-03).
///         `burn()` sends whatever coin balance sits here (stray transfers) to 0x…dEaD, permissionless.
///         No owner of its own, no parameters after `initialize`.
contract BuybackBurner is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bool public initialized;
    IERC20 public token;
    IERC20 public weth;
    IRwagmiLpLockerV3 public locker;
    IUniversalRouter public universalRouter;
    IPermit2 public permit2;
    /// @notice The BootrLauncher that created this clone; `Ownable(launcher).owner()` may `swapAndBurn`.
    address public launcher;
    PoolKey private _poolKey;
    bytes32 public poolId;

    event Initialized(address indexed token, bytes32 poolId);
    event FeesClaimed(uint256 wethAmount);
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
        address locker_,
        PoolKey calldata poolKey_,
        address universalRouter_,
        address permit2_,
        address launcher_
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (
            token_ == address(0) || weth_ == address(0) || locker_ == address(0) || universalRouter_ == address(0)
                || permit2_ == address(0) || launcher_ == address(0)
        ) revert ZeroAddress();
        initialized = true;
        token = IERC20(token_);
        weth = IERC20(weth_);
        locker = IRwagmiLpLockerV3(locker_);
        universalRouter = IUniversalRouter(universalRouter_);
        permit2 = IPermit2(permit2_);
        launcher = launcher_;
        _poolKey = poolKey_;
        poolId = V4Constants.poolId(poolKey_);
        emit Initialized(token_, poolId);
    }

    function poolKey() external view returns (PoolKey memory) {
        return _poolKey;
    }

    /// @notice WETH fees not yet settled for this burner plus WETH already settled and claimable.
    function pendingFees() external view returns (uint256 pendingWeth, uint256 claimableWeth) {
        pendingWeth = locker.pendingQuote(poolId, address(this));
        claimableWeth = locker.claimableQuote(address(this), address(weth));
    }

    /// @notice Settle the pool and pull this burner's WETH share from the locker. Permissionless.
    function claim() external nonReentrant returns (uint256 claimed) {
        claimed = _claimFees();
    }

    /// @notice Send the whole coin balance held here to 0x…dEaD. Permissionless.
    function burn() external nonReentrant returns (uint256 burned) {
        burned = _burnAll();
    }

    /// @notice The address allowed to call `swapAndBurn`: the launcher's current owner.
    function keeper() public view returns (address) {
        return Ownable(launcher).owner();
    }

    /// @notice Claim, swap the whole WETH balance into the coin (>= `minTokenOut`) and burn everything.
    ///         Keeper only (see the contract NatSpec); `minTokenOut` must come from a fresh off-chain quote.
    function swapAndBurn(uint256 minTokenOut) external nonReentrant returns (uint256 bought, uint256 burned) {
        if (msg.sender != keeper()) revert NotKeeper(msg.sender);
        _claimFees();
        uint256 wethBalance = weth.balanceOf(address(this));
        if (wethBalance == 0) revert NothingToSwap();
        bought = _swapWethForToken(wethBalance, minTokenOut);
        burned = _burnAll();
    }

    function _claimFees() internal returns (uint256 claimed) {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = poolId;
        claimed = locker.settleAndClaim(ids, address(weth), address(this));
        if (claimed > 0) emit FeesClaimed(claimed);
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
