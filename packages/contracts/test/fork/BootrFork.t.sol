// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrCallPolicy} from "../../src/BootrCallPolicy.sol";
import {BootrLaunchGate} from "../../src/BootrLaunchGate.sol";
import {BootrLauncher} from "../../src/BootrLauncher.sol";
import {BootrSwapHelper} from "../../src/BootrSwapHelper.sol";
import {BuybackBurner} from "../../src/BuybackBurner.sol";
import {IRwagmiB20LauncherV3, IRwagmiHookV3, IRwagmiLpLockerV3} from "../../src/interfaces/IRwagmi.sol";
import {IERC8004IdentityRegistry} from "../../src/interfaces/IERC8004IdentityRegistry.sol";
import {Execution, IEntryPoint, IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";
import {IPermit2, IUniversalRouter, IV4Router, IWETH9, PoolKey, V4Constants} from "../../src/interfaces/IUniswapV4.sol";

/// @notice Fork tests against Base MAINNET (live RWAGMI v3 launcher stack, Kernel v3.1, EntryPoint v0.7,
///         ERC-8004). RWAGMI v3 has no testnet deployment, so this is the launch test suite.
///         RPC: `BASE_RPC_URL` env or https://mainnet.base.org (no archive state needed).
contract BootrForkTest is Test {
    // --- Base mainnet (docs/rwagmi-migration.md, packages/shared/src/addresses.ts) ---
    address constant RWAGMI_LAUNCHER = 0xB205c9e7B43ca3a4aA99b82D449354CCB3294B20;
    address constant RWAGMI_LOCKER = 0xB205CE7CC26C35ed5E1f9655FF9d0115af4a1B20;
    address constant RWAGMI_HOOK = 0xB20B00367E37F826a0652c85a6DF375D784B20Ec;
    address constant RWAGMI_DEV_BUY = 0xb20A2dCBC4AA42474072381aEb52CbFc5C751B20;
    address constant B20_FACTORY = 0xB20f000000000000000000000000000000000000;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant KERNEL_FACTORY = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant SUDO_POLICY = 0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7;
    address constant ECDSA_SIGNER = 0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address constant SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant ETH_USD_FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    uint256 constant TOTAL_SUPPLY = 100_000_000_000e18;

    AgentGuardian guardian;
    BootrLaunchGate gate;
    BuybackBurner burnerImpl;
    BootrLauncher launcher;
    BootrCallPolicy callPolicy;
    BootrSwapHelper swapHelper;
    IEntryPoint entryPoint = IEntryPoint(ENTRY_POINT);

    // Labels are namespaced: generic labels (and vm.addr(0xC0FFEE)) resolve to contracts on mainnet that forward ETH.
    address platformRecipient = makeAddr("bootr.fork.platformRecipient");
    address treasury = makeAddr("bootr.fork.treasury");
    address creator = makeAddr("bootr.fork.creator");
    address bundler = makeAddr("bootr.fork.bundler");
    address trader = makeAddr("bootr.fork.trader");
    address payTo = makeAddr("bootr.fork.inferencePayTo");
    uint256 sessionPk = 0xA11CE;
    address sessionKey = vm.addr(sessionPk);
    uint256 creatorPk = uint256(keccak256("bootr.fork.creator.pk"));

    uint256 constant FUEL = 100e6;
    uint32 constant DORMANCY = 90 days;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        require(block.chainid == 8453, "not a Base mainnet fork");
        creator = vm.addr(creatorPk);

        guardian = new AgentGuardian(address(this), ENTRY_POINT, USDC, WETH);
        gate = new BootrLaunchGate(address(this), address(guardian));
        burnerImpl = new BuybackBurner();
        callPolicy = new BootrCallPolicy();
        swapHelper = new BootrSwapHelper(WETH, USDC, SWAP_ROUTER_02, ETH_USD_FEED, 500);
        launcher = new BootrLauncher(
            address(this),
            BootrLauncher.Deps({
                rwagmiLauncher: RWAGMI_LAUNCHER,
                rwagmiLocker: RWAGMI_LOCKER,
                rwagmiHook: RWAGMI_HOOK,
                rwagmiDevBuy: RWAGMI_DEV_BUY,
                b20Factory: B20_FACTORY,
                weth: WETH,
                usdc: USDC,
                identityRegistry: IDENTITY,
                kernelFactory: KERNEL_FACTORY,
                guardian: address(guardian),
                gate: address(gate),
                burnerImplementation: address(burnerImpl),
                universalRouter: UNIVERSAL_ROUTER,
                permit2: PERMIT2
            }),
            _defaults(false),
            _defaults(true),
            1000
        );
        guardian.setLauncher(address(gate));
        gate.addLauncher(address(launcher));
        guardian.setPlatformTreasury(treasury);

        deal(USDC, creator, 10_000e6);
        vm.deal(creator, 100 ether);
        vm.prank(creator);
        IERC20(USDC).approve(address(launcher), type(uint256).max);
    }

    function _defaults(bool buyback) internal view returns (BootrLauncher.LaunchDefaults memory) {
        return BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 500,
            creatorBps: buyback ? 5000 : 6500,
            burnBps: buyback ? 1500 : 0,
            platformBps: 3000,
            platformRecipient: platformRecipient,
            minFuelUsdc: 25e6,
            dormancyPeriod: DORMANCY
        });
    }

    function _params(bool buyback, uint256 devBuyWei, bytes32 salt)
        internal
        view
        returns (BootrLauncher.LaunchParams memory p)
    {
        p = BootrLauncher.LaunchParams({
            name: "Bootr Agent",
            symbol: "BOOTR",
            image: "ipfs://image",
            metadata: "https://bootr.example/tokens/test.json",
            context: '{"interface":"bootr"}',
            salt: salt,
            buybackBurn: buyback,
            fuelUsdc: FUEL,
            devBuyWei: devBuyWei,
            workerHash: keccak256("worker"),
            model: "claude-sonnet-4-5",
            agentURI: "https://bootr.example/agent.json",
            supervisorSessionKey: sessionKey
        });
    }

    function _launch(bool buyback, uint256 devBuyWei)
        internal
        returns (address token, address kernel, address burner, uint256 agentId)
    {
        vm.prank(creator);
        (token, kernel, burner, agentId) =
            launcher.launch{value: devBuyWei}(_params(buyback, devBuyWei, bytes32(uint256(7))));
    }

    /// @dev RWAGMI v3 has no launch auction or MEV delay; kept so tests still move a little time forward.
    function _passMevWindow() internal {
        vm.warp(vm.getBlockTimestamp() + 3 minutes);
        vm.roll(block.number + 5);
    }

    function _poolId(address token) internal view returns (bytes32) {
        return V4Constants.poolId(launcher.poolKeyFor(token));
    }

    /// @dev Pool fees taken by the hook, not yet settled into `who`'s balance, plus what is already claimable.
    function _claimable(address token, address who) internal view returns (uint256) {
        return IRwagmiLpLockerV3(RWAGMI_LOCKER).pendingQuote(_poolId(token), who)
            + IRwagmiLpLockerV3(RWAGMI_LOCKER).claimableQuote(who, WETH);
    }

    /// @dev Exact-input WETH -> coin swap through the Universal Router (what traders and the burner do).
    function _buy(address token, uint256 wethIn) internal {
        PoolKey memory key = launcher.poolKeyFor(token);
        vm.deal(trader, wethIn + 1 ether);
        vm.startPrank(trader);
        IWETH9(WETH).deposit{value: wethIn}();
        IWETH9(WETH).approve(PERMIT2, wethIn);
        IPermit2(PERMIT2).approve(WETH, UNIVERSAL_ROUTER, uint160(wethIn), uint48(block.timestamp + 1 hours));
        bytes memory actions = abi.encodePacked(
            V4Constants.ACTION_SWAP_EXACT_IN_SINGLE, V4Constants.ACTION_SETTLE_ALL, V4Constants.ACTION_TAKE_ALL
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputSingleParams({
                poolKey: key,
                zeroForOne: key.currency0 == WETH,
                amountIn: uint128(wethIn),
                amountOutMinimum: 1,
                hookData: ""
            })
        );
        params[1] = abi.encode(WETH, wethIn);
        params[2] = abi.encode(token, uint256(1));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        IUniversalRouter(UNIVERSAL_ROUTER)
            .execute(abi.encodePacked(V4Constants.CMD_V4_SWAP), inputs, block.timestamp);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Launch
    // ------------------------------------------------------------------

    function test_launchStandardNoDevBuy() public {
        (address token, address kernel, address burner, uint256 agentId) = _launch(false, 0);
        assertEq(burner, address(0));
        _assertLaunchInvariants(token, kernel, burner, agentId, false);
        assertEq(IERC20(token).balanceOf(creator), 0);
    }

    function test_launchStandardWithDevBuy() public {
        uint256 before = creator.balance;
        (address token, address kernel, address burner, uint256 agentId) = _launch(false, 0.01 ether);
        _assertLaunchInvariants(token, kernel, burner, agentId, false);
        assertGt(IERC20(token).balanceOf(creator), 0, "dev buy delivered to creator");
        assertEq(before - creator.balance, 0.01 ether);
    }

    function test_launchBuybackWithDevBuy() public {
        (address token, address kernel, address burner, uint256 agentId) = _launch(true, 0.02 ether);
        assertTrue(burner != address(0));
        assertEq(burner, launcher.predictBurner(creator, bytes32(uint256(7))));
        _assertLaunchInvariants(token, kernel, burner, agentId, true);
        BuybackBurner b = BuybackBurner(burner);
        assertEq(address(b.token()), token);
        assertTrue(b.initialized());
        PoolKey memory key = launcher.poolKeyFor(token);
        vm.expectRevert(BuybackBurner.AlreadyInitialized.selector);
        b.initialize(token, WETH, RWAGMI_LOCKER, key, UNIVERSAL_ROUTER, PERMIT2, address(launcher));
        assertEq(b.launcher(), address(launcher));
        assertEq(b.keeper(), address(this), "launcher owner is the burner keeper");
    }

    function test_launchRefundsExcessEth() public {
        uint256 before = creator.balance;
        vm.prank(creator);
        launcher.launch{value: 0.5 ether}(_params(false, 0.01 ether, bytes32(uint256(9))));
        assertEq(before - creator.balance, 0.01 ether, "excess refunded");
    }

    function test_launchPredictsKernelAndRejectsReplay() public {
        address predicted = launcher.predictKernel(creator, bytes32(uint256(7)));
        (, address kernel,,) = _launch(false, 0);
        assertEq(kernel, predicted);
        // same creator + salt -> same kernel -> guardian rejects the duplicate registration
        vm.prank(creator);
        vm.expectRevert();
        launcher.launch(_params(false, 0, bytes32(uint256(7))));
    }

    function _assertLaunchInvariants(address token, address kernel, address burner, uint256 agentId, bool buyback)
        internal
        view
    {
        // token: B20 Asset, immutable mode, all supply placed as liquidity, address predicted by the launcher
        assertEq(IERC20(token).totalSupply(), TOTAL_SUPPLY);
        assertEq(token, launcher.predictToken(creator, bytes32(uint256(7))), "token address predicted");
        IRwagmiB20LauncherV3.DeploymentInfoV3 memory info =
            IRwagmiB20LauncherV3(RWAGMI_LAUNCHER).deploymentInfo(token);
        assertEq(info.creator, address(launcher), "RWAGMI creator is the launcher");
        assertEq(info.hook, RWAGMI_HOOK);
        assertEq(info.locker, RWAGMI_LOCKER);
        assertEq(uint8(info.adminMode), uint8(0), "immutable mode");
        assertEq(uint8(info.state), uint8(2), "launch complete");
        // pool: one WETH pool, 1% static hook fee
        bytes32 poolId = _poolId(token);
        assertEq(info.primaryPoolId, poolId);
        assertEq(info.poolIds.length, 1);
        assertEq(IRwagmiHookV3(RWAGMI_HOOK).currentFee(poolId), 10_000, "1% static hook fee");
        // rewards in the RWAGMI locker: Bootr slots over 9000 bps, admin = launcher, RWAGMI's 1000 bps last
        IRwagmiLpLockerV3.LaunchInfo memory li = IRwagmiLpLockerV3(RWAGMI_LOCKER).launchInfo(token);
        assertTrue(li.complete);
        assertEq(li.poolIds.length, 1);
        assertEq(li.poolIds[0], poolId);
        uint256 n = buyback ? 4 : 3;
        assertEq(li.rewards.length, n + 1, "Bootr slots + RWAGMI slot");
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            assertEq(li.rewards[i].admin, address(launcher), "slot admin is the launcher");
            sum += li.rewards[i].bps;
        }
        assertEq(sum, 9000);
        assertEq(li.rewards[n].bps, 1000, "RWAGMI protocol slot");
        assertEq(li.rewards[0].recipient, kernel);
        assertEq(li.rewards[0].bps, 450);
        assertEq(li.rewards[1].recipient, creator);
        assertEq(li.rewards[1].bps, buyback ? 4500 : 5850);
        if (buyback) {
            assertEq(li.rewards[2].recipient, burner);
            assertEq(li.rewards[2].bps, 1350);
        }
        assertEq(li.rewards[n - 1].recipient, platformRecipient);
        assertEq(li.rewards[n - 1].bps, 2700);
        // kernel
        assertEq(IKernel(kernel).rootValidator(), KernelLib.validatorId(address(guardian)));
        assertEq(IKernel(kernel).validationConfig(KernelLib.validatorId(address(guardian))).hook, address(guardian));
        assertEq(IKernel(kernel).entrypoint(), ENTRY_POINT);
        assertEq(IERC20(USDC).balanceOf(kernel), FUEL, "fuel in kernel");
        (, string memory name, string memory version,, address verifying,,) = IKernel(kernel).eip712Domain();
        assertEq(name, "Kernel");
        assertEq(version, "0.3.1");
        assertEq(verifying, kernel);

        // identity
        assertEq(IERC8004IdentityRegistry(IDENTITY).ownerOf(agentId), kernel, "identity owned by kernel");
        assertEq(IERC8004IdentityRegistry(IDENTITY).tokenURI(agentId), "https://bootr.example/agent.json");

        // guardian
        AgentGuardian.AgentInfo memory a = guardian.agentInfo(kernel);
        assertEq(a.token, token);
        assertEq(a.creator, creator);
        assertEq(a.dormancyPeriod, DORMANCY);
        assertEq(a.lastActivity, vm.getBlockTimestamp());
        assertFalse(a.paused);
    }

    // ------------------------------------------------------------------
    // Fees (hook fee in WETH, 90% to Bootr's slots, 10% to RWAGMI)
    // ------------------------------------------------------------------

    function test_swapAccruesFeesInRatio_standard() public {
        (address token, address kernel,,) = _launch(false, 0);
        _passMevWindow();
        uint256 wethIn = 1 ether;
        _buy(token, wethIn);
        bytes32 poolId = _poolId(token);
        uint256 gross = IRwagmiHookV3(RWAGMI_HOOK).cumulativeFees(poolId);
        assertApproxEqRel(gross, wethIn / 100, 0.01e18, "hook fee = 1% of the swapped WETH");
        // nothing is credited until a settle (claims settle on the way)
        uint256 fKernel = _claimable(token, kernel);
        uint256 fCreator = _claimable(token, creator);
        uint256 fPlatform = _claimable(token, platformRecipient);
        assertApproxEqAbs(fKernel, gross * 450 / 10_000, 2);
        assertApproxEqAbs(fCreator, gross * 5850 / 10_000, 2);
        assertApproxEqAbs(fPlatform, gross * 2700 / 10_000, 2);
        assertApproxEqAbs(fKernel + fCreator + fPlatform, gross * 9000 / 10_000, 4, "Bootr slots get 90%");
        // recipients claim for themselves: the kernel's share lands in the kernel
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = poolId;
        vm.prank(kernel);
        uint256 claimed = IRwagmiLpLockerV3(RWAGMI_LOCKER).settleAndClaim(ids, WETH, kernel);
        assertEq(claimed, fKernel);
        assertEq(IERC20(WETH).balanceOf(kernel), fKernel);
        assertEq(_claimable(token, kernel), 0);
        // nobody else can claim the creator's share, and a claim to someone else pays the caller's balance only
        vm.prank(trader);
        assertEq(IRwagmiLpLockerV3(RWAGMI_LOCKER).claimQuote(WETH, trader), 0);
        assertEq(_claimable(token, creator), fCreator);
    }

    function test_swapAccruesFeesInRatio_buybackAndBurn() public {
        (address token, address kernel, address burner,) = _launch(true, 0);
        _passMevWindow();
        _buy(token, 1 ether);
        uint256 gross = IRwagmiHookV3(RWAGMI_HOOK).cumulativeFees(_poolId(token));
        assertApproxEqAbs(_claimable(token, kernel), gross * 450 / 10_000, 2);
        assertApproxEqAbs(_claimable(token, creator), gross * 4500 / 10_000, 2);
        assertApproxEqAbs(_claimable(token, burner), gross * 1350 / 10_000, 2);
        assertApproxEqAbs(_claimable(token, platformRecipient), gross * 2700 / 10_000, 2);
        (uint256 pending, uint256 claimable) = BuybackBurner(burner).pendingFees();
        assertEq(pending + claimable, _claimable(token, burner));
        // anyone may pull the burner's WETH into the burner; only the keeper may swap and burn
        uint256 burnerShare = BuybackBurner(burner).claim();
        assertGt(burnerShare, 0);
        assertEq(IERC20(WETH).balanceOf(burner), burnerShare);
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        (uint256 bought, uint256 burned) = BuybackBurner(burner).swapAndBurn(1);
        assertGt(bought, 0);
        assertEq(burned, bought);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, burned);
        assertEq(IERC20(WETH).balanceOf(burner), 0);
        assertEq(IERC20(token).balanceOf(burner), 0);
    }

    function test_burnerSwapAndBurnFallback() public {
        (address token,, address burner,) = _launch(true, 0);
        _passMevWindow();
        _buy(token, 0.1 ether);
        // stray WETH sent directly to the burner
        vm.deal(address(this), 1 ether);
        IWETH9(WETH).deposit{value: 0.05 ether}();
        IWETH9(WETH).transfer(burner, 0.05 ether);
        // not the keeper (launcher owner): rejected before anything is claimed or swapped (BOOTR-03)
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(BuybackBurner.NotKeeper.selector, trader));
        BuybackBurner(burner).swapAndBurn(1);
        vm.expectRevert(); // unrealistic minOut -> the Universal Router reverts with V4TooLittleReceived
        BuybackBurner(burner).swapAndBurn(type(uint128).max);
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        (uint256 bought, uint256 burned) = BuybackBurner(burner).swapAndBurn(1);
        assertGt(bought, 0);
        assertGe(burned, bought);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, burned);
        assertEq(IERC20(WETH).balanceOf(burner), 0);
        // the burn swap itself paid the hook fee, and the burner owns a slot of it: a second pass burns far less
        (uint256 bought2, uint256 burned2) = BuybackBurner(burner).swapAndBurn(1);
        assertGt(bought2, 0);
        assertEq(burned2, bought2);
        assertLt(bought2, bought / 20, "second pass only recycles the burner's own fee share");
        // stray coins are burnable by anyone
        vm.prank(trader);
        assertEq(BuybackBurner(burner).burn(), 0);
    }

    // ------------------------------------------------------------------
    // Immutability of rewards
    // ------------------------------------------------------------------

    function test_launcherOwnerCannotChangeRewards() public {
        (address token,,,) = _launch(false, 0);
        address attacker = makeAddr("attacker");
        IRwagmiLpLockerV3 locker = IRwagmiLpLockerV3(RWAGMI_LOCKER);
        // only the slot admin (= launcher) may update, and the launcher has no such function
        vm.prank(launcher.owner());
        vm.expectRevert();
        locker.updateRewardRecipient(token, 0, attacker);
        vm.prank(launcher.owner());
        vm.expectRevert();
        locker.updateRewardAdmin(token, 0, attacker);
        vm.prank(creator);
        vm.expectRevert();
        locker.updateRewardRecipient(token, 1, attacker);
        // launcher exposes no pass-through
        (bool ok,) = address(launcher).call(abi.encodeCall(IRwagmiLpLockerV3.updateRewardRecipient, (token, 0, attacker)));
        assertFalse(ok);
        (ok,) = address(launcher).call(abi.encodeCall(IRwagmiLpLockerV3.updateRewardAdmin, (token, 0, attacker)));
        assertFalse(ok);
        IRwagmiLpLockerV3.LaunchInfo memory li = locker.launchInfo(token);
        assertEq(li.rewards[0].admin, address(launcher));
        assertEq(guardian.agentInfo(li.rewards[0].recipient).token, token, "slot 0 is still the agent kernel");
    }

    // ------------------------------------------------------------------
    // Kernel access control
    // ------------------------------------------------------------------

    function test_creatorCannotMoveKernelFundsDirectly() public {
        (, address kernel,,) = _launch(false, 0);
        bytes memory exec = KernelLib.encodeSingle(USDC, 0, abi.encodeCall(IERC20.transfer, (creator, FUEL)));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentGuardian.UnauthorizedCaller.selector, creator));
        IKernel(kernel).execute(KernelLib.EXEC_MODE_SINGLE, exec);
        // nor the platform admin, nor a spoofed "root" sender
        vm.expectRevert(abi.encodeWithSelector(AgentGuardian.UnauthorizedCaller.selector, address(this)));
        IKernel(kernel).execute(KernelLib.EXEC_MODE_SINGLE, exec);
        vm.prank(address(guardian));
        vm.expectRevert(AgentGuardian.NotRootCall.selector);
        IKernel(kernel).execute(KernelLib.EXEC_MODE_SINGLE, exec);
        assertEq(IERC20(USDC).balanceOf(kernel), FUEL);
    }

    function test_creatorCannotMoveKernelFundsViaRootUserOp() public {
        (, address kernel,,) = _launch(false, 0);
        entryPoint.depositTo{value: 1 ether}(kernel);
        PackedUserOperation memory op =
            _userOp(kernel, entryPoint.getNonce(kernel, 0), USDC, abi.encodeCall(IERC20.transfer, (creator, FUEL)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(creatorPk, entryPoint.getUserOpHash(op));
        op.signature = abi.encodePacked(r, s, v);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA24 signature error"));
        entryPoint.handleOps(ops, payable(bundler));
        assertEq(IERC20(USDC).balanceOf(kernel), FUEL);
    }

    // ------------------------------------------------------------------
    // Session key (permission) via enable mode + activity + pause + revoke
    // ------------------------------------------------------------------

    bytes4 constant PID = bytes4(keccak256("bootr.session.v1"));

    function _permissionData() internal view returns (bytes memory) {
        bytes[] memory enableData = new bytes[](2);
        enableData[0] = abi.encodePacked(bytes2(0), SUDO_POLICY); // policy 0: no init data
        enableData[1] = abi.encodePacked(bytes2(0), ECDSA_SIGNER, sessionKey); // signer
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
            accountGasLimits: bytes32((uint256(3_000_000) << 128) | 3_000_000),
            preVerificationGas: 200_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | 1 gwei),
            paymasterAndData: "",
            signature: ""
        });
    }

    /// @dev `[0 ‖ uint64(32) ‖ abi.encode(now)] ‖ 0xff ‖ sig`: the supervisor's regular session signature. The
    ///      slot addresses policy 0 (BootrCallPolicy's time claim for SUM_PER_WINDOW; ignored by SudoPolicy).
    function _signSession(PackedUserOperation memory op, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, entryPoint.getUserOpHash(op));
        return abi.encodePacked(uint8(0), uint64(32), abi.encode(vm.getBlockTimestamp()), bytes1(0xff), r, s, v);
    }

    function _handle(PackedUserOperation memory op) internal returns (bool success) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.recordLogs();
        vm.prank(bundler);
        entryPoint.handleOps(ops, payable(bundler));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    /// @dev Installs the session permission through enable mode and runs its first userOp.
    function _installSession(address kernel) internal returns (bytes32 digest) {
        bytes memory validatorData = _permissionData();
        (digest,) = guardian.approveSessionKey(kernel, PID, validatorData);
        entryPoint.depositTo{value: 1 ether}(kernel);
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x01), USDC, abi.encodeCall(IERC20.approve, (address(0xBEEF), 1)));
        bytes memory userOpSig = _signSession(op, sessionPk);
        op.signature = abi.encodePacked(
            address(guardian),
            abi.encode(validatorData, hex"00", abi.encodePacked(IKernel.execute.selector), bytes(""), userOpSig)
        );
        assertTrue(_handle(op), "enable userOp executed");
    }

    function test_sessionKeyEnableActivityPauseRevoke() public {
        (, address kernel,,) = _launch(false, 0);
        uint256 t0 = vm.getBlockTimestamp(); // via_ir can re-materialize block.timestamp across vm.warp
        vm.warp(t0 + 10 days);
        _installSession(kernel);
        bytes21 vId = KernelLib.permissionId(PID);
        assertEq(IKernel(kernel).validationConfig(vId).hook, address(guardian), "session hook is guardian");
        assertTrue(IKernel(kernel).isAllowedSelector(vId, IKernel.execute.selector));
        assertEq(IERC20(USDC).allowance(kernel, address(0xBEEF)), 1, "session op executed");
        assertEq(guardian.agentInfo(kernel).lastActivity, t0 + 10 days, "activity stamped by hook");

        // regular (non-enable) userOp through the session key
        vm.warp(t0 + 20 days);
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.approve, (address(0xBEEF), 2)));
        op.signature = _signSession(op, sessionPk);
        assertTrue(_handle(op));
        assertEq(IERC20(USDC).allowance(kernel, address(0xBEEF)), 2);
        assertEq(guardian.agentInfo(kernel).lastActivity, t0 + 20 days);

        // creator cannot use the session path
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (creator, FUEL)));
        op.signature = _signSession(op, creatorPk);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA24 signature error"));
        entryPoint.handleOps(ops, payable(bundler));

        // pause blocks the session path (execution reverts in preCheck), activity unchanged
        vm.prank(creator);
        guardian.pauseAgent(kernel);
        vm.warp(t0 + 30 days);
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.approve, (address(0xBEEF), 3)));
        op.signature = _signSession(op, sessionPk);
        assertFalse(_handle(op), "paused: execution fails");
        assertEq(IERC20(USDC).allowance(kernel, address(0xBEEF)), 2);
        assertEq(guardian.agentInfo(kernel).lastActivity, t0 + 20 days);
        vm.prank(creator);
        guardian.unpauseAgent(kernel);
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.approve, (address(0xBEEF), 3)));
        op.signature = _signSession(op, sessionPk);
        assertTrue(_handle(op));
        assertEq(guardian.agentInfo(kernel).lastActivity, t0 + 30 days);

        // revoke all session keys via root nonce invalidation -> validation reverts (AA23)
        guardian.revokeAllSessionKeys(kernel);
        assertEq(IKernel(kernel).validNonceFrom(), 2);
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.approve, (address(0xBEEF), 4)));
        op.signature = _signSession(op, sessionPk);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(bundler));
        assertEq(IERC20(USDC).balanceOf(kernel), FUEL, "funds never left");
    }

    function test_sessionKeyRequiresApprovedDigest() public {
        (, address kernel,,) = _launch(false, 0);
        entryPoint.depositTo{value: 1 ether}(kernel);
        bytes memory validatorData = _permissionData();
        // no approval -> EnableNotApproved inside validateUserOp -> AA23 reverted
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x01), USDC, abi.encodeCall(IERC20.approve, (address(0xBEEF), 1)));
        bytes memory userOpSig = _signSession(op, sessionPk);
        op.signature = abi.encodePacked(
            address(guardian),
            abi.encode(validatorData, hex"00", abi.encodePacked(IKernel.execute.selector), bytes(""), userOpSig)
        );
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(bundler));

        // approval with a different hook (address(1) = no hook) must not be usable either
        guardian.approveSessionKey(kernel, PID, validatorData);
        op.signature = abi.encodePacked(
            address(1),
            abi.encode(validatorData, hex"00", abi.encodePacked(IKernel.execute.selector), bytes(""), userOpSig)
        );
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(bundler));
    }

    // ------------------------------------------------------------------
    // Session key with BootrCallPolicy (the supervisor's production policy)
    // ------------------------------------------------------------------

    /// @dev Kernel `PassFlag` / ZeroDev `PolicyFlags.NOT_FOR_VALIDATE_SIG`.
    bytes2 constant NOT_FOR_VALIDATE_SIG = 0x0002;
    uint256 constant USDC_CAP = 50e6;

    /// @dev The exact four rules `apps/supervisor/src/session-key.ts` installs (swap helper, not the router).
    function _callPolicyRules(address kernel) internal view returns (BootrCallPolicy.Rule[] memory rules) {
        rules = new BootrCallPolicy.Rule[](4);
        // RwagmiLpLockerV3.settleAndClaim(bytes32[] ids, address currency, address to): `to` (arg 2) must be the kernel
        rules[0].target = RWAGMI_LOCKER;
        rules[0].selector = IRwagmiLpLockerV3.settleAndClaim.selector;
        rules[0].args = new BootrCallPolicy.ArgRule[](1);
        rules[0].args[0] = BootrCallPolicy.ArgRule(2, 1, bytes32(uint256(uint160(kernel))));
        rules[1].target = WETH;
        rules[1].selector = IERC20.approve.selector;
        rules[1].args = new BootrCallPolicy.ArgRule[](1);
        rules[1].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(address(swapHelper)))));
        rules[2].target = address(swapHelper);
        rules[2].selector = BootrSwapHelper.swapWethToUsdc.selector;
        rules[2].args = new BootrCallPolicy.ArgRule[](0);
        // USDC.transfer(spender, SUM_PER_WINDOW <= USDC_CAP per day): `payTo` plays the per-agent spender here
        rules[3].target = USDC;
        rules[3].selector = IERC20.transfer.selector;
        rules[3].windowSeconds = 1 days;
        rules[3].args = new BootrCallPolicy.ArgRule[](2);
        rules[3].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(payTo))));
        rules[3].args[1] = BootrCallPolicy.ArgRule(1, 3, bytes32(USDC_CAP));
    }

    function _callPolicyPermissionData(address kernel) internal view returns (bytes memory) {
        bytes[] memory enableData = new bytes[](2);
        enableData[0] =
            abi.encodePacked(NOT_FOR_VALIDATE_SIG, address(callPolicy), abi.encode(_callPolicyRules(kernel)));
        enableData[1] = abi.encodePacked(NOT_FOR_VALIDATE_SIG, ECDSA_SIGNER, sessionKey); // SKIP_SIGNATURE: no ERC-1271
        return abi.encode(enableData);
    }

    function _batchUserOp(address kernel, uint256 nonce, Execution[] memory execs)
        internal
        pure
        returns (PackedUserOperation memory op)
    {
        op = _userOp(kernel, nonce, address(0), "");
        bytes memory inner = abi.encodeCall(IKernel.execute, (KernelLib.EXEC_MODE_BATCH, KernelLib.encodeBatch(execs)));
        op.callData = abi.encodePacked(IKernel.executeUserOp.selector, inner);
    }

    function _valueUserOp(address kernel, uint256 nonce, address target, uint256 value, bytes memory data)
        internal
        pure
        returns (PackedUserOperation memory op)
    {
        op = _userOp(kernel, nonce, target, data);
        bytes memory inner =
            abi.encodeCall(IKernel.execute, (KernelLib.EXEC_MODE_SINGLE, KernelLib.encodeSingle(target, value, data)));
        op.callData = abi.encodePacked(IKernel.executeUserOp.selector, inner);
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

    function _sendExpectingPolicyFailed(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        _expectPolicyFailed(0);
        vm.prank(bundler);
        entryPoint.handleOps(ops, payable(bundler));
    }

    /// @dev Installs the call-policy session through enable mode; the first userOp is an allowed no-op transfer.
    function _installCallPolicySession(address kernel) internal {
        bytes memory validatorData = _callPolicyPermissionData(kernel);
        guardian.approveSessionKey(kernel, PID, validatorData);
        entryPoint.depositTo{value: 1 ether}(kernel);
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x01), USDC, abi.encodeCall(IERC20.transfer, (payTo, 0)));
        bytes memory userOpSig = _signSession(op, sessionPk);
        op.signature = abi.encodePacked(
            address(guardian),
            abi.encode(validatorData, hex"00", abi.encodePacked(IKernel.execute.selector), bytes(""), userOpSig)
        );
        vm.expectEmit(true, false, false, true, address(guardian));
        emit AgentGuardian.Activity(kernel, uint64(vm.getBlockTimestamp()));
        assertTrue(_handle(op), "enable userOp with call policy executed");
    }

    function test_callPolicySession_allowedNoOpInstallsAndStampsActivity() public {
        (, address kernel,,) = _launch(false, 0);
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + 1 days);
        _installCallPolicySession(kernel);

        bytes32 id = bytes32(PID);
        assertTrue(callPolicy.installed(id, kernel), "policy installed for (pid, kernel)");
        assertTrue(callPolicy.isInitialized(kernel));
        assertEq(callPolicy.rulesOf(id, kernel).length, 4);
        bytes21 vId = KernelLib.permissionId(PID);
        assertEq(IKernel(kernel).validationConfig(vId).hook, address(guardian));
        assertTrue(IKernel(kernel).isAllowedSelector(vId, IKernel.execute.selector));
        assertEq(guardian.agentInfo(kernel).lastActivity, t0 + 1 days, "activity stamped by the hook");
        assertEq(IERC20(USDC).balanceOf(kernel), FUEL);

        // a second allowed single call through the regular (non-enable) path
        vm.warp(t0 + 2 days);
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (payTo, 1e6)));
        op.signature = _signSession(op, sessionPk);
        assertTrue(_handle(op), "allowed transfer executed");
        assertEq(IERC20(USDC).balanceOf(payTo), 1e6);
        assertEq(guardian.agentInfo(kernel).lastActivity, t0 + 2 days);
    }

    function test_callPolicySession_disallowedCallsRejectedAtValidation() public {
        (, address kernel,,) = _launch(false, 0);
        _installCallPolicySession(kernel);

        // (b) transfer to the creator: wrong recipient -> PolicyFailed(0) inside AA23
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (creator, 1)));
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);

        // over the cap
        op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (payTo, USDC_CAP + 1))
        );
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);

        // wrong selector on an allowed target
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.approve, (payTo, 1)));
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);

        // claim to someone else
        op = _userOp(
            kernel,
            _permissionNonce(kernel, 0x00),
            RWAGMI_LOCKER,
            abi.encodeCall(IRwagmiLpLockerV3.settleAndClaim, (new bytes32[](0), WETH, creator))
        );
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);

        // (d) non-zero value on an otherwise allowed call
        op = _valueUserOp(kernel, _permissionNonce(kernel, 0x00), USDC, 1, abi.encodeCall(IERC20.transfer, (payTo, 0)));
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);

        // delegatecall mode
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, "");
        op.callData = abi.encodePacked(
            IKernel.executeUserOp.selector,
            abi.encodeCall(
                IKernel.execute,
                (bytes32(uint256(0xff) << 248), abi.encodePacked(USDC, abi.encodeCall(IERC20.transfer, (payTo, 0))))
            )
        );
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);

        assertEq(IERC20(USDC).balanceOf(kernel), FUEL, "funds never left");
        assertEq(IERC20(USDC).balanceOf(creator), 10_000e6 - FUEL, "creator received nothing");
    }

    function test_callPolicySession_batchOfAllowedCalls() public {
        (address token, address kernel,,) = _launch(false, 0);
        _installCallPolicySession(kernel);
        // give the kernel some WETH so the router transfer is a real (non-zero) ERC-20 move
        vm.deal(address(this), 1 ether);
        IWETH9(WETH).deposit{value: 0.1 ether}();
        IWETH9(WETH).transfer(kernel, 0.1 ether);
        // and some claimable fees for locker.settleAndClaim([poolId], WETH, kernel)
        _passMevWindow();
        _buy(token, 0.5 ether);
        uint256 claimable = _claimable(token, kernel);
        assertGt(claimable, 0);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = _poolId(token);

        // (c) batch: claim fees, approve the swap helper, swap WETH -> USDC into the kernel, fund inference
        uint256 usdcBefore = IERC20(USDC).balanceOf(kernel);
        Execution[] memory execs = new Execution[](4);
        execs[0] = Execution(RWAGMI_LOCKER, 0, abi.encodeCall(IRwagmiLpLockerV3.settleAndClaim, (ids, WETH, kernel)));
        execs[1] = Execution(WETH, 0, abi.encodeCall(IERC20.approve, (address(swapHelper), 0.0005 ether)));
        execs[2] = Execution(address(swapHelper), 0, abi.encodeCall(BootrSwapHelper.swapWethToUsdc, (0.0005 ether, 200)));
        execs[3] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (payTo, 2e6)));
        PackedUserOperation memory op = _batchUserOp(kernel, _permissionNonce(kernel, 0x00), execs);
        op.signature = _signSession(op, sessionPk);
        assertTrue(_handle(op), "batch executed");
        assertEq(IERC20(WETH).balanceOf(kernel), 0.1 ether - 0.0005 ether + claimable);
        assertGe(IERC20(USDC).balanceOf(kernel), usdcBefore - 2e6 + swapHelper.minUsdcOut(0.0005 ether, 200), "swap paid the kernel");
        assertEq(IERC20(USDC).balanceOf(payTo), 2e6);

        // a batch with one disallowed call is rejected as a whole
        execs = new Execution[](2);
        execs[0] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (payTo, 1)));
        execs[1] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (creator, 1)));
        op = _batchUserOp(kernel, _permissionNonce(kernel, 0x00), execs);
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);
        assertEq(IERC20(USDC).balanceOf(payTo), 2e6);

        // M-02: k allowed transfers whose SUM exceeds the cap are rejected as a whole
        execs = new Execution[](2);
        execs[0] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (payTo, USDC_CAP)));
        execs[1] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (payTo, 1)));
        op = _batchUserOp(kernel, _permissionNonce(kernel, 0x00), execs);
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);
        assertEq(IERC20(USDC).balanceOf(payTo), 2e6);

        // the old router rules are gone: paying WETH to the router is not allow-listed any more (C-02)
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), WETH, abi.encodeCall(IERC20.transfer, (UNIVERSAL_ROUTER, 1)));
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), WETH, abi.encodeCall(IERC20.approve, (creator, 1)));
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);
    }

    /// @dev Base Builder Codes attribution: `Attribution.toDataSuffix({ codes: ['bc_a1b2c3d4'] })` from ox 0.14.57
    ///      (ascii code ‖ length 0x0b ‖ schema 0x00 ‖ 16-byte 0x8021… marker), appended by the supervisor to every
    ///      session userOp's callData after `executeUserOp ‖ execute(...)`.
    bytes constant ERC8021_SUFFIX = hex"62635f61316232633364340b0080218021802180218021802180218021";

    function test_callPolicySession_erc8021SuffixExecutesAndStampsActivity() public {
        (, address kernel,,) = _launch(false, 0);
        uint256 t0 = vm.getBlockTimestamp();
        _installCallPolicySession(kernel);

        // allowed single call with the attribution suffix: validated by the policy, executed by the Kernel,
        // seen by the guardian hook (Activity)
        vm.warp(t0 + 3 days);
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (payTo, 3e6)));
        op.callData = abi.encodePacked(op.callData, ERC8021_SUFFIX);
        assertEq(bytes4(op.callData), IKernel.executeUserOp.selector);
        op.signature = _signSession(op, sessionPk);
        vm.expectEmit(true, false, false, true, address(guardian));
        emit AgentGuardian.Activity(kernel, uint64(t0 + 3 days));
        assertTrue(_handle(op), "userOp with ERC-8021 suffix executed");
        assertEq(IERC20(USDC).balanceOf(payTo), 3e6, "transfer executed");
        assertEq(guardian.agentInfo(kernel).lastActivity, t0 + 3 days, "hook saw the suffixed op");

        // a batch with the suffix
        vm.warp(t0 + 4 days);
        Execution[] memory execs = new Execution[](2);
        execs[0] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (payTo, 1e6)));
        execs[1] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (payTo, 2e6)));
        op = _batchUserOp(kernel, _permissionNonce(kernel, 0x00), execs);
        op.callData = abi.encodePacked(op.callData, ERC8021_SUFFIX);
        op.signature = _signSession(op, sessionPk);
        assertTrue(_handle(op), "batch with ERC-8021 suffix executed");
        assertEq(IERC20(USDC).balanceOf(payTo), 6e6);
        assertEq(guardian.agentInfo(kernel).lastActivity, t0 + 4 days);

        // the suffix does not weaken the policy: a disallowed call still fails at validation
        op = _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (creator, 1)));
        op.callData = abi.encodePacked(op.callData, ERC8021_SUFFIX);
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);
        assertEq(IERC20(USDC).balanceOf(creator), 10_000e6 - FUEL, "creator received nothing");
    }

    function test_callPolicySession_revokeUninstallsRules() public {
        (, address kernel,,) = _launch(false, 0);
        _installCallPolicySession(kernel);
        bytes32 id = bytes32(PID);
        assertTrue(callPolicy.installed(id, kernel));
        // deinit data: one entry per policy + the signer, as the supervisor's buildDeinitData encodes it
        bytes[] memory disable = new bytes[](2);
        disable[0] = abi.encodePacked(address(callPolicy));
        disable[1] = abi.encodePacked(ECDSA_SIGNER);
        guardian.revokeSessionKey(kernel, PID, abi.encode(disable));
        assertFalse(callPolicy.installed(id, kernel), "rules deleted through Kernel.uninstallValidation");
        assertEq(callPolicy.rulesOf(id, kernel).length, 0);
        assertEq(IKernel(kernel).validationConfig(KernelLib.permissionId(PID)).hook, address(0));
        // the session key can no longer act
        PackedUserOperation memory op =
            _userOp(kernel, _permissionNonce(kernel, 0x00), USDC, abi.encodeCall(IERC20.transfer, (payTo, 1)));
        op.signature = _signSession(op, sessionPk);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler);
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(bundler));
    }

    // ------------------------------------------------------------------
    // Dormancy
    // ------------------------------------------------------------------

    function test_claimDormantBeforeAndAfter90Days() public {
        (address token, address kernel,,) = _launch(false, 0.02 ether);
        // give the kernel some of its own coin, some WETH and ETH
        uint256 coins = IERC20(token).balanceOf(creator) / 2;
        vm.prank(creator);
        IERC20(token).transfer(kernel, coins);
        vm.deal(address(this), 2 ether);
        IWETH9(WETH).deposit{value: 0.3 ether}();
        IWETH9(WETH).transfer(kernel, 0.3 ether);
        vm.deal(kernel, 0.7 ether);

        uint256 dormantAfter = guardian.dormantAt(kernel);
        assertEq(dormantAfter, vm.getBlockTimestamp() + DORMANCY);
        vm.warp(dormantAfter - 1);
        vm.expectRevert(abi.encodeWithSelector(AgentGuardian.NotDormant.selector, dormantAfter));
        guardian.claimDormant(kernel, new address[](0));

        vm.warp(dormantAfter);
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        (uint256 u, uint256 w, uint256 e, uint256 b) = guardian.claimDormant(kernel, new address[](0));
        assertEq(u, FUEL);
        assertEq(w, 0.3 ether);
        assertEq(e, 0.7 ether);
        assertEq(b, coins);
        assertEq(IERC20(USDC).balanceOf(treasury), FUEL, "100% USDC to platform");
        assertEq(IERC20(WETH).balanceOf(treasury), 0.3 ether);
        assertEq(treasury.balance, 0.7 ether);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, coins, "own coin burned");
        assertEq(IERC20(USDC).balanceOf(kernel), 0);
        assertEq(IERC20(token).balanceOf(kernel), 0);
        assertEq(kernel.balance, 0);
        // non-owner cannot sweep
        vm.prank(creator);
        vm.expectRevert();
        guardian.claimDormant(kernel, new address[](0));
    }

    function test_activityResetsDormancyClock() public {
        (, address kernel,,) = _launch(false, 0);
        uint256 t0 = vm.getBlockTimestamp(); // via_ir can re-materialize block.timestamp across vm.warp
        vm.warp(t0 + 60 days);
        _installSession(kernel); // session-key userOp = activity at t0 + 60d
        assertEq(guardian.dormantAt(kernel), t0 + 60 days + DORMANCY);
        vm.warp(t0 + DORMANCY + 1 days); // would have been dormant without the activity
        vm.expectRevert(abi.encodeWithSelector(AgentGuardian.NotDormant.selector, t0 + 60 days + DORMANCY));
        guardian.claimDormant(kernel, new address[](0));
        vm.warp(t0 + 60 days + DORMANCY);
        (uint256 u,,,) = guardian.claimDormant(kernel, new address[](0));
        assertEq(u, FUEL);
        assertEq(IERC20(USDC).balanceOf(treasury), FUEL);
    }

    function test_pauseDoesNotMoveFundsOrResetClock() public {
        (, address kernel,,) = _launch(false, 0);
        uint64 before = guardian.agentInfo(kernel).lastActivity;
        vm.warp(vm.getBlockTimestamp() + 5 days);
        vm.prank(creator);
        guardian.pauseAgent(kernel);
        assertEq(guardian.agentInfo(kernel).lastActivity, before);
        assertEq(IERC20(USDC).balanceOf(kernel), FUEL);
        assertTrue(guardian.agentInfo(kernel).paused);
    }
}
