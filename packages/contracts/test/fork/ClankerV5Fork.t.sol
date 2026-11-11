// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrClankerLauncherV5} from "../../src/BootrClankerLauncherV5.sol";
import {BootrLaunchGate} from "../../src/BootrLaunchGate.sol";
import {ClankerMetadataJson} from "./ClankerMetadataJson.sol";
import {
    ClankerV5,
    IClankerV5Dividend,
    IClankerV5Factory,
    IClankerV5FeeEscrow,
    IClankerV5Hook,
    IClankerV5Token
} from "../../src/interfaces/IClankerV5.sol";
import {IERC8004IdentityRegistry} from "../../src/interfaces/IERC8004IdentityRegistry.sol";
import {IKernel, KernelLib} from "../../src/interfaces/IKernel.sol";
import {IPermit2, IUniversalRouter, IV4Router, PoolKey, V4Constants} from "../../src/interfaces/IUniswapV4.sol";

interface IUniswapV3FactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @notice Fork tests of the Clanker v5 path against Base MAINNET: `BootrClankerLauncherV5` with creator-set token
///         settings through the live v5 factory (`TaxRWAERC20LaunchpadFactory`, the `TaxLaunchHook`, the
///         `FeeEscrow`, the launch-buy adapter, the per-coin `TaxDividend`), registering through the
///         `BootrLaunchGate`. Stock `forge` is enough (no B20 precompiles).
///         RPC: `BASE_RPC_URL` env or https://mainnet.base.org (no archive state needed).
///         Design: docs/design/clanker-v5-token-settings.md (and clanker-v5-migration.md).
contract ClankerV5ForkTest is Test {
    // --- Clanker v5 on Base mainnet (design note section 1, packages/shared/src/addresses.ts `clankerV5`) ---
    address constant FACTORY = 0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0;
    address constant HOOK = 0x5E320eA6278107968C119942E57d876c5F922AcC;
    address constant ESCROW = 0x5dd237d1f716C65426CCd2FAe82B95109825FA61;
    address constant TOKEN_DEPLOYER = 0xc25FfE6374EdcCb5bFCcA3b9684046a426AbCE6A;
    address constant BUY_ADAPTER = 0x5C65823dC5eaf0C37205F73213fC2f73D359DA4d;
    address constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    // --- shared infra ---
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant WETH_USDC_500 = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant KERNEL_FACTORY = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant NATIVE = address(0);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint24 constant TAX = 15_000; // 1.5%, the recommended rate (design note section 2.3)
    uint256 constant MIN_HOLDING = 10_000e18; // Clanker's policy minimum for dividends
    uint256 constant MAX_CODE_SIZE = 24_576;
    uint256 constant ANTI_SNIPE_WINDOW = 20;
    BootrClankerLauncherV5.LaunchKind constant AGENT = BootrClankerLauncherV5.LaunchKind.Agent;

    AgentGuardian guardian;
    BootrLaunchGate gate;
    BootrClankerLauncherV5 launcher;
    IClankerV5Factory factory = IClankerV5Factory(FACTORY);
    IClankerV5Hook hook = IClankerV5Hook(HOOK);
    IClankerV5FeeEscrow escrow = IClankerV5FeeEscrow(ESCROW);

    // Labels are namespaced: generic labels resolve to contracts on mainnet that forward ETH.
    address platformRecipient = makeAddr("bootr.fork.clankerv5.platformRecipient");
    address treasury = makeAddr("bootr.fork.clankerv5.treasury");
    address trader = makeAddr("bootr.fork.clankerv5.trader");
    address stranger = makeAddr("bootr.fork.clankerv5.stranger");
    address creator;
    uint256 creatorPk = uint256(keccak256("bootr.fork.clankerv5.creator.pk"));
    address sessionKey = vm.addr(0xA11CE);

    uint256 constant FUEL = 100e6;
    uint32 constant DORMANCY = 90 days;
    string constant CONTRACT_URI = "https://bootr.fun/tokens/fork-launch.json";

    /// @dev What one swap credited, decoded from the hook's logs of one pool.
    struct Credits {
        uint256 quoteFee; // Trade.quoteFeeAmount: the whole quote-side tax
        uint256 protocol; // ProtocolFeeCredited
        uint256 antiSnipe; // AntiSnipeFeeCredited
        uint256 burn; // BurnTaxCredited (in the coin)
        uint256 dividend; // DividendTaxCredited (to the tracker)
        uint256 dividendRedirected; // DividendTaxRedirected (to Clanker: nobody qualified yet)
        uint256[] slots; // CreatorTaxCredited, in slot order
        uint256 slotsTotal;
    }

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        require(block.chainid == 8453, "not a Base mainnet fork");
        creator = vm.addr(creatorPk);

        guardian = new AgentGuardian(address(this), ENTRY_POINT, USDC, WETH);
        gate = new BootrLaunchGate(address(this), address(guardian));
        launcher = new BootrClankerLauncherV5(
            address(this),
            BootrClankerLauncherV5.Deps({
                factory: FACTORY,
                hook: HOOK,
                feeEscrow: ESCROW,
                weth: WETH,
                uniswapV3Factory: UNISWAP_V3_FACTORY,
                usdc: USDC,
                identityRegistry: IDENTITY,
                kernelFactory: KERNEL_FACTORY,
                guardian: address(guardian),
                gate: address(gate)
            }),
            _defaults(),
            1000
        );
        // what DeployClankerLauncherV5 does
        launcher.setQuoteAllowed(AGENT, NATIVE, true);
        launcher.setQuoteAllowed(AGENT, USDC, true);
        launcher.setDevBuyRoute(USDC, WETH_USDC_500, 500);
        guardian.setLauncher(address(gate));
        gate.addLauncher(address(launcher));
        guardian.setPlatformTreasury(treasury);

        deal(USDC, creator, 10_000e6);
        vm.deal(creator, 100 ether);
        vm.prank(creator);
        IERC20(USDC).approve(address(launcher), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Fixture
    // ------------------------------------------------------------------

    /// @dev The deploy defaults: agent 5%, platform 30%, tax 1%..5% per side, five creator rows.
    function _defaults() internal view returns (BootrClankerLauncherV5.AgentDefaults memory) {
        return BootrClankerLauncherV5.AgentDefaults({
            agentShareBps: 500,
            platformShareBps: 3000,
            platformRecipient: platformRecipient,
            minFuelUsdc: 25e6,
            dormancyPeriod: DORMANCY,
            minTaxBps: 10_000,
            maxTaxBps: 50_000,
            maxRewardRows: 5
        });
    }

    function _params(uint256 devBuyWei) internal view returns (BootrClankerLauncherV5.LaunchParams memory p) {
        p = BootrClankerLauncherV5.LaunchParams({
            name: "Bootr Clanker V5 Agent",
            symbol: "BCV5",
            image: "https://bootr.fun/images/test.png",
            metadata: '{"description":"mainnet fork launch through Clanker v5","socialMediaUrls":[],"auditUrls":[]}',
            context: '{"interface":"Bootr","platform":"bootr.fun","id":"draft-5"}',
            salt: bytes32(0),
            buybackBurn: false,
            fuelUsdc: FUEL,
            devBuyWei: devBuyWei,
            workerHash: keccak256("worker"),
            model: "claude-sonnet-4-5",
            agentURI: "https://bootr.fun/agents/test.json",
            supervisorSessionKey: sessionKey
        });
    }

    /// @dev The recommended settings (design note section 2.3) on `quote`: 1.5% both ways, all to creator funds,
    ///      one row (the creator, admin the creator), sniper tax on, editable metadata. The dev-buy minimum is the
    ///      smallest the launcher admits (1 unit); the tests of the minimum set a real one.
    function _settings(address quote) internal view returns (BootrClankerLauncherV5.TokenSettings memory s) {
        s.quoteToken = quote;
        s.minDevBuyOut = 1;
        s.expectedConfigVersion = factory.configVersion();
        s.buyTaxBps = TAX;
        s.sellTaxBps = TAX;
        s.rewards = new BootrClankerLauncherV5.RewardInput[](1);
        s.rewards[0] = BootrClankerLauncherV5.RewardInput({recipient: creator, admin: creator, bps: 10_000});
        s.antiSnipe = true;
        s.metadataEditable = true;
        s.contractURI = CONTRACT_URI;
    }

    /// @dev The creator's row plus four extra rows, each with its own admin (40 / 15 / 15 / 15 / 15).
    function _fiveRows() internal returns (BootrClankerLauncherV5.RewardInput[] memory rows) {
        rows = new BootrClankerLauncherV5.RewardInput[](5);
        rows[0] = BootrClankerLauncherV5.RewardInput({recipient: creator, admin: creator, bps: 4000});
        for (uint256 i = 1; i < 5; ++i) {
            rows[i] = BootrClankerLauncherV5.RewardInput({
                recipient: makeAddr(string.concat("bootr.fork.clankerv5.row", vm.toString(i))),
                admin: makeAddr(string.concat("bootr.fork.clankerv5.rowAdmin", vm.toString(i))),
                bps: 1500
            });
        }
    }

    /// @dev What the web does before signing: one `tokenInitCodeHash` read, then local keccaks until the
    ///      predicted token address ends in 0xcccc (about 65k tries on average). In assembly over a fixed scratch
    ///      region so that the search allocates no memory (a Solidity loop runs out of memory gas).
    function _mineSalt(
        address who,
        BootrClankerLauncherV5.LaunchParams memory p,
        BootrClankerLauncherV5.TokenSettings memory s,
        bytes32 seed
    ) internal view returns (bytes32 salt) {
        bytes32 initCodeHash = launcher.tokenInitCodeHash(p, s);
        address self = address(launcher);
        address deployer = TOKEN_DEPLOYER;
        bool found;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            // [ptr, +0x40): abi.encode(who, salt); [ptr+0x40, +0x40): abi.encode(self, inner);
            // [ptr+0x80, +0x55): 0xff ‖ deployer ‖ scoped ‖ initCodeHash (the CREATE2 preimage)
            mstore(ptr, who)
            mstore(add(ptr, 0x40), self)
            mstore8(add(ptr, 0x80), 0xff)
            mstore(add(ptr, 0x81), shl(96, deployer))
            mstore(add(ptr, 0xb5), initCodeHash)
            for { let i := 0 } lt(i, 4000000) { i := add(i, 1) } {
                mstore(0x00, seed)
                mstore(0x20, i)
                salt := keccak256(0x00, 0x40)
                mstore(add(ptr, 0x20), salt)
                mstore(add(ptr, 0x60), keccak256(ptr, 0x40))
                mstore(add(ptr, 0x95), keccak256(add(ptr, 0x40), 0x40))
                if eq(and(keccak256(add(ptr, 0x80), 0x55), 0xffff), 0xcccc) {
                    found := 1
                    break
                }
            }
        }
        require(found, "no cccc salt found");
    }

    function _launchWith(
        address who,
        BootrClankerLauncherV5.LaunchParams memory p,
        BootrClankerLauncherV5.TokenSettings memory s,
        bytes32 seed
    ) internal returns (address token, address kernel, address burner, uint256 agentId) {
        p.salt = _mineSalt(who, p, s, seed);
        vm.prank(who);
        (token, kernel, burner, agentId) = launcher.launch{value: p.devBuyWei}(p, s);
        _assertLaunchInvariants(token, kernel, agentId, p, s);
    }

    function _launch(BootrClankerLauncherV5.TokenSettings memory s, uint256 devBuyWei)
        internal
        returns (address token, address kernel)
    {
        (token, kernel,,) = _launchWith(creator, _params(devBuyWei), s, bytes32(uint256(7)));
    }

    /// @dev Past the anti-snipe window (20 s): buys pay the plain tax and exact-output swaps are allowed again.
    function _passAntiSnipe() internal {
        vm.warp(vm.getBlockTimestamp() + ANTI_SNIPE_WINDOW + 1);
        vm.roll(block.number + 100);
    }

    function _poolId(address token) internal view returns (bytes32) {
        return V4Constants.poolId(launcher.poolKeyFor(token));
    }

    function _owed(address who, address asset) internal view returns (uint256) {
        return escrow.owed(who, asset);
    }

    /// @dev One exact-input swap through the Universal Router, `tokenIn` -> `tokenOut` on the coin's pool (what
    ///      traders do; native ETH settles from msg.value, ERC-20s through Permit2).
    function _swap(address token, address tokenIn, address tokenOut, uint256 amountIn) internal {
        PoolKey memory key = launcher.poolKeyFor(token);
        uint256 value;
        vm.startPrank(trader);
        if (tokenIn == NATIVE) {
            vm.deal(trader, trader.balance + amountIn);
            value = amountIn;
        } else {
            IERC20(tokenIn).approve(PERMIT2, amountIn);
            IPermit2(PERMIT2).approve(tokenIn, UNIVERSAL_ROUTER, uint160(amountIn), uint48(block.timestamp + 1 hours));
        }
        bytes memory actions = abi.encodePacked(
            V4Constants.ACTION_SWAP_EXACT_IN_SINGLE, V4Constants.ACTION_SETTLE_ALL, V4Constants.ACTION_TAKE_ALL
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: tokenIn == key.currency0,
                amountIn: uint128(amountIn),
                amountOutMinimum: 1,
                hookData: ""
            })
        );
        params[1] = abi.encode(tokenIn, amountIn);
        params[2] = abi.encode(tokenOut, uint256(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: value}(
            abi.encodePacked(V4Constants.CMD_V4_SWAP), inputs, block.timestamp
        );
        vm.stopPrank();
    }

    /// @dev Buy the coin with `amountIn` of its quote (dealt to the trader).
    function _buy(address token, uint256 amountIn) internal {
        address quote = launcher.quoteOf(token);
        if (quote != NATIVE) deal(quote, trader, IERC20(quote).balanceOf(trader) + amountIn);
        _swap(token, quote, token, amountIn);
    }

    /// @dev Sell `amountIn` of the coin for its quote.
    function _sell(address token, uint256 amountIn) internal {
        _swap(token, token, launcher.quoteOf(token), amountIn);
    }

    /// @dev The hook's credits of one swap, from the recorded logs of the pool `poolId`.
    function _credits(Vm.Log[] memory logs, bytes32 poolId) internal view returns (Credits memory c) {
        c.slots = new uint256[](hook.poolFeeSlots(poolId).length);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != HOOK || l.topics.length < 2 || l.topics[1] != poolId) continue;
            bytes32 sig = l.topics[0];
            if (sig == IClankerV5Hook.Trade.selector) {
                (, uint256 amount,) = abi.decode(l.data, (address, uint256, bytes32));
                c.quoteFee += amount;
            } else if (sig == IClankerV5Hook.ProtocolFeeCredited.selector) {
                (, uint256 amount) = abi.decode(l.data, (address, uint256));
                c.protocol += amount;
            } else if (sig == IClankerV5Hook.AntiSnipeFeeCredited.selector) {
                (, uint256 amount) = abi.decode(l.data, (address, uint256));
                c.antiSnipe += amount;
            } else if (sig == IClankerV5Hook.BurnTaxCredited.selector) {
                c.burn += abi.decode(l.data, (uint256));
            } else if (sig == IClankerV5Hook.DividendTaxCredited.selector) {
                (, uint256 amount) = abi.decode(l.data, (address, uint256));
                c.dividend += amount;
            } else if (sig == IClankerV5Hook.DividendTaxRedirected.selector) {
                c.dividendRedirected += abi.decode(l.data, (uint256));
            } else if (sig == IClankerV5Hook.CreatorTaxCredited.selector) {
                (, uint256 amount) = abi.decode(l.data, (address, uint256));
                c.slots[n++] = amount;
                c.slotsTotal += amount;
            }
        }
        assertEq(n, c.slots.length, "one credit per slot");
    }

    /// @dev Each slot's exact share of one swap, as Clanker computes it from the settings: the quote-side tax
    ///      after Clanker's cut (and any sniper surcharge) is split between the slots and the dividends by their
    ///      shares, the slots by their weights (floored), the last slot taking the wei remainder. The agent's
    ///      credit is at least its 5% of the post-Clanker pool, the platform's at most its 30%.
    function _assertSplit(Credits memory c, BootrClankerLauncherV5.TokenSettings memory s, string memory side)
        internal
        view
    {
        uint16[] memory w = launcher.previewSlotWeights(s);
        uint256 remaining = c.quoteFee - c.protocol - c.antiSnipe;
        uint256 creatorShare = 10_000 - uint256(s.burnBps) - s.dividendBps;
        uint256 expected = remaining * creatorShare / (creatorShare + s.dividendBps);
        assertEq(c.slotsTotal, expected, string.concat(side, ": the slots' part of the quote tax"));
        assertEq(c.dividend + c.dividendRedirected, remaining - expected, string.concat(side, ": the dividends' part"));
        uint256 given;
        for (uint256 i; i + 1 < w.length; ++i) {
            assertEq(c.slots[i], expected * w[i] / 10_000, string.concat(side, ": slot ", vm.toString(i)));
            given += c.slots[i];
        }
        assertEq(c.slots[w.length - 1], expected - given, string.concat(side, ": the last slot takes the remainder"));
        // the post-Clanker pool's quote part is (10_000 - burn) / 10_000 of it
        uint256 quotePool = c.slotsTotal + c.dividend + c.dividendRedirected;
        // the agent gets at least its 5% rounded down to the wei (Clanker floors each slot's share)
        assertGe(c.slots[0], quotePool * 500 / (10_000 - s.burnBps), string.concat(side, ": agent >= its 5% floor"));
        assertLe(c.slots[1] * (10_000 - s.burnBps), quotePool * 3000, string.concat(side, ": platform <= its 30%"));
    }

    /// @dev The escrow balance in `asset` of every slot recipient of the pool (recipients are distinct here).
    function _owedPerSlot(bytes32 poolId, address asset) internal view returns (uint256[] memory owed) {
        ClankerV5.FeeSlot[] memory slots = hook.poolFeeSlots(poolId);
        owed = new uint256[](slots.length);
        for (uint256 i; i < slots.length; ++i) {
            owed[i] = _owed(slots[i].recipient, asset);
        }
    }

    /// @dev `hook.poolConfig(poolId)` as the struct (the getter's tuple is static, so it decodes as one).
    function _poolConfig(bytes32 poolId) internal view returns (IClankerV5Hook.PoolConfig memory cfg) {
        (bool ok, bytes memory ret) = HOOK.staticcall(abi.encodeWithSelector(IClankerV5Hook.poolConfig.selector, poolId));
        require(ok, "poolConfig read failed");
        cfg = abi.decode(ret, (IClankerV5Hook.PoolConfig));
    }

    // ------------------------------------------------------------------
    // The live policy (what the day-of checks read; Clanker can change it for future launches)
    // ------------------------------------------------------------------

    function test_livePolicyMatchesAssumptions() public view {
        assertTrue(factory.launchCreationEnabled(), "v5 launches closed");
        assertEq(factory.hook(), HOOK);
        assertEq(hook.feeEscrow(), ESCROW);
        assertEq(hook.factory(), FACTORY);
        assertEq(escrow.hook(), HOOK);
        assertEq(factory.tokenDeployer(), TOKEN_DEPLOYER);
        assertEq(factory.launchBuyAdapter(), BUY_ADAPTER, "no launch-buy adapter: dev buys revert");
        assertEq(factory.poolManager(), POOL_MANAGER);
        assertEq(factory.launchSupply(), TOTAL_SUPPLY, "v5 mints 1 B tokens");
        assertEq(factory.tickSpacing(), 200);
        assertEq(factory.nativeLaunchFee(), 0, "Clanker charges a native launch fee now; the launcher passes it through");
        (bool registered, uint8 decimals,) = factory.quoteConfig(NATIVE);
        assertTrue(registered, "native ETH not a registered quote");
        assertEq(decimals, 18);
        (registered, decimals,) = factory.quoteConfig(USDC);
        assertTrue(registered, "USDC not a registered quote");
        assertEq(decimals, 6);
        (registered,,) = factory.quoteConfig(CBBTC);
        assertTrue(registered, "cbBTC is a Clanker quote (and not on Bootr's agent list)");
        (bool wethRegistered,,) = factory.quoteConfig(WETH);
        assertFalse(wethRegistered, "WETH is not a v5 quote: ETH pools are native");
        assertEq(IUniswapV3FactoryLike(UNISWAP_V3_FACTORY).getPool(WETH, USDC, 500), WETH_USDC_500, "USDC dev-buy hop");

        ClankerV5.TaxPolicy memory policy = factory.taxPolicy();
        (,,,,, uint24 lo, uint24 hi,) = launcher.agentDefaults();
        assertLe(policy.taxFeeBounds.minimumBuyTaxRate, uint32(lo) * 100, "launcher floor under Clanker's");
        assertGe(policy.taxFeeBounds.maximumBuyTaxRate, uint32(hi) * 100, "launcher ceiling over Clanker's");
        assertLe(policy.taxFeeBounds.minimumSellTaxRate, uint32(lo) * 100);
        assertGe(policy.taxFeeBounds.maximumSellTaxRate, uint32(hi) * 100);
        assertEq(policy.protocolFeeConfiguration.protocolTaxShare, 10_000_000, "Clanker takes 10% of the tax");
        assertEq(policy.protocolFeeConfiguration.minimumProtocolFeeRate, 500_000, "at least 0.5% of the trade");
        assertEq(policy.protocolFeeConfiguration.maximumProtocolFeeRate, 1_000_000, "at most 1% of the trade");
        assertEq(policy.antiSnipeConfiguration.windowSeconds, ANTI_SNIPE_WINDOW);
        assertEq(policy.antiSnipeConfiguration.startTotalFeeRate, 99_000_000);
        assertEq(policy.minimumDividendHoldingRequirement, MIN_HOLDING, "dividend minimum: 10,000 coins");

        // the preview the factory computes for the recommended settings: 1.5% in, 0.5% to Clanker, 1% to the slots
        (, ClankerV5.Rates memory buy, ClankerV5.Rates memory sell, bool dividends,) =
            factory.previewTaxConfiguration(launcher.taxConfigurationFor(_settings(NATIVE)));
        assertFalse(dividends);
        assertEq(buy.protocolRate, 500_000 * 1e16, "0.5% of the trade on the 1e24 scale");
        assertEq(buy.creatorRate, 1_000_000 * 1e16, "1% of the trade to the slots");
        assertEq(sell.creatorRate, buy.creatorRate);
        // 1% buy, 5% sell, burn 10%, dividends 10%: Clanker takes 0.5% of both sides
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        s.buyTaxBps = 10_000;
        s.sellTaxBps = 50_000;
        s.burnBps = 1000;
        s.dividendBps = 1000;
        s.minDividendHolding = MIN_HOLDING;
        (, buy, sell, dividends,) = factory.previewTaxConfiguration(launcher.taxConfigurationFor(s));
        assertTrue(dividends);
        assertEq(buy.protocolRate, 500_000 * 1e16, "1% buy: Clanker's 0.5% floor");
        assertEq(sell.protocolRate, 500_000 * 1e16, "5% sell: 10% of the tax = 0.5%");
        assertEq(buy.burnRate, 50_000 * 1e16, "10% of the 0.5% left");
        assertEq(sell.dividendRate, 450_000 * 1e16, "10% of the 4.5% left");
    }

    // ------------------------------------------------------------------
    // Launches: ETH and USDC, with a dev buy
    // ------------------------------------------------------------------

    function test_launchEthWithDevBuy() public {
        uint256 before = creator.balance;
        vm.recordLogs();
        (address token,) = _launch(_settings(NATIVE), 0.01 ether);
        assertGt(IERC20(token).balanceOf(creator), 0, "dev buy delivered to the creator");
        assertEq(before - creator.balance, 0.01 ether, "exactly the dev buy was spent");
        _assertDevBuyForwarded(vm.getRecordedLogs(), token, 0.01 ether);
    }

    function test_launchUsdcWithDevBuy() public {
        uint256 before = creator.balance;
        vm.recordLogs();
        (address token,) = _launch(_settings(USDC), 0.01 ether);
        assertEq(launcher.quoteOf(token), USDC);
        assertGt(IERC20(token).balanceOf(creator), 0, "dev buy delivered to the creator through WETH -> USDC -> coin");
        assertEq(before - creator.balance, 0.01 ether, "funded in ETH");
        assertEq(IERC20(USDC).balanceOf(address(launcher)), 0, "no USDC left behind");
        _assertDevBuyForwarded(vm.getRecordedLogs(), token, 0.01 ether);
    }

    /// @dev The dev buy's minimum output is the creator's: none at all is refused before anything is created, one
    ///      unit above what the route delivers reverts the whole launch (nothing spent), and the exact output
    ///      goes through. Both the one-hop (ETH) and the two-hop (USDC) route.
    function test_devBuyMinimumOutputIsEnforced() public {
        address[2] memory quotes = [NATIVE, USDC];
        for (uint256 i; i < quotes.length; ++i) {
            BootrClankerLauncherV5.LaunchParams memory p = _params(0.01 ether);
            BootrClankerLauncherV5.TokenSettings memory s = _settings(quotes[i]);
            p.salt = _mineSalt(creator, p, s, bytes32(uint256(40 + i)));

            s.minDevBuyOut = 0;
            vm.prank(creator);
            vm.expectRevert(BootrClankerLauncherV5.MinDevBuyOutRequired.selector);
            launcher.launch{value: 0.01 ether}(p, s);

            // what the route delivers right now
            s.minDevBuyOut = 1;
            uint256 snap = vm.snapshotState();
            vm.prank(creator);
            (address token,,,) = launcher.launch{value: 0.01 ether}(p, s);
            uint256 delivered = IERC20(token).balanceOf(creator);
            assertGt(delivered, 0);
            vm.revertToState(snap);

            uint256 before = creator.balance;
            s.minDevBuyOut = delivered + 1;
            vm.prank(creator);
            vm.expectRevert();
            launcher.launch{value: 0.01 ether}(p, s);
            assertEq(creator.balance, before, "a launch under the minimum spends nothing");
            assertEq(token.code.length, 0, "and creates no coin");

            s.minDevBuyOut = delivered;
            vm.prank(creator);
            (address again,,,) = launcher.launch{value: 0.01 ether}(p, s);
            assertEq(again, token);
            assertEq(IERC20(token).balanceOf(creator), delivered, "exactly the minimum is enough");
        }
    }

    /// @dev The owner's route can only be Uniswap v3's own WETH / quote pool at a fee of 0.3% or less.
    function test_devBuyRouteIsBoundToTheUniswapV3Factory() public {
        assertEq(address(launcher.uniswapV3Factory()), UNISWAP_V3_FACTORY);
        // the launch pool manager is a contract, and not a v3 pool of the pair
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteNotFactoryPool.selector);
        launcher.setDevBuyRoute(USDC, POOL_MANAGER, 500);
        // the real 0.05% pool under the wrong tier
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteNotFactoryPool.selector);
        launcher.setDevBuyRoute(USDC, WETH_USDC_500, 3000);
        // the 1% tier is out of the bound even with its real pool
        address onePercent = IUniswapV3FactoryLike(UNISWAP_V3_FACTORY).getPool(WETH, USDC, 10_000);
        assertTrue(onePercent != address(0), "Uniswap v3 has a WETH/USDC 1% pool on Base");
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteFeeOutOfBounds.selector);
        launcher.setDevBuyRoute(USDC, onePercent, 10_000);
        // the 0.3% pool is admitted, and a dev buy runs through it
        address thirty = IUniswapV3FactoryLike(UNISWAP_V3_FACTORY).getPool(WETH, USDC, 3000);
        launcher.setDevBuyRoute(USDC, thirty, 3000);
        (address token,) = _launch(_settings(USDC), 0.01 ether);
        assertGt(IERC20(token).balanceOf(creator), 0);
    }

    /// @dev Clanker's stale-config guard is the creator's: a launch pinned to any version but the live one reverts
    ///      `StaleConfig(expected, actual)`, with and without a dev buy, and the views still answer.
    function test_staleConfigVersionReverts() public {
        uint64 live = factory.configVersion();
        for (uint256 devBuy = 0; devBuy <= 0.01 ether; devBuy += 0.01 ether) {
            BootrClankerLauncherV5.LaunchParams memory p = _params(devBuy);
            BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
            p.salt = _mineSalt(creator, p, s, bytes32(uint256(50)));
            uint64[3] memory stale = [uint64(0), live - 1, live + 1];
            for (uint256 i; i < stale.length; ++i) {
                s.expectedConfigVersion = stale[i];
                vm.prank(creator);
                vm.expectRevert(abi.encodeWithSelector(IClankerV5Factory.StaleConfig.selector, stale[i], live));
                launcher.launch{value: devBuy}(p, s);
                // the pin is not part of the token's init code: the mined salt stays valid
                assertEq(uint160(launcher.predictToken(creator, p, s)) & 0xffff, 0xcccc);
            }
            assertEq(launcher.predictKernel(creator, p.salt).code.length, 0, "nothing was created");
        }
    }

    function test_launchUsdcWithoutDevBuy() public {
        (address token,) = _launch(_settings(USDC), 0);
        assertEq(IERC20(token).balanceOf(creator), 0);
    }

    function _assertDevBuyForwarded(Vm.Log[] memory logs, address token, uint256 amountIn) internal view {
        bool saw;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == FACTORY && logs[i].topics[0] == IClankerV5Factory.LaunchBuyExecuted.selector) {
                saw = true;
                assertEq(address(uint160(uint256(logs[i].topics[3]))), address(launcher), "originalCreator is the launcher");
                (address fundingToken, uint256 inAmount, uint256 amountOut,) =
                    abi.decode(logs[i].data, (address, uint256, uint256, address));
                assertEq(fundingToken, NATIVE);
                assertEq(inAmount, amountIn);
                assertEq(IERC20(token).balanceOf(creator), amountOut, "the whole buy forwarded to the creator");
            }
        }
        assertTrue(saw, "LaunchBuyExecuted");
    }

    function test_launchEventsCarryTheSettings() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(USDC);
        s.buyTaxBps = 12_000;
        s.sellTaxBps = 30_000;
        s.burnBps = 1000;
        s.dividendBps = 500;
        s.minDividendHolding = MIN_HOLDING;
        s.antiSnipe = false;
        s.rewards = _fiveRows();
        vm.recordLogs();
        (address token, address kernel) = _launch(s, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 poolId = _poolId(token);
        uint16[] memory w = launcher.previewSlotWeights(s);
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter == address(launcher) && l.topics[0] == BootrClankerLauncherV5.AgentLaunched.selector) {
                seen |= 1;
                assertEq(address(uint160(uint256(l.topics[1]))), token);
                assertEq(address(uint160(uint256(l.topics[2]))), kernel);
                assertEq(address(uint160(uint256(l.topics[3]))), creator);
                (address burner,, BootrClankerLauncherV5.LaunchDefaults memory d,,,,) = abi.decode(
                    l.data, (address, uint256, BootrClankerLauncherV5.LaunchDefaults, bytes32, string, string, address)
                );
                assertEq(burner, DEAD, "a burn share names the dead address");
                assertEq(d.lpFeeBps, 12_000, "lpFeeBps carries the buy tax");
                assertEq(d.agentBps, 500);
                assertEq(d.platformBps, 3000);
                assertEq(d.burnBps, 1000);
                assertEq(d.creatorBps, 5500, "creator funds 45% + dividends 5%");
                assertEq(d.platformRecipient, platformRecipient);
            } else if (l.emitter == address(launcher) && l.topics[0] == BootrClankerLauncherV5.ClankerV5Launched.selector)
            {
                seen |= 2;
                assertEq(address(uint160(uint256(l.topics[1]))), token);
                _assertV5LaunchedData(l.data, poolId);
            } else if (l.emitter == address(launcher) && l.topics[0] == BootrClankerLauncherV5.LaunchContext.selector) {
                seen |= 4;
                assertEq(abi.decode(l.data, (string)), '{"interface":"Bootr","platform":"bootr.fun","id":"draft-5"}');
            } else if (l.emitter == HOOK && l.topics[0] == IClankerV5Hook.FeeSlotCreated.selector && l.topics[1] == poolId)
            {
                seen |= 8;
                _assertFeeSlotCreated(l, w, kernel, s);
            } else if (l.emitter == FACTORY && l.topics[0] == IClankerV5Factory.LaunchTaxConfigured.selector) {
                seen |= 16;
                assertEq(l.topics[1], poolId);
                _assertLaunchTaxConfigured(l.data);
            }
        }
        assertEq(seen, 31, "AgentLaunched, ClankerV5Launched, LaunchContext, FeeSlotCreated, LaunchTaxConfigured");
    }

    function _assertFeeSlotCreated(
        Vm.Log memory l,
        uint16[] memory w,
        address kernel,
        BootrClankerLauncherV5.TokenSettings memory s
    ) internal view {
        uint256 index = uint256(l.topics[2]);
        (address recipient, address admin, uint16 weight, bool isCreator) =
            abi.decode(l.data, (address, address, uint16, bool));
        assertEq(weight, w[index]);
        assertFalse(isCreator);
        if (index == 0) assertEq(recipient, kernel);
        else if (index == 1) assertEq(recipient, platformRecipient);
        else assertEq(admin, s.rewards[index - 2].admin);
        assertEq(admin == address(launcher), index < 2, "only the agent and platform slots are the launcher's");
    }

    function _assertLaunchTaxConfigured(bytes memory data) internal pure {
        (, ClankerV5.TaxConfiguration memory t,, bool anti) =
            abi.decode(data, (ClankerV5.TaxPolicy, ClankerV5.TaxConfiguration, address, bool));
        assertEq(t.buyTaxRate, 1_200_000);
        assertEq(t.sellTaxRate, 3_000_000);
        assertEq(t.burnAllocationShare, 10_000_000);
        assertEq(t.dividendAllocationShare, 5_000_000);
        assertEq(t.minimumDividendHolding, MIN_HOLDING);
        assertFalse(anti);
    }

    function _assertV5LaunchedData(bytes memory data, bytes32 poolId) internal pure {
        (bytes32 id, address h, address e, address q, int24 spacing, uint24 buyTax, uint24 sellTax,,,,) = abi.decode(
            data, (bytes32, address, address, address, int24, uint24, uint24, uint16, uint16, bool, bool)
        );
        assertEq(id, poolId);
        assertEq(h, HOOK);
        assertEq(e, ESCROW);
        assertEq(q, USDC);
        assertEq(spacing, 200);
        assertEq(buyTax, 12_000);
        assertEq(sellTax, 30_000);
        (,,,,,,, uint16 burn, uint16 dividends, bool anti, bool editable) = abi.decode(
            data, (bytes32, address, address, address, int24, uint24, uint24, uint16, uint16, bool, bool)
        );
        assertEq(burn, 1000);
        assertEq(dividends, 500);
        assertFalse(anti);
        assertTrue(editable);
    }

    function test_quoteNotOnTheAgentListRefused() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(CBBTC);
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BootrClankerLauncherV5.QuoteNotAllowed.selector, CBBTC));
        launcher.launch(p, s);
        // the plain-token list is separate
        launcher.setQuoteAllowed(BootrClankerLauncherV5.LaunchKind.Plain, CBBTC, true);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(BootrClankerLauncherV5.QuoteNotAllowed.selector, CBBTC));
        launcher.launch(p, s);
    }

    // ------------------------------------------------------------------
    // Fee path: each slot's exact share both ways, burn and dividends as Clanker credits them
    // ------------------------------------------------------------------

    /// @dev ETH pool, buy 1% / sell 3%, burn 10%, dividends 10%, the creator's row and four extra rows, a dev
    ///      buy (so the creator holds coins and dividends are credited from the first trade).
    function test_ethSplitBothWaysWithExtraRowsBurnAndDividends() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        s.buyTaxBps = 10_000;
        s.sellTaxBps = 30_000;
        s.burnBps = 1000;
        s.dividendBps = 1000;
        s.minDividendHolding = MIN_HOLDING;
        s.rewards = _fiveRows();
        (address token, address kernel) = _launch(s, 0.01 ether);
        bytes32 poolId = _poolId(token);
        address tracker = factory.dividendOf(token);
        assertTrue(tracker != address(0), "a dividend tracker for the coin");
        assertGt(IClankerV5Dividend(tracker).totalShares(), 0, "the creator's dev buy qualifies");
        uint256 deadEthBefore = _owed(DEAD, NATIVE);
        uint256 trackerOwedBefore = _owed(tracker, NATIVE);
        // the dev buy itself paid the tax: the escrow already holds each slot's share of it
        uint256[] memory owedBefore = _owedPerSlot(poolId, NATIVE);
        assertGt(owedBefore[0], 0, "the dev buy's tax credited the agent");
        uint256 burnBefore = _owed(DEAD, token);
        assertGt(burnBefore, 0, "and its burn share");
        _passAntiSnipe();

        vm.recordLogs();
        _buy(token, 1 ether);
        Credits memory b = _credits(vm.getRecordedLogs(), poolId);
        _assertSplit(b, s, "buy");
        assertGt(b.burn, 0, "buy: burn taken in the coin");
        assertGt(b.dividend, 0, "buy: dividends credited to the tracker");
        assertEq(b.dividendRedirected, 0);
        assertEq(b.antiSnipe, 0);
        assertEq(b.protocol, 1 ether * 5 / 1000, "1% buy: Clanker's 0.5% floor of the trade");
        // buy and sell carry their own rates: 1% and 3% of the trade in all (quote side + the coin-side burn)
        (ClankerV5.Rates memory buyRate,) = hook.effectiveFeeRates(poolId, true);
        (ClankerV5.Rates memory sellRate,) = hook.effectiveFeeRates(poolId, false);
        assertEq(buyRate.quoteRate + buyRate.burnRate, 1_000_000 * 1e16, "buy tax 1%");
        assertEq(sellRate.quoteRate + sellRate.burnRate, 3_000_000 * 1e16, "sell tax 3%");

        uint256 half = IERC20(token).balanceOf(trader) / 2;
        vm.recordLogs();
        _sell(token, half);
        Credits memory sl = _credits(vm.getRecordedLogs(), poolId);
        _assertSplit(sl, s, "sell");
        assertGt(sl.burn, 0, "sell: burn taken in the coin");
        assertGt(sl.dividend, 0, "sell: dividends credited");
        assertGt(sl.quoteFee, 0, "sell: the quote tax comes out of the ETH output");

        // the escrow holds exactly both sides per slot
        ClankerV5.FeeSlot[] memory slots = hook.poolFeeSlots(poolId);
        assertEq(slots.length, 7);
        uint256[] memory owedAfter = _owedPerSlot(poolId, NATIVE);
        for (uint256 i; i < 7; ++i) {
            assertEq(owedAfter[i] - owedBefore[i], b.slots[i] + sl.slots[i], "each slot's escrow balance: both sides");
        }
        assertEq(slots[0].recipient, kernel);
        assertEq(_owed(tracker, NATIVE) - trackerOwedBefore, b.dividend + sl.dividend, "dividends in the escrow");
        assertEq(_owed(DEAD, NATIVE), deadEthBefore, "the burn never credits ETH to the dead address");
        assertEq(_owed(DEAD, token), burnBefore + b.burn + sl.burn, "the burn is in the coin");

        // anyone finalises the burn: the coin lands at 0x...dEaD
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        vm.prank(stranger);
        escrow.claimFor(DEAD, token);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, burnBefore + b.burn + sl.burn);

        // holders claim their dividends themselves, in ETH
        uint256 owedToCreator = IClankerV5Dividend(tracker).withdrawableDividendOf(creator);
        assertGt(owedToCreator, 0, "the creator held through both trades");
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        IClankerV5Dividend(tracker).withdrawDividends();
        assertEq(creator.balance - creatorBefore, owedToCreator, "dividends paid in native ETH");
        assertEq(IClankerV5Dividend(tracker).withdrawableDividendOf(kernel), 0, "the agent holds no coins");
    }

    /// @dev USDC pool with two rows: buy and sell both ways to the wei, then the agent's own claim lands USDC on
    ///      the kernel (its fuel asset).
    function test_usdcSplitBothWaysAndKernelClaimsUsdc() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(USDC);
        s.sellTaxBps = 25_000;
        s.rewards = new BootrClankerLauncherV5.RewardInput[](2);
        s.rewards[0] = BootrClankerLauncherV5.RewardInput({recipient: creator, admin: creator, bps: 7000});
        s.rewards[1] = BootrClankerLauncherV5.RewardInput({recipient: stranger, admin: creator, bps: 3000});
        (address token, address kernel) = _launch(s, 0);
        bytes32 poolId = _poolId(token);
        _passAntiSnipe();

        vm.recordLogs();
        _buy(token, 1000e6);
        Credits memory b = _credits(vm.getRecordedLogs(), poolId);
        _assertSplit(b, s, "buy");
        assertEq(b.quoteFee, 1000e6 * uint256(TAX) / 1_000_000, "1.5% of the USDC input");
        assertEq(b.protocol, 5e6, "Clanker's 0.5%");

        vm.recordLogs();
        _sell(token, IERC20(token).balanceOf(trader) / 2);
        Credits memory sl = _credits(vm.getRecordedLogs(), poolId);
        _assertSplit(sl, s, "sell");
        assertGt(sl.quoteFee, 0);

        assertEq(_owed(kernel, USDC), b.slots[0] + sl.slots[0]);
        assertEq(_owed(kernel, NATIVE), 0, "nothing in ETH on a USDC pool");
        assertEq(_owed(platformRecipient, USDC), b.slots[1] + sl.slots[1]);
        assertEq(_owed(stranger, USDC), b.slots[3] + sl.slots[3]);
        uint256 fuelBefore = IERC20(USDC).balanceOf(kernel);
        vm.prank(kernel);
        escrow.claimFor(kernel, USDC);
        assertEq(IERC20(USDC).balanceOf(kernel) - fuelBefore, b.slots[0] + sl.slots[0], "claimed USDC is fuel");
    }

    /// @dev While nobody holds the dividend minimum outside the pool, Clanker keeps the dividend part; once a
    ///      holder qualifies, it is credited to the tracker and the holder claims it.
    function test_dividendsGoToClankerUntilSomeoneQualifies() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        s.dividendBps = 2000;
        s.minDividendHolding = MIN_HOLDING;
        (address token,) = _launch(s, 0);
        bytes32 poolId = _poolId(token);
        address tracker = factory.dividendOf(token);
        assertEq(IClankerV5Dividend(tracker).totalShares(), 0);
        _passAntiSnipe();

        vm.recordLogs();
        _buy(token, 0.5 ether);
        Credits memory first = _credits(vm.getRecordedLogs(), poolId);
        _assertSplit(first, s, "first buy");
        assertGt(first.dividendRedirected, 0, "nobody qualified: the dividend part went to Clanker");
        assertEq(first.dividend, 0);
        assertGe(IERC20(token).balanceOf(trader), MIN_HOLDING, "the trader now qualifies");

        vm.recordLogs();
        _buy(token, 0.5 ether);
        Credits memory second = _credits(vm.getRecordedLogs(), poolId);
        _assertSplit(second, s, "second buy");
        assertGt(second.dividend, 0, "credited to the tracker");
        uint256 owed = IClankerV5Dividend(tracker).withdrawableDividendOf(trader);
        assertApproxEqAbs(owed, second.dividend, 2, "the only holder gets all of it");
        uint256 before = trader.balance;
        vm.prank(trader);
        IClankerV5Dividend(tracker).withdrawDividends();
        assertEq(trader.balance - before, owed);
    }

    // ------------------------------------------------------------------
    // Sniper tax
    // ------------------------------------------------------------------

    function test_antiSnipeOnByDefault() public {
        (address token,) = _launch(_settings(NATIVE), 0);
        bytes32 poolId = _poolId(token);
        (ClankerV5.Rates memory rate, bool restricted) = hook.effectiveFeeRates(poolId, true);
        assertTrue(restricted, "exact-output buys are refused in the window");
        assertGt(rate.surchargeRate, 0);
        vm.recordLogs();
        _buy(token, 0.01 ether);
        Credits memory c = _credits(vm.getRecordedLogs(), poolId);
        assertGt(c.antiSnipe, 0, "surcharge credited to Clanker");
        _assertSplit(c, _settings(NATIVE), "in the window");
        _passAntiSnipe();
        (rate, restricted) = hook.effectiveFeeRates(poolId, true);
        assertFalse(restricted);
        assertEq(rate.surchargeRate, 0);
    }

    function test_antiSnipeSwitchedOff() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        s.antiSnipe = false;
        (address token,) = _launch(s, 0);
        bytes32 poolId = _poolId(token);
        assertFalse(_poolConfig(poolId).antiSnipeEnabled);
        (ClankerV5.Rates memory rate, bool restricted) = hook.effectiveFeeRates(poolId, true);
        assertFalse(restricted, "no window");
        assertEq(rate.surchargeRate, 0);
        // a buy in the launch block pays the plain tax
        vm.recordLogs();
        _buy(token, 0.1 ether);
        Credits memory c = _credits(vm.getRecordedLogs(), poolId);
        assertEq(c.antiSnipe, 0, "no surcharge");
        assertEq(c.quoteFee, 0.1 ether * uint256(TAX) / 1_000_000, "the plain 1.5%");
        _assertSplit(c, s, "launch block");
    }

    // ------------------------------------------------------------------
    // Metadata: the creator edits image and metadata, nobody else; the lock; name, symbol, URI frozen
    // ------------------------------------------------------------------

    function test_creatorEditsImageAndMetadata() public {
        (address token,) = _launch(_settings(NATIVE), 0);
        assertEq(IClankerV5Token(token).metadataAuthority(), FACTORY, "editable: the factory is the authority");
        assertTrue(factory.creatorRights(token).metadataEditable);
        assertTrue(launcher.metadataEditable(token));

        vm.recordLogs();
        vm.prank(creator);
        launcher.updateImage(token, "ipfs://bafy-new-image");
        assertEq(IClankerV5Token(token).extraMetadata("image"), "ipfs://bafy-new-image");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawToken;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == token && logs[i].topics[0] == IClankerV5Token.ExtraMetadataUpdated.selector) {
                sawToken = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), FACTORY);
                (string memory key, string memory value) = abi.decode(logs[i].data, (string, string));
                assertEq(key, "image");
                assertEq(value, "ipfs://bafy-new-image");
            }
        }
        assertTrue(sawToken, "the token's own ExtraMetadataUpdated");

        string memory json = '{"description":"edited","socialMediaUrls":[{"platform":"x","url":"https://x.com/a"}],"auditUrls":[]}';
        vm.prank(creator);
        launcher.updateMetadata(token, json);
        assertEq(IClankerV5Token(token).extraMetadata("metadata"), json);

        // name, symbol, contract URI and the context key stay as launched
        assertEq(_name(token), "Bootr Clanker V5 Agent");
        assertEq(_symbol(token), "BCV5");
        assertEq(IClankerV5Token(token).contractURI(), CONTRACT_URI);
        assertEq(IClankerV5Token(token).extraMetadata("context"), '{"interface":"Bootr","platform":"bootr.fun","id":"draft-5"}');
    }

    function test_strangerAndOwnerCannotEdit() public {
        (address token,) = _launch(_settings(NATIVE), 0);
        address[3] memory others = [stranger, address(this), platformRecipient];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert(BootrClankerLauncherV5.NotCoinCreator.selector);
            launcher.updateImage(token, "x");
            vm.expectRevert(BootrClankerLauncherV5.NotCoinCreator.selector);
            launcher.updateMetadata(token, "x");
            vm.expectRevert(BootrClankerLauncherV5.NotCoinCreator.selector);
            launcher.lockMetadata(token);
            vm.stopPrank();
        }
        // nobody but the launcher holds Clanker's rights: direct calls refuse everyone, the creator included
        address[2] memory direct = [creator, stranger];
        for (uint256 i; i < direct.length; ++i) {
            vm.startPrank(direct[i]);
            vm.expectRevert(IClankerV5Factory.NotCurrentCreator.selector);
            factory.updateTokenExtraMetadata(token, "image", "x");
            vm.expectRevert(IClankerV5Factory.NotCurrentCreator.selector);
            factory.updateTokenName(token, "x");
            vm.expectRevert(IClankerV5Factory.NotCurrentCreator.selector);
            factory.updateTokenSymbol(token, "x");
            vm.expectRevert(IClankerV5Factory.NotCurrentCreator.selector);
            factory.updateTokenContractURI(token, "x");
            vm.stopPrank();
        }
        assertEq(IClankerV5Token(token).extraMetadata("image"), "https://bootr.fun/images/test.png");
    }

    function test_lockIsForGood() public {
        (address token,) = _launch(_settings(NATIVE), 0);
        vm.prank(creator);
        launcher.updateImage(token, "ipfs://before-lock");
        vm.prank(creator);
        launcher.lockMetadata(token);
        assertFalse(launcher.metadataEditable(token));
        vm.startPrank(creator);
        vm.expectRevert(BootrClankerLauncherV5.MetadataNotEditable.selector);
        launcher.updateImage(token, "ipfs://after-lock");
        vm.expectRevert(BootrClankerLauncherV5.MetadataNotEditable.selector);
        launcher.updateMetadata(token, "{}");
        vm.stopPrank();
        assertEq(IClankerV5Token(token).extraMetadata("image"), "ipfs://before-lock");
    }

    function test_notEditableLaunchIsFrozen() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        s.metadataEditable = false;
        (address token,) = _launch(s, 0);
        assertEq(IClankerV5Token(token).metadataAuthority(), address(0), "no metadata authority at all");
        assertFalse(factory.creatorRights(token).metadataEditable);
        vm.prank(creator);
        vm.expectRevert(BootrClankerLauncherV5.MetadataNotEditable.selector);
        launcher.updateImage(token, "x");
    }

    function _name(address token) internal view returns (string memory) {
        (, bytes memory ret) = token.staticcall(abi.encodeWithSignature("name()"));
        return abi.decode(ret, (string));
    }

    function _symbol(address token) internal view returns (string memory) {
        (, bytes memory ret) = token.staticcall(abi.encodeWithSignature("symbol()"));
        return abi.decode(ret, (string));
    }

    /// @dev The web writes the JSON itself into `metadata` (lib/contract-metadata.ts): Clanker's factory takes it
    ///      as is, at the longest size the web produces, and the token returns it byte for byte under the
    ///      `metadata` key clanker.world reads; `contractURI()` is the settings' own URI.
    function test_launchCarriesClankerMetadataJson() public {
        string[2] memory docs = [ClankerMetadataJson.typical(), ClankerMetadataJson.longest()];
        for (uint256 i; i < docs.length; ++i) {
            BootrClankerLauncherV5.LaunchParams memory p = _params(0);
            p.metadata = docs[i];
            (address token,,,) = _launchWith(creator, p, _settings(NATIVE), bytes32(uint256(70 + i)));
            assertEq(IClankerV5Token(token).extraMetadata("metadata"), docs[i], "metadata key, byte for byte");
            assertEq(IClankerV5Token(token).contractURI(), CONTRACT_URI, "contract URI is its own field");
        }
        assertGt(bytes(ClankerMetadataJson.longest()).length, 1_000, "the long case is long");
    }

    // ------------------------------------------------------------------
    // Slots: agent and platform locked, every creator row managed by its own admin
    // ------------------------------------------------------------------

    function test_lockedSlotsAndRowAdmins() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        s.rewards = _fiveRows();
        (address token,) = _launch(s, 0);
        bytes32 poolId = _poolId(token);
        address[3] memory callers = [address(this), creator, s.rewards[1].admin];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            for (uint256 slot; slot < 2; ++slot) {
                vm.expectRevert(IClankerV5Hook.NotSlotAdmin.selector);
                hook.updateFeeSlotRecipient(poolId, slot, stranger);
                vm.expectRevert(IClankerV5Hook.NotSlotAdmin.selector);
                hook.updateFeeSlotAdmin(poolId, slot, stranger);
            }
            vm.expectRevert(IClankerV5Factory.NotCurrentCreator.selector);
            factory.setCreatorFeeRecipient(token, stranger);
            vm.expectRevert(IClankerV5Factory.NotCurrentCreator.selector);
            factory.proposeCreatorRightsTransfer(token, stranger);
            vm.stopPrank();
        }
        // the launcher (slot admin and creator-rights holder) exposes no pass-through
        (bool ok,) = address(launcher).call(abi.encodeCall(IClankerV5Hook.updateFeeSlotRecipient, (poolId, 0, stranger)));
        assertFalse(ok);
        (ok,) = address(launcher).call(abi.encodeCall(IClankerV5Factory.updateTokenName, (token, "x")));
        assertFalse(ok);
        (ok,) = address(launcher).call(abi.encodeCall(IClankerV5Factory.setCreatorFeeRecipient, (token, stranger)));
        assertFalse(ok);

        // each creator row's admin manages that row, and only that row
        vm.prank(creator);
        hook.updateFeeSlotRecipient(poolId, 2, makeAddr("bootr.fork.clankerv5.creatorNewWallet"));
        address rowAdmin = s.rewards[3].admin;
        vm.prank(rowAdmin);
        hook.updateFeeSlotRecipient(poolId, 5, stranger);
        vm.prank(rowAdmin);
        vm.expectRevert(IClankerV5Hook.NotSlotAdmin.selector);
        hook.updateFeeSlotRecipient(poolId, 4, stranger);
        vm.prank(rowAdmin);
        hook.updateFeeSlotAdmin(poolId, 5, stranger);
        ClankerV5.FeeSlot[] memory slots = hook.poolFeeSlots(poolId);
        assertEq(slots[2].recipient, makeAddr("bootr.fork.clankerv5.creatorNewWallet"));
        assertEq(slots[5].recipient, stranger);
        assertEq(slots[5].admin, stranger);
        assertEq(slots[0].admin, address(launcher));
        assertEq(slots[1].admin, address(launcher));
        ClankerV5.CreatorRights memory rights = factory.creatorRights(token);
        assertEq(rights.currentCreator, address(launcher), "creator rights belong to the launcher");
        assertEq(rights.originalCreator, address(launcher));
        assertEq(rights.creatorFeeRecipient, creator);
    }

    function test_newDefaultsApplyToFutureLaunchesOnly() public {
        (address first,) = _launch(_settings(NATIVE), 0);
        BootrClankerLauncherV5.AgentDefaults memory d = _defaults();
        d.agentShareBps = 1000;
        d.platformShareBps = 2500;
        launcher.setAgentDefaults(d);
        (address second,,,) = _launchWith(creator, _params(0), _settings(NATIVE), bytes32(uint256(8)));
        assertEq(hook.poolFeeSlots(_poolId(first))[0].weightBps, 500, "launched coins keep their weights");
        assertEq(hook.poolFeeSlots(_poolId(second))[0].weightBps, 1000);
        assertEq(hook.poolFeeSlots(_poolId(second))[1].weightBps, 2500);
    }

    // ------------------------------------------------------------------
    // Launch fee, refund, prediction, salt, replay, pause, gate
    // ------------------------------------------------------------------

    function test_launchFeePaidAndExcessRefunded() public {
        launcher.setLaunchFee(0.0005 ether);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        BootrClankerLauncherV5.LaunchParams memory p = _params(0.01 ether);
        p.salt = _mineSalt(creator, p, s, bytes32(uint256(9)));
        uint256 before = creator.balance;
        uint256 platformBefore = platformRecipient.balance;
        vm.prank(creator);
        launcher.launch{value: 0.5 ether}(p, s);
        assertEq(before - creator.balance, 0.0105 ether, "dev buy + fee spent, excess refunded");
        assertEq(platformRecipient.balance - platformBefore, 0.0005 ether, "fee paid to the platform");
        p = _params(0.01 ether);
        p.salt = _mineSalt(creator, p, s, bytes32(uint256(10)));
        vm.prank(creator);
        vm.expectRevert(BootrClankerLauncherV5.InsufficientValue.selector);
        launcher.launch{value: 0.01 ether}(p, s);
    }

    function test_launchPredictsKernelAndTokenAndRejectsReplay() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(USDC);
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        p.salt = _mineSalt(creator, p, s, bytes32(uint256(7)));
        address predictedKernel = launcher.predictKernel(creator, p.salt);
        address predictedToken = launcher.predictToken(creator, p, s);
        assertEq(uint160(predictedToken) & 0xffff, 0xcccc, "mined salt ends in cccc");
        vm.prank(creator);
        (address token, address kernel,,) = launcher.launch(p, s);
        assertEq(kernel, predictedKernel, "predictKernel");
        assertEq(token, predictedToken, "predictToken");
        vm.prank(creator);
        vm.expectRevert();
        launcher.launch(p, s);
        assertTrue(launcher.predictToken(stranger, p, s) != predictedToken);
        // the settings that change the init code change the address
        s.metadataEditable = false;
        assertTrue(launcher.predictToken(creator, p, s) != predictedToken, "metadataEditable is in the init code");
        s = _settings(USDC);
        s.contractURI = "https://bootr.fun/tokens/other.json";
        assertTrue(launcher.predictToken(creator, p, s) != predictedToken, "the contract URI is in the init code");
        s = _settings(USDC);
        s.buyTaxBps = 20_000;
        s.rewards = _fiveRows();
        assertEq(launcher.predictToken(creator, p, s), predictedToken, "the tax and the rows are not");
    }

    function test_unminedSaltReverts() public {
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        p.salt = bytes32(uint256(1));
        address predicted = launcher.predictToken(creator, p, s);
        if (uint160(predicted) & 0xffff == 0xcccc) return; // one chance in 65536
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IClankerV5Factory.InvalidTokenAddressSuffix.selector, predicted));
        launcher.launch(p, s);
    }

    function test_pausedLauncherRejects() public {
        launcher.pause();
        // the settings are built first: they read the live config version, a call `expectRevert` would catch
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        launcher.launch(_params(0), s);
        launcher.unpause();
        _launch(_settings(NATIVE), 0);
    }

    function test_launchGasAndCodeSize() public {
        assertLt(address(launcher).code.length, MAX_CODE_SIZE, "BootrClankerLauncherV5 over 24 kB");
        console2.log("BootrClankerLauncherV5 runtime bytes:", address(launcher).code.length);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        BootrClankerLauncherV5.LaunchParams memory p = _params(0.01 ether);
        p.salt = _mineSalt(creator, p, s, bytes32(uint256(11)));
        vm.prank(creator);
        uint256 g = gasleft();
        launcher.launch{value: 0.01 ether}(p, s);
        console2.log("launch gas (ETH, one row, dev buy):           ", g - gasleft());
        s = _settings(USDC);
        s.burnBps = 1000;
        s.dividendBps = 1000;
        s.minDividendHolding = MIN_HOLDING;
        s.rewards = _fiveRows();
        p = _params(0.01 ether);
        p.salt = _mineSalt(creator, p, s, bytes32(uint256(12)));
        vm.prank(creator);
        g = gasleft();
        launcher.launch{value: 0.01 ether}(p, s);
        console2.log("launch gas (USDC, five rows, dividends, dev buy):", g - gasleft());
    }

    function test_gateForwardsOnlyForAllowlistedLaunchers() public {
        assertEq(guardian.launcher(), address(gate));
        assertTrue(gate.launchers(address(launcher)));
        (, address kernel) = _launch(_settings(NATIVE), 0);
        assertTrue(guardian.isRegistered(kernel), "registered through the gate");
        vm.prank(address(launcher));
        vm.expectRevert(AgentGuardian.NotLauncher.selector);
        guardian.registerAgent(kernel, address(1), creator, DORMANCY);
        gate.removeLauncher(address(launcher));
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        p.salt = _mineSalt(creator, p, s, bytes32(uint256(8)));
        vm.prank(creator);
        vm.expectRevert(BootrLaunchGate.NotLauncher.selector);
        launcher.launch(p, s);
        gate.addLauncher(address(launcher));
        vm.prank(creator);
        launcher.launch(p, s);
    }

    // ------------------------------------------------------------------
    // Invariants of every launch
    // ------------------------------------------------------------------

    function _assertLaunchInvariants(
        address token,
        address kernel,
        uint256 agentId,
        BootrClankerLauncherV5.LaunchParams memory p,
        BootrClankerLauncherV5.TokenSettings memory s
    ) internal view {
        // token: a v5 launch token, cccc suffix, fixed supply, the three keys, the settings' contract URI
        assertEq(uint160(token) & 0xffff, 0xcccc, "v5 token address suffix");
        assertTrue(factory.isLaunchToken(token));
        assertEq(IClankerV5Token(token).factory(), FACTORY);
        assertEq(IERC20(token).totalSupply(), TOTAL_SUPPLY);
        assertEq(IClankerV5Token(token).contractURI(), s.contractURI);
        assertEq(IClankerV5Token(token).extraMetadata("image"), p.image);
        assertEq(IClankerV5Token(token).extraMetadata("metadata"), p.metadata);
        assertEq(IClankerV5Token(token).extraMetadata("context"), p.context);
        assertEq(IClankerV5Token(token).metadataAuthority(), s.metadataEditable ? FACTORY : address(0));

        // the launcher's records
        assertEq(launcher.quoteOf(token), s.quoteToken);
        assertEq(launcher.coinCreator(token), creator);
        assertEq(launcher.metadataEditable(token), s.metadataEditable);

        _assertPool(token, s);
        _assertSlots(token, kernel, s);
        _assertAgent(token, kernel, agentId, p);
    }

    function _assertPool(address token, BootrClankerLauncherV5.TokenSettings memory s) internal view {
        // pool: the settings' quote, tax per side, shares, sniper switch, dividend tracker iff dividends
        bytes32 poolId = _poolId(token);
        IClankerV5Hook.PoolConfig memory cfg = _poolConfig(poolId);
        assertTrue(cfg.initialized, "pool registered on the hook");
        assertEq(cfg.token, token);
        assertEq(cfg.quoteToken, s.quoteToken);
        assertEq(cfg.tokenIsCurrency0, token < s.quoteToken);
        assertEq(cfg.currentCreator, address(launcher));
        assertEq(cfg.antiSnipeEnabled, s.antiSnipe);
        assertEq(cfg.integratorFeeRecipient, address(0));
        assertEq(cfg.dividend != address(0), s.dividendBps > 0, "a tracker iff dividends");
        ClankerV5.TaxConfiguration memory want = launcher.taxConfigurationFor(s);
        ClankerV5.TaxConfiguration memory t = cfg.taxConfiguration;
        assertEq(t.buyTaxRate, want.buyTaxRate);
        assertEq(t.sellTaxRate, want.sellTaxRate);
        assertEq(t.creatorAllocationShare, want.creatorAllocationShare);
        assertEq(t.burnAllocationShare, want.burnAllocationShare);
        assertEq(t.dividendAllocationShare, want.dividendAllocationShare);
        assertEq(t.integratorAllocationShare, 0);
        assertEq(t.minimumDividendHolding, s.minDividendHolding);

    }

    function _assertSlots(address token, address kernel, BootrClankerLauncherV5.TokenSettings memory s)
        internal
        view
    {
        bytes32 poolId = _poolId(token);
        // fee slots: agent, platform (both locked), then the creator rows with their own admins
        ClankerV5.FeeSlot[] memory slots = hook.poolFeeSlots(poolId);
        uint16[] memory w = launcher.previewSlotWeights(s);
        assertEq(slots.length, 2 + s.rewards.length);
        assertEq(slots[0].recipient, kernel);
        assertEq(slots[0].admin, address(launcher));
        assertEq(slots[1].recipient, platformRecipient);
        assertEq(slots[1].admin, address(launcher));
        for (uint256 i; i < slots.length; ++i) {
            _assertSlot(slots[i], w[i], i < 2 ? address(0) : s.rewards[i - 2].recipient, i < 2 ? address(0) : s.rewards[i - 2].admin);
        }
    }

    /// @dev One slot as launched: its weight, no creator flag, and (for a creator row) its recipient and admin.
    function _assertSlot(ClankerV5.FeeSlot memory slot, uint16 weight, address recipient, address admin)
        internal
        pure
    {
        assertFalse(slot.isCreator, "no factory-managed creator slot");
        assertEq(slot.weightBps, weight);
        if (recipient != address(0)) {
            assertEq(slot.recipient, recipient);
            assertEq(slot.admin, admin);
        }
    }

    function _assertAgent(
        address token,
        address kernel,
        uint256 agentId,
        BootrClankerLauncherV5.LaunchParams memory p
    ) internal view {
        // kernel: root validator + hook = guardian, fuel inside
        assertEq(IKernel(kernel).rootValidator(), KernelLib.validatorId(address(guardian)), "root is the guardian");
        assertEq(IKernel(kernel).validationConfig(KernelLib.validatorId(address(guardian))).hook, address(guardian));
        assertEq(IERC20(USDC).balanceOf(kernel), p.fuelUsdc, "fuel in the kernel");

        // ERC-8004 identity owned by the kernel
        assertEq(IERC8004IdentityRegistry(IDENTITY).ownerOf(agentId), kernel, "identity owned by the kernel");
        assertEq(IERC8004IdentityRegistry(IDENTITY).tokenURI(agentId), p.agentURI);

        // guardian
        AgentGuardian.AgentInfo memory a = guardian.agentInfo(kernel);
        assertEq(a.token, token);
        assertEq(a.creator, creator);
        assertEq(a.dormancyPeriod, DORMANCY);
        assertFalse(a.paused);
        // nothing stays in the launcher
        assertEq(address(launcher).balance, 0);
        assertEq(IERC20(token).balanceOf(address(launcher)), 0);
        assertEq(IERC20(USDC).balanceOf(address(launcher)), 0);
    }
}
