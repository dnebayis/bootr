// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrCallPolicy} from "../../src/BootrCallPolicy.sol";
import {BootrLauncher} from "../../src/BootrLauncher.sol";
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
import {Execution, IEntryPoint, IKernel, KernelLib, PackedUserOperation} from "../../src/interfaces/IKernel.sol";
import {IPoolSwapTest, IWETH9, PoolKey, V4Constants} from "../../src/interfaces/IUniswapV4.sol";

interface IERC6909Balance {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
}

/// @notice Fork tests against Base Sepolia (live Clanker v4, Kernel v3.1, EntryPoint v0.7, ERC-8004).
///         RPC: `BASE_SEPOLIA_RPC_URL` env or https://sepolia.base.org.
contract BootrForkTest is Test {
    // --- Base Sepolia ---
    address constant CLANKER = 0xE85A59c628F7d27878ACeB4bf3b35733630083a9;
    address constant FEE_LOCKER = 0x42A95190B4088C88Dd904d930c79deC1158bF09D;
    address constant LP_LOCKER = 0x824bB048a5EC6e06a09aEd115E9eEA4618DC2c8f; // ClankerLpLockerFeeConversion
    address constant HOOK = 0x11b51DBC2f7F683b81CeDa83DC0078D57bA328cc; // ClankerHookStaticFeeV2
    address constant DEV_BUY = 0x691f97752E91feAcD7933F32a1FEdCeDae7bB59c;
    address constant MEV = 0x71DB365E93e170ba3B053339A917c11024e7a9d4;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant KERNEL_FACTORY = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant UNIVERSAL_ROUTER = 0x492E6456D9528771018DeB9E87ef7750EF184104;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    address constant POOL_SWAP_TEST = 0x8B5bcC363ddE2614281aD875bad385E0A785D3B9;
    address constant SUDO_POLICY = 0x67b436caD8a6D025DF6C82C5BB43fbF11fC5B9B7;
    address constant ECDSA_SIGNER = 0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    AgentGuardian guardian;
    BuybackBurner burnerImpl;
    BootrLauncher launcher;
    BootrCallPolicy callPolicy;
    IEntryPoint entryPoint = IEntryPoint(ENTRY_POINT);

    address platformRecipient = makeAddr("platformRecipient");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address bundler = makeAddr("bundler");
    address trader = makeAddr("trader");
    address payTo = makeAddr("inferencePayTo");
    uint256 sessionPk = 0xA11CE;
    address sessionKey = vm.addr(sessionPk);
    uint256 creatorPk = 0xC0FFEE;

    uint256 constant FUEL = 100e6;
    uint32 constant DORMANCY = 90 days;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_SEPOLIA_RPC_URL", string("https://sepolia.base.org")));
        creator = vm.addr(creatorPk);

        guardian = new AgentGuardian(address(this), ENTRY_POINT, USDC, WETH);
        burnerImpl = new BuybackBurner();
        callPolicy = new BootrCallPolicy();
        launcher = new BootrLauncher(
            address(this),
            BootrLauncher.Deps({
                clanker: CLANKER,
                feeLocker: FEE_LOCKER,
                lpLocker: LP_LOCKER,
                staticHook: HOOK,
                devBuyExtension: DEV_BUY,
                mevModule: MEV,
                weth: WETH,
                usdc: USDC,
                identityRegistry: IDENTITY,
                kernelFactory: KERNEL_FACTORY,
                guardian: address(guardian),
                burnerImplementation: address(burnerImpl),
                universalRouter: UNIVERSAL_ROUTER,
                permit2: PERMIT2
            }),
            _defaults(false),
            _defaults(true),
            1000
        );
        guardian.setLauncher(address(launcher));
        guardian.setPlatformTreasury(treasury);

        deal(USDC, creator, 10_000e6);
        vm.deal(creator, 100 ether);
        vm.prank(creator);
        IERC20(USDC).approve(address(launcher), type(uint256).max);
    }

    function _defaults(bool buyback) internal view returns (BootrLauncher.LaunchDefaults memory) {
        return BootrLauncher.LaunchDefaults({
            lpFeeBps: 10_000,
            agentBps: 2000,
            creatorBps: buyback ? 3500 : 5000,
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
            metadata: '{"description":"test agent"}',
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

    /// @dev Lets the MEV block-delay module expire so swaps and fee collection work.
    function _passMevWindow() internal {
        vm.warp(vm.getBlockTimestamp() + 3 minutes);
        vm.roll(block.number + 5);
    }

    function _buy(address token, uint256 wethIn) internal {
        PoolKey memory key = launcher.poolKeyFor(token);
        vm.deal(trader, wethIn + 1 ether);
        vm.startPrank(trader);
        IWETH9(WETH).deposit{value: wethIn}();
        IWETH9(WETH).approve(POOL_SWAP_TEST, wethIn);
        bool zeroForOne = key.currency0 == WETH;
        IPoolSwapTest(POOL_SWAP_TEST)
            .swap(
                key,
                IPoolSwapTest.SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(wethIn),
                    sqrtPriceLimitX96: zeroForOne ? V4Constants.MIN_SQRT_PRICE + 1 : V4Constants.MAX_SQRT_PRICE - 1
                }),
                IPoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
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
        b.initialize(token, WETH, FEE_LOCKER, key, UNIVERSAL_ROUTER, PERMIT2);
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
        // token
        assertEq(IClankerToken(token).admin(), address(launcher), "tokenAdmin is launcher");
        assertEq(IERC20(token).totalSupply(), 100_000_000_000e18);
        IClanker.DeploymentInfo memory info = IClanker(CLANKER).tokenDeploymentInfo(token);
        assertEq(info.hook, HOOK);
        assertEq(info.locker, LP_LOCKER);

        // pool
        PoolKey memory key = launcher.poolKeyFor(token);
        bytes32 poolId = V4Constants.poolId(key);
        assertEq(IClankerHookStaticFee(HOOK).clankerFee(poolId), 10_000);
        assertEq(IClankerHookStaticFee(HOOK).pairedFee(poolId), 10_000);
        assertEq(IClankerHookV2(HOOK).locker(poolId), LP_LOCKER);

        // rewards: immutable split
        IClankerLpLocker.TokenRewardInfo memory r = IClankerLpLocker(LP_LOCKER).tokenRewards(token);
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
            assertEq(r.rewardAdmins[i], address(launcher), "rewardAdmin is launcher");
            sum += r.rewardBps[i];
        }
        assertEq(sum, 10_000);
        assertEq(r.rewardRecipients[0], kernel);
        assertEq(r.rewardBps[0], 2000);
        assertEq(r.rewardRecipients[1], creator);
        assertEq(r.rewardBps[1], buyback ? 3500 : 5000);
        if (buyback) {
            assertEq(r.rewardRecipients[2], burner);
            assertEq(r.rewardBps[2], 1500);
            assertEq(
                uint8(IClankerLpLockerFeeConversion(LP_LOCKER).feePreferences(token, 2)),
                uint8(IClankerLpLockerFeeConversion.FeeIn.Clanker)
            );
        }
        assertEq(r.rewardRecipients[n - 1], platformRecipient);
        assertEq(r.rewardBps[n - 1], 3000);
        assertEq(
            uint8(IClankerLpLockerFeeConversion(LP_LOCKER).feePreferences(token, 0)),
            uint8(IClankerLpLockerFeeConversion.FeeIn.Both)
        );

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
    // Fees
    // ------------------------------------------------------------------

    function test_swapAccruesFeesInRatio_standard() public {
        (address token, address kernel,,) = _launch(false, 0);
        _passMevWindow();
        uint256 wethIn = 1 ether;
        _buy(token, wethIn);

        // protocol (hook) fee of this swap sits as an ERC-6909 claim of the hook until the next swap
        uint256 protocolFee = IERC6909Balance(POOL_MANAGER).balanceOf(HOOK, uint256(uint160(WETH)));
        assertGt(protocolFee, 0);

        // pull LP fees from the position into the FeeLocker
        IClankerLpLocker(LP_LOCKER).collectRewards(token);
        uint256 fKernel = IClankerFeeLocker(FEE_LOCKER).availableFees(kernel, WETH);
        uint256 fCreator = IClankerFeeLocker(FEE_LOCKER).availableFees(creator, WETH);
        uint256 fPlatform = IClankerFeeLocker(FEE_LOCKER).availableFees(platformRecipient, WETH);
        uint256 lpTotal = fKernel + fCreator + fPlatform;
        assertGt(lpTotal, 0);

        // ratio 20 / 50 / 30 of the LP share (dust goes to the last recipient)
        assertApproxEqAbs(fKernel, lpTotal * 2000 / 10_000, 2);
        assertApproxEqAbs(fCreator, lpTotal * 5000 / 10_000, 2);
        assertApproxEqAbs(fPlatform, lpTotal * 3000 / 10_000, 2);

        // Clanker's hook adds a protocol fee equal to 20% of the LP fee (PROTOCOL_FEE_NUMERATOR = 200_000):
        // trader pays 1% LP fee + 0.2% protocol fee; recipients share 100% of the 1% (= 1/1.2 of the gross).
        assertApproxEqRel(protocolFee, lpTotal / 5, 0.01e18, "protocol fee = 20% of LP fee");
        assertApproxEqRel(lpTotal, (wethIn - protocolFee) / 100, 0.01e18, "LP fee = 1% of swapped input");
        assertApproxEqRel(lpTotal * 10_000 / (lpTotal + protocolFee), 8333, 0.01e18, "LP recipients get 1/1.2 of gross");

        // recipients receive by claiming (anyone may trigger the claim, funds go to the feeOwner)
        IClankerFeeLocker(FEE_LOCKER).claim(kernel, WETH);
        assertEq(IERC20(WETH).balanceOf(kernel), fKernel);
    }

    function test_swapAccruesFeesInRatio_buybackAndBurn() public {
        (address token, address kernel, address burner,) = _launch(true, 0);
        _passMevWindow();
        _buy(token, 1 ether);
        IClankerLpLocker(LP_LOCKER).collectRewards(token);

        uint256 fKernel = IClankerFeeLocker(FEE_LOCKER).availableFees(kernel, WETH);
        uint256 fCreator = IClankerFeeLocker(FEE_LOCKER).availableFees(creator, WETH);
        uint256 fPlatform = IClankerFeeLocker(FEE_LOCKER).availableFees(platformRecipient, WETH);
        uint256 fBurnerWeth = IClankerFeeLocker(FEE_LOCKER).availableFees(burner, WETH);
        uint256 fBurnerToken = IClankerFeeLocker(FEE_LOCKER).availableFees(burner, token);
        assertEq(fBurnerWeth, 0, "burner WETH share converted to token by the locker");
        assertGt(fBurnerToken, 0, "burner receives token");

        // the non-swapped recipients keep the 20/35/30 ratio among themselves
        uint256 distributed = fKernel + fCreator + fPlatform;
        assertApproxEqAbs(fKernel, distributed * 2000 / 8500, 2);
        assertApproxEqAbs(fCreator, distributed * 3500 / 8500, 2);
        assertApproxEqAbs(fPlatform, distributed * 3000 / 8500, 2);

        // burn it
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        uint256 burned = BuybackBurner(burner).burn();
        assertEq(burned, fBurnerToken);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, fBurnerToken);
        assertEq(IERC20(token).balanceOf(burner), 0);
        (uint256 pt, uint256 pw) = BuybackBurner(burner).pendingFees();
        assertEq(pt + pw, 0);
    }

    function test_burnerSwapAndBurnFallback() public {
        (address token,, address burner,) = _launch(true, 0);
        _passMevWindow();
        _buy(token, 0.1 ether);
        // stray WETH sent directly to the burner
        vm.deal(address(this), 1 ether);
        IWETH9(WETH).deposit{value: 0.05 ether}();
        IWETH9(WETH).transfer(burner, 0.05 ether);
        vm.expectRevert(); // unrealistic minOut -> the Universal Router reverts with V4TooLittleReceived
        BuybackBurner(burner).swapAndBurn(type(uint128).max);
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        (uint256 bought, uint256 burned) = BuybackBurner(burner).swapAndBurn(1);
        assertGt(bought, 0);
        assertGe(burned, bought);
        assertEq(IERC20(token).balanceOf(DEAD) - deadBefore, burned);
        assertEq(IERC20(WETH).balanceOf(burner), 0);
        vm.expectRevert(BuybackBurner.NothingToSwap.selector);
        BuybackBurner(burner).swapAndBurn(1);
    }

    // ------------------------------------------------------------------
    // Immutability of rewards
    // ------------------------------------------------------------------

    function test_launcherOwnerCannotChangeRewards() public {
        (address token,,,) = _launch(false, 0);
        address attacker = makeAddr("attacker");
        // only the rewardAdmin (= launcher) may update, and the launcher has no such function
        vm.prank(launcher.owner());
        vm.expectRevert();
        IClankerLpLocker(LP_LOCKER).updateRewardRecipient(token, 0, attacker);
        vm.prank(launcher.owner());
        vm.expectRevert();
        IClankerLpLocker(LP_LOCKER).updateRewardAdmin(token, 0, attacker);
        vm.prank(creator);
        vm.expectRevert();
        IClankerLpLocker(LP_LOCKER).updateRewardRecipient(token, 1, attacker);
        vm.prank(launcher.owner());
        vm.expectRevert();
        IClankerLpLockerFeeConversion(LP_LOCKER)
            .updateFeePreference(token, 0, IClankerLpLockerFeeConversion.FeeIn.Paired);
        // launcher exposes no pass-through
        (bool ok,) =
            address(launcher).call(abi.encodeCall(IClankerLpLocker.updateRewardRecipient, (token, 0, attacker)));
        assertFalse(ok);
        (ok,) = address(launcher).call(abi.encodeWithSignature("updateImage(string)", "x"));
        assertFalse(ok);
        IClankerLpLocker.TokenRewardInfo memory r = IClankerLpLocker(LP_LOCKER).tokenRewards(token);
        assertEq(
            r.rewardRecipients[0],
            guardian.agentInfo(r.rewardRecipients[0]).token == token ? r.rewardRecipients[0] : address(0)
        );
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

    function _signSession(PackedUserOperation memory op, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, entryPoint.getUserOpHash(op));
        return abi.encodePacked(bytes1(0xff), r, s, v); // 0xff = signer prefix (no policy signatures)
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

    /// @dev The exact four rules `apps/supervisor/src/session-key.ts` installs.
    function _callPolicyRules(address kernel) internal view returns (BootrCallPolicy.Rule[] memory rules) {
        rules = new BootrCallPolicy.Rule[](4);
        rules[0].target = FEE_LOCKER;
        rules[0].selector = IClankerFeeLocker.claim.selector;
        rules[0].args = new BootrCallPolicy.ArgRule[](1);
        rules[0].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(kernel))));
        rules[1].target = UNIVERSAL_ROUTER;
        rules[1].selector = bytes4(keccak256("execute(bytes,bytes[],uint256)"));
        rules[1].args = new BootrCallPolicy.ArgRule[](0);
        rules[2].target = USDC;
        rules[2].selector = IERC20.transfer.selector;
        rules[2].args = new BootrCallPolicy.ArgRule[](2);
        rules[2].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(payTo))));
        rules[2].args[1] = BootrCallPolicy.ArgRule(1, 2, bytes32(USDC_CAP));
        rules[3].target = WETH;
        rules[3].selector = IERC20.transfer.selector;
        rules[3].args = new BootrCallPolicy.ArgRule[](1);
        rules[3].args[0] = BootrCallPolicy.ArgRule(0, 1, bytes32(uint256(uint160(UNIVERSAL_ROUTER))));
    }

    function _callPolicyPermissionData(address kernel) internal view returns (bytes memory) {
        bytes[] memory enableData = new bytes[](2);
        enableData[0] =
            abi.encodePacked(NOT_FOR_VALIDATE_SIG, address(callPolicy), abi.encode(_callPolicyRules(kernel)));
        enableData[1] = abi.encodePacked(bytes2(0), ECDSA_SIGNER, sessionKey);
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

        // claim for someone else
        op = _userOp(
            kernel, _permissionNonce(kernel, 0x00), FEE_LOCKER, abi.encodeCall(IClankerFeeLocker.claim, (creator, WETH))
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
        // and some claimable fees for FeeLocker.claim(kernel, WETH)
        _passMevWindow();
        _buy(token, 0.5 ether);
        IClankerLpLocker(LP_LOCKER).collectRewards(token);
        uint256 claimable = IClankerFeeLocker(FEE_LOCKER).availableFees(kernel, WETH);
        assertGt(claimable, 0);

        // (c) batch: claim fees, pay the router, fund inference
        Execution[] memory execs = new Execution[](3);
        execs[0] = Execution(FEE_LOCKER, 0, abi.encodeCall(IClankerFeeLocker.claim, (kernel, WETH)));
        execs[1] = Execution(WETH, 0, abi.encodeCall(IERC20.transfer, (UNIVERSAL_ROUTER, 0.01 ether)));
        execs[2] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (payTo, 2e6)));
        PackedUserOperation memory op = _batchUserOp(kernel, _permissionNonce(kernel, 0x00), execs);
        op.signature = _signSession(op, sessionPk);
        assertTrue(_handle(op), "batch executed");
        assertEq(IERC20(WETH).balanceOf(kernel), 0.1 ether - 0.01 ether + claimable);
        assertEq(IERC20(USDC).balanceOf(payTo), 2e6);

        // a batch with one disallowed call is rejected as a whole
        execs = new Execution[](2);
        execs[0] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (payTo, 1)));
        execs[1] = Execution(USDC, 0, abi.encodeCall(IERC20.transfer, (creator, 1)));
        op = _batchUserOp(kernel, _permissionNonce(kernel, 0x00), execs);
        op.signature = _signSession(op, sessionPk);
        _sendExpectingPolicyFailed(op);
        assertEq(IERC20(USDC).balanceOf(payTo), 2e6);
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
        guardian.claimDormant(kernel);

        vm.warp(dormantAfter);
        uint256 deadBefore = IERC20(token).balanceOf(DEAD);
        (uint256 u, uint256 w, uint256 e, uint256 b) = guardian.claimDormant(kernel);
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
        guardian.claimDormant(kernel);
    }

    function test_activityResetsDormancyClock() public {
        (, address kernel,,) = _launch(false, 0);
        uint256 t0 = vm.getBlockTimestamp(); // via_ir can re-materialize block.timestamp across vm.warp
        vm.warp(t0 + 60 days);
        _installSession(kernel); // session-key userOp = activity at t0 + 60d
        assertEq(guardian.dormantAt(kernel), t0 + 60 days + DORMANCY);
        vm.warp(t0 + DORMANCY + 1 days); // would have been dormant without the activity
        vm.expectRevert(abi.encodeWithSelector(AgentGuardian.NotDormant.selector, t0 + 60 days + DORMANCY));
        guardian.claimDormant(kernel);
        vm.warp(t0 + 60 days + DORMANCY);
        (uint256 u,,,) = guardian.claimDormant(kernel);
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
