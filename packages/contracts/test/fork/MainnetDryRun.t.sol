// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrCallPolicy} from "../../src/BootrCallPolicy.sol";
import {BootrLauncher} from "../../src/BootrLauncher.sol";
import {BootrSwapHelper} from "../../src/BootrSwapHelper.sol";
import {BuybackBurner} from "../../src/BuybackBurner.sol";
import {
    IClanker,
    IClankerFeeLocker,
    IClankerHookStaticFee,
    IClankerHookV2,
    IClankerLpLocker,
    IClankerLpLockerFeeConversion,
    IClankerToken
} from "../../src/interfaces/IClanker.sol";
import {IERC8004IdentityRegistry} from "../../src/interfaces/IERC8004IdentityRegistry.sol";
import {IEntryPoint, IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";
import {IWETH9, PoolKey, V4Constants} from "../../src/interfaces/IUniswapV4.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeploySwapHelper} from "../../script/DeploySwapHelper.s.sol";

/// @notice Base MAINNET fork dry-run of the cutover: deploys the full Bootr stack with the exact chain
///         configuration of `script/Deploy.s.sol` / `script/DeploySwapHelper.s.sol`, launches through the
///         live Clanker v4 (locker, hook, dev-buy extension, MEV module), installs the supervisor's production
///         session permission through the guardian's enable path on the live EntryPoint / Kernel v3.1 modules,
///         funds the agent's spender through a self-bundled (sponsored-style) `handleOps`, and swaps WETH -> USDC
///         through the real SwapRouter02 WETH/USDC 0.05% pool with a 1% slippage bound.
///
///         Opt-in only, so the default `forge test` stays fast and offline-safe:
///           MAINNET_FORK=1 forge test --match-contract MainnetDryRun -vvv
///         or set `BASE_RPC_URL` (archive not needed). Without either, every test is reported as skipped.
contract MainnetDryRunTest is Test {
    // --- Base mainnet (8453) - packages/shared/src/addresses.ts, verified on-chain 2026-10-27 ---
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    // ZeroDev permission modules (same addresses on every chain; bytecode present on 8453)
    address constant ECDSA_SIGNER = 0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF;
    address constant GAS_POLICY = 0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23;
    address constant RATE_LIMIT_POLICY = 0xf63d4139B25c836334edD76641356c6b74C86873;
    address constant TIMESTAMP_POLICY = 0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F;
    // Uniswap v3 WETH/USDC 0.05% pool behind SwapRouter02 (factory.getPool(WETH, USDC, 500))
    address constant WETH_USDC_V3_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bytes4 constant PID = bytes4(keccak256("bootr.session.mainnet-dry-run"));
    bytes2 constant FOR_ALL_VALIDATION = 0x0000;
    bytes2 constant NOT_FOR_VALIDATE_SIG = 0x0002;
    uint8 constant CALL_POLICY_INDEX = 0;

    uint256 constant FUEL = 20e6; // the 20 USDC fuel of the runbook
    uint256 constant DEV_BUY = 0.01 ether;
    uint256 constant USDC_CAP = 50e6;
    uint32 constant FUND_WINDOW = 1 days;
    uint32 constant DORMANCY = 90 days;
    uint16 constant SLIPPAGE_BPS = 100; // the runbook's 1% bound (SWAP_SLIPPAGE_BPS default)

    bool enabled;
    Deploy.ChainDeps deps;
    DeploySwapHelper.ChainDeps swapDeps;

    AgentGuardian guardian;
    BuybackBurner burnerImpl;
    BootrLauncher launcher;
    BootrCallPolicy callPolicy;
    BootrSwapHelper swapHelper;
    IEntryPoint entryPoint = IEntryPoint(ENTRY_POINT);

    address platformRecipient = makeAddr("platformRecipient");
    address treasury = makeAddr("treasury");
    address admin = makeAddr("platformAdmin"); // guardian owner + self-bundler (ENABLE_MODE_SELF_BUNDLE)
    address spender = makeAddr("agentSpender");
    address thirdParty = makeAddr("thirdParty");
    uint256 sessionPk = 0xA11CE;
    address sessionKey = vm.addr(sessionPk);
    uint256 creatorPk = 0xC0FFEE;
    address creator = vm.addr(creatorPk);

    modifier onFork() {
        vm.skip(!enabled);
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        enabled = vm.envOr("MAINNET_FORK", false) || bytes(rpc).length > 0;
        if (!enabled) return;
        vm.createSelectFork(bytes(rpc).length > 0 ? rpc : "https://mainnet.base.org");
        require(block.chainid == 8453, "not a Base mainnet fork");

        // The scripts' own chain configuration (what `forge script` will broadcast).
        deps = new Deploy().chainConfig();
        swapDeps = new DeploySwapHelper().chainConfig();

        // script/Deploy.s.sol, minus the broadcast; the admin is a separate EOA as on mainnet.
        guardian = new AgentGuardian(admin, ENTRY_POINT, deps.usdc, deps.weth);
        burnerImpl = new BuybackBurner();
        launcher = new BootrLauncher(
            admin,
            BootrLauncher.Deps({
                clanker: deps.clanker,
                feeLocker: deps.feeLocker,
                lpLocker: deps.lpLockerFeeConversion,
                staticHook: deps.hookStaticFeeV2,
                devBuyExtension: deps.devBuy,
                mevModule: deps.mevBlockDelay,
                weth: deps.weth,
                usdc: deps.usdc,
                identityRegistry: deps.identity,
                kernelFactory: deps.kernelFactory,
                guardian: address(guardian),
                burnerImplementation: address(burnerImpl),
                universalRouter: deps.universalRouter,
                permit2: deps.permit2
            }),
            _defaults(false),
            _defaults(true),
            1000
        );
        vm.startPrank(admin);
        guardian.setLauncher(address(launcher));
        guardian.setPlatformTreasury(treasury);
        vm.stopPrank();
        // script/DeployCallPolicy.s.sol + script/DeploySwapHelper.s.sol (SWAP_POOL_FEE default 500)
        callPolicy = new BootrCallPolicy();
        swapHelper =
            new BootrSwapHelper(swapDeps.weth, swapDeps.usdc, swapDeps.swapRouter02, swapDeps.ethUsdFeed, 500);

        deal(deps.usdc, creator, 1_000e6);
        vm.deal(creator, 1 ether);
        vm.deal(admin, 1 ether);
        vm.prank(creator);
        IERC20(deps.usdc).approve(address(launcher), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Address book sanity (what the scripts will bake into immutables)
    // ------------------------------------------------------------------

    function test_mainnetAddressBookIsLive() public onFork {
        IClanker clanker = IClanker(deps.clanker);
        assertFalse(clanker.deprecated(), "Clanker factory deprecated");
        assertTrue(
            clanker.enabledLockers(deps.lpLockerFeeConversion, deps.hookStaticFeeV2),
            "LP locker not enabled for the static V2 hook"
        );
        assertEq(IKernelFactoryView(deps.kernelFactory).implementation(), 0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D);
        (, string memory name, string memory version,,,,) =
            IKernel(0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D).eip712Domain();
        assertEq(name, "Kernel");
        assertEq(version, "0.3.1");
        assertEq(ISwapRouter02View(swapDeps.swapRouter02).WETH9(), deps.weth);
        assertEq(IERC20Metadata(deps.usdc).decimals(), 6);
        assertEq(IERC8004Name(deps.identity).name(), "AgentIdentity");
        uint256 price = swapHelper.ethUsdPrice();
        assertGt(price, 100e8, "Chainlink ETH/USD live");
        for (uint256 i; i < 4; ++i) {
            address m = [ECDSA_SIGNER, GAS_POLICY, RATE_LIMIT_POLICY, TIMESTAMP_POLICY][i];
            assertGt(m.code.length, 0, "ZeroDev module missing on 8453");
        }
    }

    // ------------------------------------------------------------------
    // Launch through the live Clanker v4 (0.01 ETH dev buy, 20 USDC fuel)
    // ------------------------------------------------------------------

    function test_launchStandardPreset() public onFork {
        uint256 ethBefore = creator.balance;
        (address token, address kernel, address burner, uint256 agentId) = _launch(false, bytes32(uint256(1)));
        assertEq(burner, address(0));
        _assertLaunchInvariants(token, kernel, burner, agentId, false);
        assertGt(IERC20(token).balanceOf(creator), 0, "dev buy delivered to the creator");
        assertEq(ethBefore - creator.balance, DEV_BUY, "exactly the dev buy was spent");

        // the dev buy is a swap: after the MEV window its LP fee is collectable in the runbook's 5 / 65 / 30 split
        _passMevWindow();
        IClankerLpLocker(deps.lpLockerFeeConversion).collectRewards(token);
        uint256 fKernel = IClankerFeeLocker(deps.feeLocker).availableFees(kernel, deps.weth);
        uint256 fCreator = IClankerFeeLocker(deps.feeLocker).availableFees(creator, deps.weth);
        uint256 fPlatform = IClankerFeeLocker(deps.feeLocker).availableFees(platformRecipient, deps.weth);
        uint256 lpTotal = fKernel + fCreator + fPlatform;
        assertGt(lpTotal, 0, "dev buy accrued LP fees");
        assertApproxEqAbs(fKernel, lpTotal * 500 / 10_000, 2);
        assertApproxEqAbs(fCreator, lpTotal * 6500 / 10_000, 2);
        assertApproxEqAbs(fPlatform, lpTotal * 3000 / 10_000, 2);
        IClankerFeeLocker(deps.feeLocker).claim(kernel, deps.weth);
        assertEq(IERC20(deps.weth).balanceOf(kernel), fKernel, "kernel claimed its WETH share");
    }

    function test_launchBuybackPreset() public onFork {
        (address token, address kernel, address burner, uint256 agentId) = _launch(true, bytes32(uint256(2)));
        assertTrue(burner != address(0));
        assertEq(burner, launcher.predictBurner(creator, bytes32(uint256(2))));
        _assertLaunchInvariants(token, kernel, burner, agentId, true);
        BuybackBurner b = BuybackBurner(burner);
        assertEq(address(b.token()), token);
        assertEq(b.keeper(), admin, "launcher owner (admin) is the burner keeper");

        // the locker converts the burner's WETH share into the coin; burn() sends it to 0x...dEaD
        _passMevWindow();
        IClankerLpLocker(deps.lpLockerFeeConversion).collectRewards(token);
        uint256 fBurnerToken = IClankerFeeLocker(deps.feeLocker).availableFees(burner, token);
        assertEq(IClankerFeeLocker(deps.feeLocker).availableFees(burner, deps.weth), 0, "burner share converted");
        assertGt(fBurnerToken, 0, "burner receives the coin");
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        assertEq(b.burn(), fBurnerToken);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, fBurnerToken);
    }

    // ------------------------------------------------------------------
    // Production session permission (enable path) + sponsored-style funding of the spender
    // ------------------------------------------------------------------

    function test_productionSessionInstallsAndFundsSpenderWithinWindow() public onFork {
        (, address kernel,,) = _launch(false, bytes32(uint256(3)));
        uint256 t0 = vm.getBlockTimestamp();
        _installProductionSession(kernel);

        bytes21 vId = KernelLib.permissionId(PID);
        assertEq(IKernel(kernel).validationConfig(vId).hook, address(guardian), "permission hook is the guardian");
        assertTrue(IKernel(kernel).isAllowedSelector(vId, IKernel.execute.selector));
        assertTrue(callPolicy.installed(bytes32(PID), kernel));
        assertEq(callPolicy.rulesOf(bytes32(PID), kernel).length, 4);
        assertEq(guardian.agentInfo(kernel).lastActivity, t0, "activity stamped by the hook");
        assertEq(IERC20(deps.usdc).balanceOf(kernel), FUEL, "the no-op moved nothing");

        // regular op, 1 USDC to the agent's spender inside the funding window (BootrCallPolicy time slot)
        vm.warp(t0 + 1 hours);
        PackedUserOperation memory op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), deps.usdc, abi.encodeCall(IERC20.transfer, (spender, 1e6))
        );
        op.signature = _signSessionAt(op, vm.getBlockTimestamp());
        assertTrue(_handleSponsored(kernel, op), "funding op executed");
        assertEq(IERC20(deps.usdc).balanceOf(spender), 1e6);
        assertEq(IERC20(deps.usdc).balanceOf(kernel), FUEL - 1e6);
        assertEq(guardian.agentInfo(kernel).lastActivity, t0 + 1 hours);

        // any other USDC recipient is rejected at validation by BootrCallPolicy (policy index 0)
        op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), deps.usdc, abi.encodeCall(IERC20.transfer, (thirdParty, 1e6))
        );
        op.signature = _signSessionAt(op, vm.getBlockTimestamp());
        _prefund(kernel);
        _expectPolicyFailed(0);
        _sendSponsored(op);
        // and so is a single transfer above the per-window cap
        op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), deps.usdc, abi.encodeCall(IERC20.transfer, (spender, USDC_CAP))
        );
        op.signature = _signSessionAt(op, vm.getBlockTimestamp());
        _expectPolicyFailed(0);
        _sendSponsored(op);
        assertEq(IERC20(deps.usdc).balanceOf(kernel), FUEL - 1e6, "nothing else left the kernel");
    }

    // ------------------------------------------------------------------
    // BootrSwapHelper against the real WETH/USDC 0.05% pool, 1% slippage bound
    // ------------------------------------------------------------------

    function test_swapHelperDirectAgainstMainnetPool() public onFork {
        assertGt(IERC20(deps.weth).balanceOf(WETH_USDC_V3_POOL), 100 ether, "pool is deep");
        vm.deal(address(this), 1 ether);
        IWETH9(deps.weth).deposit{value: 0.01 ether}();
        IWETH9(deps.weth).approve(address(swapHelper), 0.01 ether);
        uint256 price = swapHelper.ethUsdPrice();
        uint256 floor = swapHelper.minUsdcOut(0.01 ether, SLIPPAGE_BPS);
        assertEq(floor, (0.01 ether * price * (10_000 - SLIPPAGE_BPS)) / (10_000 * 1e20));
        // deltas: the default test address already holds USDC dust on mainnet
        uint256 usdcBefore = IERC20(deps.usdc).balanceOf(address(this));
        uint256 wethBefore = IERC20(deps.weth).balanceOf(address(this));
        uint256 out = swapHelper.swapWethToUsdc(0.01 ether, SLIPPAGE_BPS);
        assertGe(out, floor, "pool price within 1% of Chainlink");
        assertLe(out, (0.01 ether * price * 10_100) / (10_000 * 1e20), "output not above Chainlink + 1%");
        assertEq(IERC20(deps.usdc).balanceOf(address(this)) - usdcBefore, out);
        assertEq(wethBefore - IERC20(deps.weth).balanceOf(address(this)), 0.01 ether);
        assertEq(IERC20(deps.weth).balanceOf(address(swapHelper)), 0);
        assertEq(IERC20(deps.usdc).balanceOf(address(swapHelper)), 0);
        // the contract's slippage cap holds on mainnet too
        IWETH9(deps.weth).deposit{value: 0.001 ether}();
        IWETH9(deps.weth).approve(address(swapHelper), 0.001 ether);
        vm.expectRevert(abi.encodeWithSelector(BootrSwapHelper.SlippageTooHigh.selector, 301, 300));
        swapHelper.swapWethToUsdc(0.001 ether, 301);
    }

    function test_sessionKeySwapsKernelWethIntoKernelUsdc() public onFork {
        (, address kernel,,) = _launch(false, bytes32(uint256(4)));
        _installProductionSession(kernel);
        vm.deal(address(this), 1 ether);
        IWETH9(deps.weth).deposit{value: 0.01 ether}();
        IWETH9(deps.weth).transfer(kernel, 0.01 ether);

        PackedUserOperation memory op = _userOp(
            kernel,
            _permissionNonce(kernel, 0x00),
            deps.weth,
            abi.encodeCall(IERC20.approve, (address(swapHelper), type(uint256).max))
        );
        op.signature = _signSessionAt(op, vm.getBlockTimestamp());
        assertTrue(_handleSponsored(kernel, op), "approve executed");

        uint256 floor = swapHelper.minUsdcOut(0.01 ether, SLIPPAGE_BPS);
        uint256 usdcBefore = IERC20(deps.usdc).balanceOf(kernel);
        op = _userOp(
            kernel,
            _permissionNonce(kernel, 0x00),
            address(swapHelper),
            abi.encodeCall(BootrSwapHelper.swapWethToUsdc, (0.01 ether, SLIPPAGE_BPS))
        );
        op.signature = _signSessionAt(op, vm.getBlockTimestamp());
        assertTrue(_handleSponsored(kernel, op), "swap executed");
        assertGe(IERC20(deps.usdc).balanceOf(kernel) - usdcBefore, floor, "kernel received at least the floor");
        assertEq(IERC20(deps.weth).balanceOf(kernel), 0);

        // the approval is useless to anyone else: the helper pulls from msg.sender only
        vm.prank(thirdParty);
        vm.expectRevert();
        swapHelper.swapWethToUsdc(1, SLIPPAGE_BPS);
    }

    // ------------------------------------------------------------------
    // Fixture
    // ------------------------------------------------------------------

    /// @dev The presets `script/Deploy.s.sol` deploys (5 / 65 / 30 and 5 / 50 / 15 / 30, 1% LP fee).
    function _defaults(bool buyback) internal view returns (BootrLauncher.LaunchDefaults memory) {
        return BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: buyback ? 5000 : 6500,
            burnBps: buyback ? 1500 : 0,
            platformBps: 3000,
            platformRecipient: platformRecipient,
            minFuelUsdc: FUEL,
            dormancyPeriod: DORMANCY
        });
    }

    function _launch(bool buyback, bytes32 salt)
        internal
        returns (address token, address kernel, address burner, uint256 agentId)
    {
        BootrLauncher.LaunchParams memory p = BootrLauncher.LaunchParams({
            name: "Bootr Dry Run",
            symbol: "DRYRUN",
            image: "ipfs://image",
            metadata: '{"description":"mainnet fork dry run"}',
            context: '{"interface":"Bootr","platform":"bootr.fun"}',
            salt: salt,
            buybackBurn: buyback,
            fuelUsdc: FUEL,
            devBuyWei: DEV_BUY,
            workerHash: keccak256("worker"),
            model: "claude-sonnet-4-5",
            agentURI: "https://bootr.fun/agents/dry-run.json",
            supervisorSessionKey: sessionKey
        });
        vm.prank(creator);
        (token, kernel, burner, agentId) = launcher.launch{value: DEV_BUY}(p);
    }

    /// @dev Lets the MEV block-delay module expire so fee collection works.
    function _passMevWindow() internal {
        vm.warp(vm.getBlockTimestamp() + 3 minutes);
        vm.roll(block.number + 5);
    }

    function _assertLaunchInvariants(address token, address kernel, address burner, uint256 agentId, bool buyback)
        internal
        view
    {
        // token
        assertEq(IClankerToken(token).admin(), address(launcher), "tokenAdmin is the launcher");
        assertEq(IERC20(token).totalSupply(), 100_000_000_000e18);
        IClanker.DeploymentInfo memory info = IClanker(deps.clanker).tokenDeploymentInfo(token);
        assertEq(info.hook, deps.hookStaticFeeV2);
        assertEq(info.locker, deps.lpLockerFeeConversion);
        assertEq(info.extensions.length, 1, "dev-buy extension");
        assertEq(info.extensions[0], deps.devBuy);

        // pool
        PoolKey memory key = launcher.poolKeyFor(token);
        bytes32 poolId = V4Constants.poolId(key);
        assertEq(IClankerHookStaticFee(deps.hookStaticFeeV2).clankerFee(poolId), 10_000);
        assertEq(IClankerHookStaticFee(deps.hookStaticFeeV2).pairedFee(poolId), 10_000);
        assertEq(IClankerHookV2(deps.hookStaticFeeV2).locker(poolId), deps.lpLockerFeeConversion);

        // rewards in the mainnet LP locker: slots, bps, admins, fee preferences
        IClankerLpLocker.TokenRewardInfo memory r = IClankerLpLocker(deps.lpLockerFeeConversion).tokenRewards(token);
        uint256 n = buyback ? 4 : 3;
        assertEq(r.rewardAdmins.length, n);
        assertEq(r.rewardRecipients.length, n);
        assertEq(r.rewardBps.length, n);
        assertEq(r.numPositions, 1);
        assertEq(
            V4Constants.poolId(
                PoolKey(r.poolKey.currency0, r.poolKey.currency1, r.poolKey.fee, r.poolKey.tickSpacing, r.poolKey.hooks)
            ),
            poolId
        );
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            assertEq(r.rewardAdmins[i], address(launcher), "rewardAdmin is the launcher");
            sum += r.rewardBps[i];
        }
        assertEq(sum, 10_000);
        assertEq(r.rewardRecipients[0], kernel);
        assertEq(r.rewardBps[0], 500);
        assertEq(r.rewardRecipients[1], creator);
        assertEq(r.rewardBps[1], buyback ? 5000 : 6500);
        if (buyback) {
            assertEq(r.rewardRecipients[2], burner);
            assertEq(r.rewardBps[2], 1500);
            assertEq(
                uint8(IClankerLpLockerFeeConversion(deps.lpLockerFeeConversion).feePreferences(token, 2)),
                uint8(IClankerLpLockerFeeConversion.FeeIn.Clanker)
            );
        }
        assertEq(r.rewardRecipients[n - 1], platformRecipient);
        assertEq(r.rewardBps[n - 1], 3000);
        assertEq(
            uint8(IClankerLpLockerFeeConversion(deps.lpLockerFeeConversion).feePreferences(token, 0)),
            uint8(IClankerLpLockerFeeConversion.FeeIn.Both)
        );

        // kernel: root validator + hook = guardian, fuel inside
        assertEq(IKernel(kernel).rootValidator(), KernelLib.validatorId(address(guardian)), "root is the guardian");
        assertEq(IKernel(kernel).validationConfig(KernelLib.validatorId(address(guardian))).hook, address(guardian));
        assertEq(IKernel(kernel).entrypoint(), ENTRY_POINT);
        assertEq(IERC20(deps.usdc).balanceOf(kernel), FUEL, "20 USDC fuel in the kernel");
        (, string memory name, string memory version,, address verifying,,) = IKernel(kernel).eip712Domain();
        assertEq(name, "Kernel");
        assertEq(version, "0.3.1");
        assertEq(verifying, kernel);

        // ERC-8004 identity owned by the kernel
        assertEq(IERC8004IdentityRegistry(deps.identity).ownerOf(agentId), kernel, "identity owned by the kernel");
        assertEq(IERC8004IdentityRegistry(deps.identity).tokenURI(agentId), "https://bootr.fun/agents/dry-run.json");

        // guardian
        AgentGuardian.AgentInfo memory a = guardian.agentInfo(kernel);
        assertEq(a.token, token);
        assertEq(a.creator, creator);
        assertEq(a.dormancyPeriod, DORMANCY);
        assertFalse(a.paused);
    }

    // ------------------------------------------------------------------
    // Session plumbing (mirrors apps/supervisor/src/session-key.ts and test/security/SecurityForkBase.sol)
    // ------------------------------------------------------------------

    /// @dev The four production rules of `callPolicyRules`: FeeLocker.claim(kernel, *), WETH.approve(helper, *),
    ///      helper.swapWethToUsdc(*, *), USDC.transfer(spender, SUM_PER_WINDOW <= cap per window).
    function _productionRules(address kernel) internal view returns (BootrCallPolicy.Rule[] memory rules) {
        rules = new BootrCallPolicy.Rule[](4);
        rules[0].target = deps.feeLocker;
        rules[0].selector = IClankerFeeLocker.claim.selector;
        rules[0].args = new BootrCallPolicy.ArgRule[](1);
        rules[0].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(kernel))));
        rules[1].target = deps.weth;
        rules[1].selector = IERC20.approve.selector;
        rules[1].args = new BootrCallPolicy.ArgRule[](1);
        rules[1].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(address(swapHelper)))));
        rules[2].target = address(swapHelper);
        rules[2].selector = BootrSwapHelper.swapWethToUsdc.selector;
        rules[2].args = new BootrCallPolicy.ArgRule[](0);
        rules[3].target = deps.usdc;
        rules[3].selector = IERC20.transfer.selector;
        rules[3].windowSeconds = FUND_WINDOW;
        rules[3].args = new BootrCallPolicy.ArgRule[](2);
        rules[3].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(spender))));
        rules[3].args[1] = BootrCallPolicy.ArgRule(1, 3, bytes32(USDC_CAP));
    }

    /// @dev The production layout (`policyEntries`): BootrCallPolicy, GasPolicy, RateLimitPolicy (NOT_FOR_VALIDATE_SIG),
    ///      TimestampPolicy, ECDSASigner flagged SKIP_SIGNATURE (no ERC-1271 path).
    function _productionPermissionData(address kernel) internal view returns (bytes memory) {
        bytes[] memory enableData = new bytes[](5);
        enableData[0] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, address(callPolicy), abi.encode(_productionRules(kernel)));
        enableData[1] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, GAS_POLICY, abi.encode(uint128(1e17), false, address(0)));
        enableData[2] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, RATE_LIMIT_POLICY, uint48(3600), uint48(60), uint48(0));
        enableData[3] = abi.encodePacked(
            FOR_ALL_VALIDATION, TIMESTAMP_POLICY, abi.encode(uint48(0), uint48(vm.getBlockTimestamp() + 30 days))
        );
        enableData[4] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, ECDSA_SIGNER, sessionKey);
        return abi.encode(enableData);
    }

    function _permissionNonce(address kernel, bytes1 mode) internal view returns (uint256) {
        uint192 key = (uint192(uint8(mode)) << 184) | (uint192(0x02) << 176)
            | (uint192(uint160(bytes20(abi.encodePacked(PID, bytes16(0))))) << 16);
        return entryPoint.getNonce(kernel, key);
    }

    function _userOp(address kernel, uint256 nonce, address target, bytes memory data)
        internal
        pure
        returns (PackedUserOperation memory op)
    {
        bytes memory inner =
            abi.encodeCall(IKernel.execute, (KernelLib.EXEC_MODE_SINGLE, KernelLib.encodeSingle(target, 0, data)));
        op = PackedUserOperation({
            sender: kernel,
            nonce: nonce,
            initCode: "",
            callData: abi.encodePacked(IKernel.executeUserOp.selector, inner),
            accountGasLimits: bytes32((uint256(3_000_000) << 128) | 1_000_000),
            preVerificationGas: 200_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | 1 gwei),
            paymasterAndData: "",
            signature: ""
        });
    }

    /// @dev `[0 ‖ uint64(32) ‖ abi.encode(now)] ‖ 0xff ‖ sig`: the supervisor's regular session signature
    ///      (BootrCallPolicy's time slot for the SUM_PER_WINDOW rule).
    function _signSessionAt(PackedUserOperation memory op, uint256 claimedNow) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, entryPoint.getUserOpHash(op));
        return abi.encodePacked(CALL_POLICY_INDEX, uint64(32), abi.encode(claimedNow), bytes1(0xff), r, s, v);
    }

    /// @dev Sponsored-style inclusion: the kernel holds no ETH; the admin tops up its EntryPoint deposit
    ///      (ENABLE_MODE_MAX_PREFUND_WEI) and calls `handleOps` itself as the beneficiary (ENABLE_MODE_SELF_BUNDLE).
    function _prefund(address kernel) internal {
        uint256 prefund = 0.005 ether;
        if (entryPoint.balanceOf(kernel) < prefund) {
            vm.prank(admin);
            entryPoint.depositTo{value: prefund}(kernel);
        }
    }

    /// @dev Only the `handleOps` call, so a preceding `vm.expectRevert` applies to it (prefund separately).
    function _sendSponsored(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(admin);
        entryPoint.handleOps(ops, payable(admin));
    }

    function _handleSponsored(address kernel, PackedUserOperation memory op) internal returns (bool success) {
        _prefund(kernel);
        vm.recordLogs();
        _sendSponsored(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    /// @dev EntryPoint v0.7 wraps a reverting `validateUserOp` as `FailedOpWithRevert(0, "AA23 reverted", inner)`;
    ///      the Kernel's inner revert for a policy returning 1 is `PolicyFailed(policyIndex)`.
    function _expectPolicyFailed(uint256 policyIndex) internal {
        vm.expectRevert(
            abi.encodeWithSignature(
                "FailedOpWithRevert(uint256,string,bytes)",
                0,
                "AA23 reverted",
                abi.encodeWithSignature("PolicyFailed(uint256)", policyIndex)
            )
        );
    }

    /// @dev Admin approves the enable digest, then the first userOp installs the permission in enable mode and
    ///      runs an allow-listed no-op (`USDC.transfer(spender, 0)`), exactly as `installSessionKey` does.
    function _installProductionSession(address kernel) internal {
        bytes memory validatorData = _productionPermissionData(kernel);
        vm.prank(admin);
        guardian.approveSessionKey(kernel, PID, validatorData);
        PackedUserOperation memory op = _userOp(
            kernel, _permissionNonce(kernel, 0x01), deps.usdc, abi.encodeCall(IERC20.transfer, (spender, 0))
        );
        bytes memory userOpSig = _signSessionAt(op, vm.getBlockTimestamp());
        op.signature = abi.encodePacked(
            address(guardian),
            abi.encode(validatorData, hex"00", abi.encodePacked(IKernel.execute.selector), bytes(""), userOpSig)
        );
        assertTrue(_handleSponsored(kernel, op), "enable userOp executed");
    }
}

interface IKernelFactoryView {
    function implementation() external view returns (address);
}

interface ISwapRouter02View {
    function WETH9() external view returns (address);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

interface IERC8004Name {
    function name() external view returns (string memory);
}
