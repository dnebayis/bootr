// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev ABI-equivalent of Uniswap v4 `PoolKey` (Currency and IHooks are address-typed user types).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

library V4Constants {
    /// @dev LPFeeLibrary.DYNAMIC_FEE_FLAG
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    /// @dev TickMath.MIN_SQRT_PRICE / MAX_SQRT_PRICE
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    /// @dev Universal Router Commands.V4_SWAP
    uint8 internal constant CMD_V4_SWAP = 0x10;
    /// @dev v4-periphery Actions
    uint8 internal constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACTION_SETTLE_ALL = 0x0c;
    uint8 internal constant ACTION_TAKE_ALL = 0x0f;

    function poolId(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IV4Router {
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }
}

/// @dev Uniswap v4-core `PoolSwapTest` (test router deployed on testnets).
interface IPoolSwapTest {
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    struct TestSettings {
        bool takeClaims;
        bool settleUsingBurn;
    }

    function swap(PoolKey memory key, SwapParams memory params, TestSettings memory testSettings, bytes memory hookData)
        external
        payable
        returns (int256 delta);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}
