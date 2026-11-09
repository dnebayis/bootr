// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrClankerLauncherV5} from "../../src/BootrClankerLauncherV5.sol";
import {BootrLaunchGate} from "../../src/BootrLaunchGate.sol";
import {
    ClankerV5, IClankerV5Factory, IClankerV5FeeEscrow, IClankerV5Hook, IClankerV5Token
} from "../../src/interfaces/IClankerV5.sol";
import {IERC8004IdentityRegistry} from "../../src/interfaces/IERC8004IdentityRegistry.sol";
import {IKernel, KernelLib} from "../../src/interfaces/IKernel.sol";
import {IPermit2, IUniversalRouter, IV4Router, PoolKey, V4Constants} from "../../src/interfaces/IUniswapV4.sol";

/// @notice Fork tests of the Clanker v5 path against Base MAINNET: `BootrClankerLauncherV5` through the live v5
///         factory (`TaxRWAERC20LaunchpadFactory`, the `TaxLaunchHook`, the `FeeEscrow`, the launch-buy adapter),
///         registering through the `BootrLaunchGate`. Stock `forge` is enough (no B20 precompiles).
///         RPC: `BASE_RPC_URL` env or https://mainnet.base.org (no archive state needed).
///         Design: docs/design/clanker-v5-migration.md.
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
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant KERNEL_FACTORY = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant NATIVE = address(0);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint24 constant TAX = 15_000; // 1.5%, the recommended rate (design note section 4)
    uint256 constant MAX_CODE_SIZE = 24_576;
    uint256 constant ANTI_SNIPE_WINDOW = 20;

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

    /// @dev What one swap credited, decoded from the hook's logs.
    struct Credits {
        uint256 quoteFee; // Trade.quoteFeeAmount: the whole quote-side tax
        uint256 protocol; // ProtocolFeeCredited
        uint256 antiSnipe; // AntiSnipeFeeCredited
        uint256 burn; // BurnTaxCredited (in the coin)
        uint256 agent; // CreatorTaxCredited to the kernel
        uint256 creator; // CreatorTaxCredited to the creator
        uint256 platform; // CreatorTaxCredited to the platform
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
                quoteToken: NATIVE,
                usdc: USDC,
                identityRegistry: IDENTITY,
                kernelFactory: KERNEL_FACTORY,
                guardian: address(guardian),
                gate: address(gate)
            }),
            _defaults(false),
            _defaults(true),
            1000
        );
        guardian.setLauncher(address(gate));
        gate.addLauncher(address(launcher));
        guardian.setPlatformTreasury(treasury);

        deal(USDC, creator, 10_000e6);
        deal(USDC, platformRecipient, 10_000e6);
        vm.deal(creator, 100 ether);
        vm.deal(platformRecipient, 100 ether);
        vm.prank(creator);
        IERC20(USDC).approve(address(launcher), type(uint256).max);
        vm.prank(platformRecipient);
        IERC20(USDC).approve(address(launcher), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Fixture
    // ------------------------------------------------------------------

    /// @dev The presets of the live v4 launcher (5 / 65 / 30 and 5 / 50 / 15 / 30) at the 1.5% tax.
    function _defaults(bool buyback) internal view returns (BootrClankerLauncherV5.LaunchDefaults memory) {
        return BootrClankerLauncherV5.LaunchDefaults({
            lpFeeBps: TAX,
            agentBps: 500,
            creatorBps: buyback ? 5000 : 6500,
            burnBps: buyback ? 1500 : 0,
            platformBps: 3000,
            platformRecipient: platformRecipient,
            minFuelUsdc: 25e6,
            dormancyPeriod: DORMANCY
        });
    }

    function _params(bool buyback, uint256 devBuyWei) internal view returns (BootrClankerLauncherV5.LaunchParams memory p) {
        p = BootrClankerLauncherV5.LaunchParams({
            name: "Bootr Clanker V5 Agent",
            symbol: "BCV5",
            image: "https://bootr.fun/images/test.png",
            metadata: '{"description":"mainnet fork launch through Clanker v5"}',
            context: '{"interface":"Bootr","platform":"bootr.fun","id":"draft-5"}',
            salt: bytes32(0),
            buybackBurn: buyback,
            fuelUsdc: FUEL,
            devBuyWei: devBuyWei,
            workerHash: keccak256("worker"),
            model: "claude-sonnet-4-5",
            agentURI: "https://bootr.fun/agents/test.json",
            supervisorSessionKey: sessionKey
        });
    }

    /// @dev What the web does before signing: one `tokenInitCodeHash` read, then local keccaks until the
    ///      predicted token address ends in 0xcccc (about 65k tries on average). In assembly over a fixed scratch
    ///      region so that the search allocates no memory (a Solidity loop runs out of memory gas).
    function _mineSalt(address who, BootrClankerLauncherV5.LaunchParams memory p, bytes32 seed)
        internal
        view
        returns (bytes32 salt)
    {
        bytes32 initCodeHash = launcher.tokenInitCodeHash(p);
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

    function _launchAs(address who, bool buyback, uint256 devBuyWei, bytes32 seed)
        internal
        returns (address token, address kernel, address burner, uint256 agentId)
    {
        BootrClankerLauncherV5.LaunchParams memory p = _params(buyback, devBuyWei);
        p.salt = _mineSalt(who, p, seed);
        vm.prank(who);
        (token, kernel, burner, agentId) = launcher.launch{value: devBuyWei}(p);
    }

    function _launch(bool buyback, uint256 devBuyWei)
        internal
        returns (address token, address kernel, address burner, uint256 agentId)
    {
        return _launchAs(creator, buyback, devBuyWei, bytes32(uint256(7)));
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

    /// @dev Exact-input ETH -> coin swap through the Universal Router (what traders do; native ETH settles from
    ///      the router's msg.value).
    function _buy(address token, uint256 ethIn) internal {
        PoolKey memory key = launcher.poolKeyFor(token);
        vm.deal(trader, trader.balance + ethIn);
        bytes memory actions = abi.encodePacked(
            V4Constants.ACTION_SWAP_EXACT_IN_SINGLE, V4Constants.ACTION_SETTLE_ALL, V4Constants.ACTION_TAKE_ALL
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key, zeroForOne: true, amountIn: uint128(ethIn), amountOutMinimum: 1, hookData: ""
            })
        );
        params[1] = abi.encode(NATIVE, ethIn);
        params[2] = abi.encode(token, uint256(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.prank(trader);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: ethIn}(
            abi.encodePacked(V4Constants.CMD_V4_SWAP), inputs, block.timestamp
        );
    }

    /// @dev Exact-input coin -> ETH swap through the Universal Router; the trader receives native ETH.
    function _sell(address token, uint256 amountIn) internal {
        PoolKey memory key = launcher.poolKeyFor(token);
        vm.startPrank(trader);
        IERC20(token).approve(PERMIT2, amountIn);
        IPermit2(PERMIT2).approve(token, UNIVERSAL_ROUTER, uint160(amountIn), uint48(block.timestamp + 1 hours));
        bytes memory actions = abi.encodePacked(
            V4Constants.ACTION_SWAP_EXACT_IN_SINGLE, V4Constants.ACTION_SETTLE_ALL, V4Constants.ACTION_TAKE_ALL
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key, zeroForOne: false, amountIn: uint128(amountIn), amountOutMinimum: 1, hookData: ""
            })
        );
        params[1] = abi.encode(token, amountIn);
        params[2] = abi.encode(NATIVE, uint256(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        IUniversalRouter(UNIVERSAL_ROUTER).execute(abi.encodePacked(V4Constants.CMD_V4_SWAP), inputs, block.timestamp);
        vm.stopPrank();
    }

    /// @dev The hook's credits of one swap, from the recorded logs of the pool `poolId`.
    function _credits(Vm.Log[] memory logs, bytes32 poolId, address kernel) internal view returns (Credits memory c) {
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
            } else if (sig == IClankerV5Hook.CreatorTaxCredited.selector) {
                address recipient = address(uint160(uint256(l.topics[2])));
                (, uint256 amount) = abi.decode(l.data, (address, uint256));
                c.slotsTotal += amount;
                if (recipient == kernel) c.agent += amount;
                else if (recipient == creator) c.creator += amount;
                else if (recipient == platformRecipient) c.platform += amount;
                else revert("credit to an unknown slot");
            }
        }
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
        (bool registered, uint8 decimals, int24 frame) = factory.quoteConfig(NATIVE);
        assertTrue(registered, "native ETH not a registered quote");
        assertEq(decimals, 18);
        console2.log("quote start tick (token0 frame):", frame);
        (bool wethRegistered,,) = factory.quoteConfig(WETH);
        assertFalse(wethRegistered, "WETH is not a v5 quote: ETH pools are native");
        ClankerV5.TaxPolicy memory policy = factory.taxPolicy();
        assertLe(policy.taxFeeBounds.minimumBuyTaxRate, uint32(launcher.MIN_TAX_BPS()) * 100, "launcher floor under Clanker's");
        assertGe(policy.taxFeeBounds.maximumBuyTaxRate, uint32(launcher.MAX_TAX_BPS()) * 100, "launcher ceiling over Clanker's");
        assertLe(policy.taxFeeBounds.minimumSellTaxRate, uint32(launcher.MIN_TAX_BPS()) * 100);
        assertGe(policy.taxFeeBounds.maximumSellTaxRate, uint32(launcher.MAX_TAX_BPS()) * 100);
        assertEq(policy.protocolFeeConfiguration.protocolTaxShare, 10_000_000, "Clanker takes 10% of the tax");
        assertEq(policy.protocolFeeConfiguration.minimumProtocolFeeRate, 500_000, "at least 0.5% of the trade");
        assertEq(policy.protocolFeeConfiguration.maximumProtocolFeeRate, 1_000_000, "at most 1% of the trade");
        assertEq(policy.antiSnipeConfiguration.windowSeconds, ANTI_SNIPE_WINDOW);
        assertEq(policy.antiSnipeConfiguration.startTotalFeeRate, 99_000_000);
        // the preview the factory computes for the recommended tax: 1.5% in, 0.5% to Clanker, 1% to the slots
        (, ClankerV5.Rates memory buy, ClankerV5.Rates memory sell, bool dividends,) =
            factory.previewTaxConfiguration(launcher.taxConfigurationFor(false));
        assertFalse(dividends);
        assertEq(buy.protocolRate, 500_000 * 1e16, "0.5% of the trade on the 1e24 scale");
        assertEq(buy.creatorRate, 1_000_000 * 1e16, "1% of the trade to the slots");
        assertEq(buy.burnRate, 0);
        assertEq(sell.protocolRate, buy.protocolRate);
        assertEq(sell.creatorRate, buy.creatorRate);
        (, buy,,,) = factory.previewTaxConfiguration(launcher.taxConfigurationFor(true));
        assertEq(buy.protocolRate, 500_000 * 1e16);
        assertEq(buy.creatorRate, 850_000 * 1e16, "85% of the 1% to the slots");
        assertEq(buy.burnRate, 150_000 * 1e16, "15% of the 1% burned in the coin");
    }

    // ------------------------------------------------------------------
    // Launches: both presets, with and without a dev buy
    // ------------------------------------------------------------------

    function test_launchStandardNoDevBuy() public {
        (address token, address kernel, address burner, uint256 agentId) = _launch(false, 0);
        assertEq(burner, address(0));
        _assertLaunchInvariants(token, kernel, burner, agentId, false, TAX);
        assertEq(IERC20(token).balanceOf(creator), 0);
    }

    function test_launchStandardWithDevBuy() public {
        uint256 before = creator.balance;
        vm.recordLogs();
        (address token, address kernel, address burner, uint256 agentId) = _launch(false, 0.01 ether);
        _assertLaunchInvariants(token, kernel, burner, agentId, false, TAX);
        assertGt(IERC20(token).balanceOf(creator), 0, "dev buy delivered to the creator");
        assertEq(before - creator.balance, 0.01 ether, "exactly the dev buy was spent");
        // Clanker's LaunchBuyExecuted names the launcher as the buyer and the creator got exactly that amount
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool saw;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == FACTORY && logs[i].topics[0] == IClankerV5Factory.LaunchBuyExecuted.selector) {
                saw = true;
                assertEq(address(uint160(uint256(logs[i].topics[3]))), address(launcher), "originalCreator is the launcher");
                (address fundingToken, uint256 amountIn, uint256 amountOut,) =
                    abi.decode(logs[i].data, (address, uint256, uint256, address));
                assertEq(fundingToken, NATIVE);
                assertEq(amountIn, 0.01 ether);
                assertEq(IERC20(token).balanceOf(creator), amountOut, "the whole buy forwarded to the creator");
            }
        }
        assertTrue(saw, "LaunchBuyExecuted");
    }

    function test_launchBuybackWithDevBuy() public {
        (address token, address kernel, address burner, uint256 agentId) = _launch(true, 0.02 ether);
        assertEq(burner, DEAD, "the burn's escrow recipient is the dead address");
        _assertLaunchInvariants(token, kernel, burner, agentId, true, TAX);
        assertGt(IERC20(token).balanceOf(creator), 0);
    }

    function test_launchBuybackNoDevBuy() public {
        (address token, address kernel, address burner, uint256 agentId) = _launch(true, 0);
        assertEq(burner, DEAD);
        _assertLaunchInvariants(token, kernel, burner, agentId, true, TAX);
    }

    function test_launchEventsCarryTheV5Facts() public {
        vm.recordLogs();
        (address token, address kernel,,) = _launch(true, 0.01 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawAgent;
        bool sawV5;
        bool sawContext;
        bool sawLaunched;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(launcher)) {
                if (logs[i].topics[0] == BootrClankerLauncherV5.AgentLaunched.selector) {
                    sawAgent = true;
                    assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
                    assertEq(address(uint160(uint256(logs[i].topics[2]))), kernel);
                    assertEq(address(uint160(uint256(logs[i].topics[3]))), creator);
                    (address burner,, BootrClankerLauncherV5.LaunchDefaults memory d,,,,) = abi.decode(
                        logs[i].data,
                        (address, uint256, BootrClankerLauncherV5.LaunchDefaults, bytes32, string, string, address)
                    );
                    assertEq(burner, DEAD);
                    assertEq(d.lpFeeBps, TAX);
                    assertEq(d.burnBps, 1500);
                    assertEq(d.platformRecipient, platformRecipient);
                } else if (logs[i].topics[0] == BootrClankerLauncherV5.ClankerV5Launched.selector) {
                    sawV5 = true;
                    assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
                    (bytes32 poolId, address h, address e, address q, int24 spacing, uint24 tax, bool anti) =
                        abi.decode(logs[i].data, (bytes32, address, address, address, int24, uint24, bool));
                    assertEq(poolId, _poolId(token));
                    assertEq(h, HOOK);
                    assertEq(e, ESCROW);
                    assertEq(q, NATIVE);
                    assertEq(spacing, 200);
                    assertEq(tax, TAX);
                    assertTrue(anti);
                } else if (logs[i].topics[0] == BootrClankerLauncherV5.LaunchContext.selector) {
                    sawContext = true;
                    assertEq(abi.decode(logs[i].data, (string)), '{"interface":"Bootr","platform":"bootr.fun","id":"draft-5"}');
                }
            } else if (logs[i].emitter == FACTORY && logs[i].topics[0] == IClankerV5Factory.Launched.selector) {
                sawLaunched = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
                assertEq(logs[i].topics[2], _poolId(token));
                assertEq(address(uint160(uint256(logs[i].topics[3]))), address(launcher), "originalCreator = launcher");
                (address quote, uint256 supply, int24 spacing) = abi.decode(logs[i].data, (address, uint256, int24));
                assertEq(quote, NATIVE);
                assertEq(supply, TOTAL_SUPPLY);
                assertEq(spacing, 200);
            }
        }
        assertTrue(sawAgent && sawV5 && sawContext && sawLaunched, "all four launch events");
    }

    // ------------------------------------------------------------------
    // Platform tax: the treasury's own coin at 2%, everyone else at the preset 1.5%
    // ------------------------------------------------------------------

    function test_platformTreasuryLaunchesAtPlatformTax() public {
        (address t0,,,) = _launchAs(platformRecipient, false, 0, bytes32(uint256(1)));
        assertEq(_taxOf(t0), uint32(TAX) * 100, "off by default: the preset tax");

        launcher.setPlatformTaxBps(20_000);
        (address t1, address k1,, uint256 id1) = _launchAs(platformRecipient, false, 0.01 ether, bytes32(uint256(2)));
        _assertLaunchInvariants(t1, k1, address(0), id1, false, 20_000);
        assertEq(_taxOf(t1), 2_000_000, "treasury coin: 2% tax");
        (uint24 preset,,,,,,,) = launcher.standardDefaults();
        assertEq(preset, TAX, "the stored preset is untouched");
        (address t2,,,) = _launch(false, 0);
        assertEq(_taxOf(t2), uint32(TAX) * 100, "other creator: preset tax");
        launcher.setPlatformTaxBps(0);
        (address t3,,,) = _launchAs(platformRecipient, true, 0, bytes32(uint256(3)));
        assertEq(_taxOf(t3), uint32(TAX) * 100);
    }

    function _taxOf(address token) internal view returns (uint32) {
        ClankerV5.TaxConfiguration memory t = _poolConfig(_poolId(token)).taxConfiguration;
        assertEq(t.buyTaxRate, t.sellTaxRate, "buy tax == sell tax");
        return t.buyTaxRate;
    }

    /// @dev `hook.poolConfig(poolId)` as the struct (the getter's tuple is static, so it decodes as one).
    function _poolConfig(bytes32 poolId) internal view returns (IClankerV5Hook.PoolConfig memory cfg) {
        (bool ok, bytes memory ret) = HOOK.staticcall(abi.encodeWithSelector(IClankerV5Hook.poolConfig.selector, poolId));
        require(ok, "poolConfig read failed");
        cfg = abi.decode(ret, (IClankerV5Hook.PoolConfig));
    }

    // ------------------------------------------------------------------
    // Launch fee, refund, prediction, salt, replay, pause
    // ------------------------------------------------------------------

    function test_launchFeePaidAndExcessRefunded() public {
        launcher.setLaunchFee(0.0005 ether);
        BootrClankerLauncherV5.LaunchParams memory p = _params(false, 0.01 ether);
        p.salt = _mineSalt(creator, p, bytes32(uint256(9)));
        uint256 before = creator.balance;
        uint256 platformBefore = platformRecipient.balance;
        vm.prank(creator);
        launcher.launch{value: 0.5 ether}(p);
        assertEq(before - creator.balance, 0.0105 ether, "dev buy + fee spent, excess refunded");
        assertEq(platformRecipient.balance - platformBefore, 0.0005 ether, "fee paid to the platform");
        p = _params(false, 0.01 ether);
        p.salt = _mineSalt(creator, p, bytes32(uint256(10)));
        vm.prank(creator);
        vm.expectRevert(BootrClankerLauncherV5.InsufficientValue.selector);
        launcher.launch{value: 0.01 ether}(p);
    }

    function test_launchPredictsKernelAndTokenAndRejectsReplay() public {
        BootrClankerLauncherV5.LaunchParams memory p = _params(false, 0);
        p.salt = _mineSalt(creator, p, bytes32(uint256(7)));
        address predictedKernel = launcher.predictKernel(creator, p.salt);
        address predictedToken = launcher.predictToken(creator, p);
        assertEq(uint160(predictedToken) & 0xffff, 0xcccc, "mined salt ends in cccc");
        vm.prank(creator);
        (address token, address kernel,,) = launcher.launch(p);
        assertEq(kernel, predictedKernel, "predictKernel");
        assertEq(token, predictedToken, "predictToken");
        // same creator + salt -> same kernel and scoped salt -> rejected
        vm.prank(creator);
        vm.expectRevert();
        launcher.launch(p);
        // the same salt from another creator is a different scoped salt (and a different kernel): it is not
        // a replay, it just needs its own mining
        assertTrue(launcher.predictToken(stranger, p) != predictedToken);
    }

    function test_unminedSaltReverts() public {
        BootrClankerLauncherV5.LaunchParams memory p = _params(false, 0);
        p.salt = bytes32(uint256(1));
        address predicted = launcher.predictToken(creator, p);
        if (uint160(predicted) & 0xffff == 0xcccc) return; // one chance in 65536
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IClankerV5Factory.InvalidTokenAddressSuffix.selector, predicted));
        launcher.launch(p);
    }

    function test_pausedLauncherRejects() public {
        launcher.pause();
        BootrClankerLauncherV5.LaunchParams memory p = _params(false, 0);
        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        launcher.launch(p);
        launcher.unpause();
        _launch(false, 0);
    }

    function test_launchGasAndCodeSize() public {
        assertLt(address(launcher).code.length, MAX_CODE_SIZE, "BootrClankerLauncherV5 over 24 kB");
        console2.log("BootrClankerLauncherV5 runtime bytes:", address(launcher).code.length);
        BootrClankerLauncherV5.LaunchParams memory p = _params(false, 0.01 ether);
        p.salt = _mineSalt(creator, p, bytes32(uint256(11)));
        vm.prank(creator);
        uint256 g = gasleft();
        launcher.launch{value: 0.01 ether}(p);
        console2.log("launch gas (standard, dev buy):   ", g - gasleft());
        p = _params(true, 0);
        p.salt = _mineSalt(creator, p, bytes32(uint256(12)));
        vm.prank(creator);
        g = gasleft();
        launcher.launch(p);
        console2.log("launch gas (buyback, no dev buy): ", g - gasleft());
    }

    // ------------------------------------------------------------------
    // Fee path: swap -> escrow credits -> claim pays the recipient in native ETH
    // ------------------------------------------------------------------

    function test_swapAccruesTaxAndKernelClaimsNativeEth() public {
        (address token, address kernel,,) = _launch(false, 0);
        _passAntiSnipe();
        uint256 ethIn = 1 ether;
        vm.recordLogs();
        _buy(token, ethIn);
        Credits memory c = _credits(vm.getRecordedLogs(), _poolId(token), kernel);
        // exact-in buy of 1 ETH at 1.5%: 0.015 ETH of tax, 0.005 to Clanker, 0.01 to the slots in 5 / 65 / 30
        assertEq(c.quoteFee, ethIn * TAX / 1_000_000, "tax is 1.5% of the input");
        assertEq(c.protocol, ethIn * 5 / 1000, "Clanker's floor: 0.5% of the trade");
        assertEq(c.antiSnipe, 0, "past the window");
        assertEq(c.burn, 0, "standard preset burns nothing");
        assertEq(c.slotsTotal, c.quoteFee - c.protocol, "the slots share everything after Clanker");
        assertEq(c.agent, c.slotsTotal * 500 / 10_000);
        assertEq(c.creator, c.slotsTotal * 6500 / 10_000);
        assertEq(c.platform, c.slotsTotal - c.agent - c.creator, "the last slot takes the wei remainder");
        assertEq(c.platform, c.slotsTotal * 3000 / 10_000, "which is exactly 30% here");
        // the credits are the escrow balances, in native ETH
        assertEq(_owed(kernel, NATIVE), c.agent);
        assertEq(_owed(creator, NATIVE), c.creator);
        assertEq(_owed(platformRecipient, NATIVE), c.platform);
        assertEq(_owed(kernel, token), 0, "nothing in the coin");
        // the kernel's own claim op: one call, pays the kernel in ETH
        uint256 kernelBefore = kernel.balance;
        vm.prank(kernel);
        escrow.claimFor(kernel, NATIVE);
        assertEq(kernel.balance - kernelBefore, c.agent, "kernel received its ETH share");
        assertEq(_owed(kernel, NATIVE), 0);
        // claimFor is permissionless and always pays the recipient
        uint256 creatorBefore = creator.balance;
        vm.prank(stranger);
        escrow.claimFor(creator, NATIVE);
        assertEq(creator.balance - creatorBefore, c.creator);
        assertEq(stranger.balance, 0);
        vm.prank(stranger);
        vm.expectRevert(IClankerV5FeeEscrow.NothingToClaim.selector);
        escrow.claimFor(creator, NATIVE);
    }

    /// @dev The test the v4 path could not pass: on the buyback preset each slot receives exactly its weight of
    ///      the quote-side tax on a SELL as on a buy, the platform never more than its stated 30% of the slot
    ///      pool (burn included), and the burn is taken in the coin on both sides.
    function test_sellSideSplitBuyback() public {
        (address token, address kernel, address burner,) = _launch(true, 0);
        assertEq(burner, DEAD);
        bytes32 poolId = _poolId(token);
        // other v5 pools may name the dead address as a paid recipient; the escrow balance is shared state
        uint256 deadEthBefore = _owed(DEAD, NATIVE);
        _passAntiSnipe();

        // buy side
        vm.recordLogs();
        _buy(token, 1 ether);
        Credits memory b = _credits(vm.getRecordedLogs(), poolId, kernel);
        _assertSplit(b, "buy");
        assertGt(b.burn, 0, "buy: burn taken in the coin");
        uint256 burnOwedAfterBuy = _owed(DEAD, token);
        assertEq(burnOwedAfterBuy, b.burn);

        // sell side: half of what the trader bought
        uint256 half = IERC20(token).balanceOf(trader) / 2;
        vm.recordLogs();
        _sell(token, half);
        Credits memory s = _credits(vm.getRecordedLogs(), poolId, kernel);
        _assertSplit(s, "sell");
        assertGt(s.burn, 0, "sell: burn taken in the coin");
        assertGt(s.quoteFee, 0, "sell: the quote-side tax comes out of the ETH output");
        assertEq(_owed(DEAD, token), burnOwedAfterBuy + s.burn);

        // the escrow holds exactly the sum of both sides per slot
        assertEq(_owed(kernel, NATIVE), b.agent + s.agent);
        assertEq(_owed(creator, NATIVE), b.creator + s.creator);
        assertEq(_owed(platformRecipient, NATIVE), b.platform + s.platform);
        assertEq(_owed(DEAD, NATIVE), deadEthBefore, "our burn never credits ETH to the dead address");

        // anyone finalises the burn: the coin lands at 0x...dEaD and is out of circulation
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        vm.prank(stranger);
        escrow.claimFor(DEAD, token);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, b.burn + s.burn);
        assertEq(_owed(DEAD, token), 0);
    }

    function _assertSplit(Credits memory c, string memory side) internal pure {
        assertEq(c.antiSnipe, 0, string.concat(side, ": past the window"));
        assertGt(c.protocol, 0);
        // the quote-side tax of the buyback preset is 0.5% (Clanker) + 0.85% (the slots; the burn's 0.15% is
        // taken in the coin), so Clanker's share of it is 10/27 on both sides
        assertApproxEqAbs(c.protocol * 27, c.quoteFee * 10, 30, string.concat(side, ": Clanker takes 10/27 of the quote tax"));
        uint256 pool = c.quoteFee - c.protocol;
        assertEq(c.slotsTotal, pool, string.concat(side, ": the slots share everything after Clanker"));
        // exact weights 588 / 5883 / 3529 of the slot pool, the last slot (platform) with the wei remainder
        assertEq(c.agent, pool * 588 / 10_000, string.concat(side, ": agent weight"));
        assertEq(c.creator, pool * 5883 / 10_000, string.concat(side, ": creator weight"));
        assertEq(c.platform, pool - c.agent - c.creator, string.concat(side, ": platform remainder"));
        assertLe(c.platform - pool * 3529 / 10_000, 2, string.concat(side, ": remainder is wei dust"));
        // the stated split is 5 / 50 / 15 / 30 of (slots + burn); the slots are 85% of it, so the platform
        // may never exceed 30% of the slot pool / 0.85, and the creator gets at least its 50%
        assertLe(c.platform * 8500, pool * 3000, string.concat(side, ": platform at most its stated 30%"));
        assertLe(c.agent * 8500, pool * 500, string.concat(side, ": agent at most its stated 5%"));
        assertGe(c.creator * 8500, pool * 5000, string.concat(side, ": creator at least its stated 50%"));
    }

    function test_antiSnipeWindow() public {
        (address token, address kernel,,) = _launch(false, 0);
        bytes32 poolId = _poolId(token);
        (ClankerV5.Rates memory rate, bool restricted) = hook.effectiveFeeRates(poolId, true);
        assertTrue(restricted, "exact-output buys are refused in the window");
        assertGt(rate.surchargeRate, 0, "a buy right after the launch pays the surcharge");
        // a buy in the window: the surcharge goes to Clanker, the slots still get their share of the plain tax
        vm.recordLogs();
        _buy(token, 0.01 ether);
        Credits memory c = _credits(vm.getRecordedLogs(), poolId, kernel);
        assertGt(c.antiSnipe, 0, "surcharge credited to Clanker");
        assertEq(c.slotsTotal, c.quoteFee - c.protocol - c.antiSnipe);
        _passAntiSnipe();
        (rate, restricted) = hook.effectiveFeeRates(poolId, true);
        assertFalse(restricted);
        assertEq(rate.surchargeRate, 0);
    }

    // ------------------------------------------------------------------
    // Immutability of slots, rights and metadata
    // ------------------------------------------------------------------

    function test_slotsRightsAndMetadataAreLocked() public {
        (address token,,,) = _launch(true, 0);
        bytes32 poolId = _poolId(token);
        address[3] memory callers = [launcher.owner(), creator, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IClankerV5Hook.NotSlotAdmin.selector);
            hook.updateFeeSlotRecipient(poolId, 0, stranger);
            vm.expectRevert(IClankerV5Hook.NotSlotAdmin.selector);
            hook.updateFeeSlotAdmin(poolId, 1, stranger);
            vm.expectRevert(IClankerV5Factory.NotCurrentCreator.selector);
            factory.updateTokenName(token, "x");
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
        ClankerV5.CreatorRights memory rights = factory.creatorRights(token);
        assertEq(rights.currentCreator, address(launcher), "creator rights belong to the launcher");
        assertEq(rights.originalCreator, address(launcher));
        assertFalse(rights.metadataEditable, "metadata frozen");
        assertEq(IClankerV5Token(token).metadataAuthority(), address(0), "no metadata authority at all");
    }

    // ------------------------------------------------------------------
    // Gate
    // ------------------------------------------------------------------

    function test_gateForwardsOnlyForAllowlistedLaunchers() public {
        assertEq(guardian.launcher(), address(gate));
        assertTrue(gate.launchers(address(launcher)));
        (, address kernel,,) = _launch(false, 0);
        assertTrue(guardian.isRegistered(kernel), "registered through the gate");
        vm.prank(address(launcher));
        vm.expectRevert(AgentGuardian.NotLauncher.selector);
        guardian.registerAgent(kernel, address(1), creator, DORMANCY);
        gate.removeLauncher(address(launcher));
        BootrClankerLauncherV5.LaunchParams memory p = _params(false, 0);
        p.salt = _mineSalt(creator, p, bytes32(uint256(8)));
        vm.prank(creator);
        vm.expectRevert(BootrLaunchGate.NotLauncher.selector);
        launcher.launch(p);
        gate.addLauncher(address(launcher));
        vm.prank(creator);
        launcher.launch(p);
    }

    // ------------------------------------------------------------------
    // Invariants
    // ------------------------------------------------------------------

    function _assertLaunchInvariants(
        address token,
        address kernel,
        address burner,
        uint256 agentId,
        bool buyback,
        uint24 tax
    ) internal view {
        // token: a v5 launch token, cccc suffix, fixed supply, frozen metadata with the three keys
        assertEq(uint160(token) & 0xffff, 0xcccc, "v5 token address suffix");
        assertTrue(factory.isLaunchToken(token));
        assertEq(IClankerV5Token(token).factory(), FACTORY);
        assertEq(IERC20(token).totalSupply(), TOTAL_SUPPLY);
        assertEq(IClankerV5Token(token).contractURI(), '{"description":"mainnet fork launch through Clanker v5"}');
        assertEq(IClankerV5Token(token).extraMetadata("image"), "https://bootr.fun/images/test.png");
        assertEq(IClankerV5Token(token).extraMetadata("context"), '{"interface":"Bootr","platform":"bootr.fun","id":"draft-5"}');
        assertEq(IClankerV5Token(token).metadataAuthority(), address(0));

        // pool: native quote (currency0), fee 0, tax both ways, burn share per preset, anti-snipe on
        bytes32 poolId = _poolId(token);
        IClankerV5Hook.PoolConfig memory cfg = _poolConfig(poolId);
        assertTrue(cfg.initialized, "pool registered on the hook");
        assertFalse(cfg.tokenIsCurrency0, "native ETH is currency0");
        assertEq(cfg.token, token);
        assertEq(cfg.quoteToken, NATIVE);
        assertEq(cfg.currentCreator, address(launcher));
        assertTrue(cfg.antiSnipeEnabled);
        assertEq(cfg.integratorFeeRecipient, address(0));
        assertEq(cfg.dividend, address(0));
        ClankerV5.TaxConfiguration memory t = cfg.taxConfiguration;
        assertEq(t.buyTaxRate, uint32(tax) * 100);
        assertEq(t.sellTaxRate, uint32(tax) * 100);
        assertEq(t.burnAllocationShare, buyback ? 15_000_000 : 0);
        assertEq(t.creatorAllocationShare, buyback ? 85_000_000 : 100_000_000);
        assertEq(t.dividendAllocationShare + t.integratorAllocationShare, 0);

        // fee slots: kernel / creator / platform, admin = launcher, weights per preset, no creator slot
        ClankerV5.FeeSlot[] memory slots = hook.poolFeeSlots(poolId);
        assertEq(slots.length, 3, "three paid slots; the burn is Clanker's share, not a slot");
        uint16[3] memory w = launcher.slotWeightsFor(buyback);
        assertEq(slots[0].recipient, kernel);
        assertEq(slots[1].recipient, creatorOf(kernel));
        assertEq(slots[2].recipient, platformRecipient);
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            assertEq(slots[i].admin, address(launcher), "slot admin is the launcher");
            assertFalse(slots[i].isCreator, "no factory-managed creator slot");
            assertEq(slots[i].weightBps, w[i]);
            sum += slots[i].weightBps;
        }
        assertEq(sum, 10_000);
        if (buyback) {
            assertEq(burner, DEAD);
            assertEq(slots[0].weightBps, 588);
            assertEq(slots[1].weightBps, 5883);
            assertEq(slots[2].weightBps, 3529);
        } else {
            assertEq(burner, address(0));
            assertEq(slots[0].weightBps, 500);
            assertEq(slots[1].weightBps, 6500);
            assertEq(slots[2].weightBps, 3000);
        }

        // kernel: root validator + hook = guardian, fuel inside
        assertEq(IKernel(kernel).rootValidator(), KernelLib.validatorId(address(guardian)), "root is the guardian");
        assertEq(IKernel(kernel).validationConfig(KernelLib.validatorId(address(guardian))).hook, address(guardian));
        assertEq(IKernel(kernel).entrypoint(), ENTRY_POINT);
        assertEq(IERC20(USDC).balanceOf(kernel), FUEL, "fuel in the kernel");

        // ERC-8004 identity owned by the kernel
        assertEq(IERC8004IdentityRegistry(IDENTITY).ownerOf(agentId), kernel, "identity owned by the kernel");
        assertEq(IERC8004IdentityRegistry(IDENTITY).tokenURI(agentId), "https://bootr.fun/agents/test.json");

        // guardian
        AgentGuardian.AgentInfo memory a = guardian.agentInfo(kernel);
        assertEq(a.token, token);
        assertEq(a.creator, creatorOf(kernel));
        assertEq(a.dormancyPeriod, DORMANCY);
        assertFalse(a.paused);
        // nothing stays in the launcher
        assertEq(address(launcher).balance, 0);
        assertEq(IERC20(token).balanceOf(address(launcher)), 0);
    }

    /// @dev The creator the guardian recorded for `kernel` (launches come from `creator` or the treasury).
    function creatorOf(address kernel) internal view returns (address) {
        return guardian.agentInfo(kernel).creator;
    }
}
