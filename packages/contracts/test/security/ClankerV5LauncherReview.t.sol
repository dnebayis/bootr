// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentGuardian} from "../../src/AgentGuardian.sol";
import {BootrClankerLauncher} from "../../src/BootrClankerLauncher.sol";
import {BootrClankerLauncherV5} from "../../src/BootrClankerLauncherV5.sol";
import {BootrLaunchGate} from "../../src/BootrLaunchGate.sol";
import {
    ClankerV5,
    IClankerV5Factory,
    IClankerV5FeeEscrow,
    IClankerV5Hook
} from "../../src/interfaces/IClankerV5.sol";
import {IKernel, IKernelFactory, KernelLib} from "../../src/interfaces/IKernel.sol";
import {V4Constants} from "../../src/interfaces/IUniswapV4.sol";
import {DeployClankerLauncherV5} from "../../script/DeployClankerLauncherV5.s.sol";

/// @dev The owner-only setters of Clanker's `TaxLaunchpadFactoryCore` the review exercises (verified source).
interface IClankerV5FactoryAdmin {
    function setProtocolFeeConfiguration(ClankerV5.ProtocolFeeConfiguration calldata configuration) external;
    function setTickSpacing(int24 newTickSpacing) external;
}

/// @notice Regression tests for the independent security review of `BootrClankerLauncherV5` (2026-11-11), against
///         Base mainnet state. Each `test_review_*` began as the reviewer's proof of one finding (or of one
///         property the review relied on); where the finding is fixed the same scenario now shows the attack
///         failing, and the comment says what used to happen.
///         RPC: `BASE_RPC_URL` env or https://mainnet.base.org.
contract ClankerV5LauncherReviewTest is Test {
    address constant FACTORY = 0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0;
    address constant HOOK = 0x5E320eA6278107968C119942E57d876c5F922AcC;
    address constant ESCROW = 0x5dd237d1f716C65426CCd2FAe82B95109825FA61;
    address constant TOKEN_DEPLOYER = 0xc25FfE6374EdcCb5bFCcA3b9684046a426AbCE6A;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH_USDC_500 = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    /// @dev Uniswap v3 WETH/USDC 0.04%: a real pool of the factory Clanker's adapter accepts, holding about
    ///      0.09 WETH and 67 USDC on 2026-11-11.
    address constant WETH_USDC_400 = 0x56C8989222ed293E3c4a22628d8BCA633cE1eb99;
    address constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant KERNEL_FACTORY = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant LIVE_V4_LAUNCHER = 0x387f1B0aC128D534E822c344D829645336BDAbbB;
    address constant NATIVE = address(0);
    BootrClankerLauncherV5.LaunchKind constant AGENT = BootrClankerLauncherV5.LaunchKind.Agent;

    AgentGuardian guardian;
    BootrLaunchGate gate;
    BootrClankerLauncherV5 launcher;
    IClankerV5Factory factory = IClankerV5Factory(FACTORY);
    IClankerV5Hook hook = IClankerV5Hook(HOOK);

    address platformRecipient = makeAddr("bootr.review.platformRecipient");
    address stranger = makeAddr("bootr.review.stranger");
    address thief = makeAddr("bootr.review.thief");
    address creator = makeAddr("bootr.review.creator");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        require(block.chainid == 8453, "not a Base mainnet fork");

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
            _defaults(500, 3000, platformRecipient),
            1000
        );
        launcher.setQuoteAllowed(AGENT, NATIVE, true);
        launcher.setQuoteAllowed(AGENT, USDC, true);
        launcher.setDevBuyRoute(USDC, WETH_USDC_500, 500);
        guardian.setLauncher(address(gate));
        gate.addLauncher(address(launcher));

        deal(USDC, creator, 10_000e6);
        vm.deal(creator, 100 ether);
        vm.prank(creator);
        IERC20(USDC).approve(address(launcher), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Fixture
    // ------------------------------------------------------------------

    function _defaults(uint16 agentBps, uint16 platformBps, address recipient)
        internal
        pure
        returns (BootrClankerLauncherV5.AgentDefaults memory)
    {
        return BootrClankerLauncherV5.AgentDefaults({
            agentShareBps: agentBps,
            platformShareBps: platformBps,
            platformRecipient: recipient,
            minFuelUsdc: 0,
            dormancyPeriod: 90 days,
            minTaxBps: 10_000,
            maxTaxBps: 50_000,
            maxRewardRows: 5
        });
    }

    function _params(uint256 devBuyWei) internal pure returns (BootrClankerLauncherV5.LaunchParams memory p) {
        p = BootrClankerLauncherV5.LaunchParams({
            name: "Review Coin",
            symbol: "RVW",
            image: "https://bootr.fun/images/review.png",
            metadata: '{"description":"security review","socialMediaUrls":[],"auditUrls":[]}',
            context: '{"interface":"Bootr","platform":"bootr.fun","id":"review"}',
            salt: bytes32(0),
            buybackBurn: false,
            fuelUsdc: 25e6,
            devBuyWei: devBuyWei,
            workerHash: keccak256("worker"),
            model: "model",
            agentURI: "https://bootr.fun/agents/review.json",
            supervisorSessionKey: address(0)
        });
    }

    /// @dev The form's defaults: 1.5% both ways, everything to creator funds, one row for the creator. The
    ///      dev-buy minimum is the smallest the launcher admits; the dev-buy test sets a real one.
    function _settings(address quote) internal view returns (BootrClankerLauncherV5.TokenSettings memory s) {
        s.quoteToken = quote;
        s.minDevBuyOut = 1;
        s.expectedConfigVersion = factory.configVersion();
        s.buyTaxBps = 15_000;
        s.sellTaxBps = 15_000;
        s.rewards = new BootrClankerLauncherV5.RewardInput[](1);
        s.rewards[0] = BootrClankerLauncherV5.RewardInput({recipient: creator, admin: creator, bps: 10_000});
        s.antiSnipe = true;
        s.metadataEditable = true;
        s.contractURI = "https://bootr.fun/tokens/review.json";
    }

    /// @dev The web's salt mining (same search as test/fork/ClankerV5Fork.t.sol), for any launcher address.
    function _mineSalt(
        BootrClankerLauncherV5 l,
        address who,
        BootrClankerLauncherV5.LaunchParams memory p,
        BootrClankerLauncherV5.TokenSettings memory s
    ) internal view returns (bytes32 salt) {
        bytes32 initCodeHash = l.tokenInitCodeHash(p, s);
        address self = address(l);
        address deployer = TOKEN_DEPLOYER;
        bool found;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, who)
            mstore(add(ptr, 0x40), self)
            mstore8(add(ptr, 0x80), 0xff)
            mstore(add(ptr, 0x81), shl(96, deployer))
            mstore(add(ptr, 0xb5), initCodeHash)
            for { let i := 0 } lt(i, 4000000) { i := add(i, 1) } {
                mstore(0x00, 0x7e71e7)
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

    function _poolIdOf(address token) internal view returns (bytes32) {
        return factory.creatorRights(token).poolId;
    }

    // ------------------------------------------------------------------
    // Fixed (M1): the dev buy carries the creator's minimum output, and the owner-set first hop is bound to the
    // Uniswap v3 factory's own pool at a fee of 0.3% or less
    // ------------------------------------------------------------------

    /// @notice The same 1 ETH dev buy into a USDC-paired coin: the creator quotes it through the 0.05% pool and
    ///         signs with a 5% tolerance. The owner then points the route at another real Uniswap v3 WETH/USDC
    ///         pool with almost no liquidity (the 0.04% tier; the contract cannot judge depth, so the setter
    ///         admits it). The launch used to go through with under 5% of the coins (`minAmountOut` was 1); now
    ///         it reverts and the creator keeps the ETH. Back on the deep pool the same signed launch succeeds.
    function test_review_devBuyThroughAThinRouteRevertsUnderTheCreatorsMinimum() public {
        BootrClankerLauncherV5.LaunchParams memory p = _params(1 ether);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(USDC);
        p.salt = _mineSalt(launcher, creator, p, s);

        // the quote the web takes before signing: what the route delivers now
        uint256 snap = vm.snapshotState();
        vm.prank(creator);
        (address token,,,) = launcher.launch{value: 1 ether}(p, s);
        uint256 coinsThroughDeepPool = IERC20(token).balanceOf(creator);
        vm.revertToState(snap);
        s.minDevBuyOut = coinsThroughDeepPool * 95 / 100;

        // a dev buy without a minimum is no longer accepted at all
        BootrClankerLauncherV5.TokenSettings memory unprotected = _settings(USDC);
        unprotected.minDevBuyOut = 0;
        vm.prank(creator);
        vm.expectRevert(BootrClankerLauncherV5.MinDevBuyOutRequired.selector);
        launcher.launch{value: 1 ether}(p, unprotected);

        // a pool that is not Uniswap v3's own WETH/USDC pool at that fee cannot be set (a typo, a hostile pool)
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteNotFactoryPool.selector);
        launcher.setDevBuyRoute(USDC, WETH_USDC_400, 500);
        vm.expectRevert(BootrClankerLauncherV5.DevBuyRouteNotFactoryPool.selector);
        launcher.setDevBuyRoute(USDC, thief, 400);

        // the thin pool is a real factory pool, so the owner key can still select it
        launcher.setDevBuyRoute(USDC, WETH_USDC_400, 400);
        uint256 thinPoolUsdcBefore = IERC20(USDC).balanceOf(WETH_USDC_400);
        uint256 creatorEthBefore = creator.balance;
        vm.prank(creator);
        vm.expectRevert();
        launcher.launch{value: 1 ether}(p, s);
        assertEq(creator.balance, creatorEthBefore, "the creator's ETH never left");
        assertEq(IERC20(USDC).balanceOf(WETH_USDC_400), thinPoolUsdcBefore, "the thin pool was not traded");
        assertEq(token.code.length, 0, "no coin was created");

        // the same signed launch goes through once the route is the deep pool again
        launcher.setDevBuyRoute(USDC, WETH_USDC_500, 500);
        vm.prank(creator);
        (address token2,,,) = launcher.launch{value: 1 ether}(p, s);
        assertEq(token2, token, "same launch, same coin");
        assertGe(IERC20(token2).balanceOf(creator), s.minDevBuyOut, "at least the signed minimum");
        assertEq(creatorEthBefore - creator.balance, 1 ether);
        assertEq(IERC20(WETH).balanceOf(address(launcher)), 0);
        console2.log("coins for 1 ETH through the 0.05% pool:", coinsThroughDeepPool / 1e18);
        console2.log("the signed minimum (95%):              ", s.minDevBuyOut / 1e18);
    }

    // ------------------------------------------------------------------
    // Fixed (M2): the creator's signed launch carries the Clanker config version the creator read, so Clanker's
    // own stale-config guard stops a launch under any other policy
    // ------------------------------------------------------------------

    /// @notice A creator mines the salt and signs under today's policy (Clanker keeps 0.5% of a 1.5% tax, the
    ///         slots share 1%). Before the transaction lands Clanker's owner raises its share to 99% of the tax.
    ///         The launcher used to pass the live version, so the launch succeeded and the coin's slots shared
    ///         0.015% of each trade for good. Now the launch reverts `StaleConfig`; the creator re-reads the
    ///         policy, and a launch under the policy that was signed keeps the 1%.
    function test_review_clankerPolicyChangeBetweenSigningAndLaunchReverts() public {
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        p.salt = _mineSalt(launcher, creator, p, s);
        uint64 versionWhenSigned = factory.configVersion();
        assertEq(s.expectedConfigVersion, versionWhenSigned, "what the creator signed");
        ClankerV5.ProtocolFeeConfiguration memory live = factory.taxPolicy().protocolFeeConfiguration;

        // a copy of its own (assigning the memory struct would alias `live`)
        ClankerV5.ProtocolFeeConfiguration memory raised = ClankerV5.ProtocolFeeConfiguration({
            protocolTaxShare: 99_000_000,
            minimumProtocolFeeRate: live.minimumProtocolFeeRate,
            maximumProtocolFeeRate: 99_000_000,
            protocolFeeRecipient: live.protocolFeeRecipient
        });
        vm.prank(factory.owner());
        IClankerV5FactoryAdmin(FACTORY).setProtocolFeeConfiguration(raised);
        uint64 versionAfter = factory.configVersion();
        assertGt(versionAfter, versionWhenSigned, "Clanker bumped its config version");

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IClankerV5Factory.StaleConfig.selector, versionWhenSigned, versionAfter)
        );
        launcher.launch(p, s);
        assertEq(launcher.predictToken(creator, p, s).code.length, 0, "no coin under the raised policy");
        assertEq(launcher.predictKernel(creator, p.salt).code.length, 0, "and no kernel");

        // Clanker puts its numbers back; that is one more version, so the old signature stays refused
        vm.prank(factory.owner());
        IClankerV5FactoryAdmin(FACTORY).setProtocolFeeConfiguration(live);
        vm.prank(creator);
        vm.expectPartialRevert(IClankerV5Factory.StaleConfig.selector);
        launcher.launch(p, s);

        // the creator reads the policy again and signs under it: the coin's slots share the 1% that was shown
        s.expectedConfigVersion = factory.configVersion();
        vm.prank(creator);
        (address token,,,) = launcher.launch(p, s);
        vm.warp(vm.getBlockTimestamp() + 21);
        (ClankerV5.Rates memory buy,) = hook.effectiveFeeRates(_poolIdOf(token), true);
        assertEq(buy.protocolRate, 500_000 * 1e16, "Clanker: 0.5% of every trade");
        assertEq(buy.creatorRate, 1_000_000 * 1e16, "all slots together: 1% of every trade, as signed");
    }

    // ------------------------------------------------------------------
    // Finding: the launcher's own terms can change between signing and inclusion, with no bound from the creator
    // ------------------------------------------------------------------

    /// @notice The creator previews 500 / 3000 / 6500 and sends 1 ETH expecting it back (no fee, no dev buy). The
    ///         owner raises the platform share to 45% and sets a 0.5 ETH launch fee first: the launch succeeds with
    ///         the creator's row at 5000 and half an ETH gone to the platform recipient.
    function test_review_ownerChangesSharesAndFeeAheadOfAPendingLaunch() public {
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        p.salt = _mineSalt(launcher, creator, p, s);
        uint16[] memory previewed = launcher.previewSlotWeights(s);
        assertEq(previewed[2], 6500);

        launcher.setAgentDefaults(_defaults(500, 4500, platformRecipient));
        launcher.setLaunchFee(0.5 ether);

        uint256 before = creator.balance;
        vm.prank(creator);
        (address token,,,) = launcher.launch{value: 1 ether}(p, s);
        ClankerV5.FeeSlot[] memory slots = hook.poolFeeSlots(_poolIdOf(token));
        assertEq(slots[1].weightBps, 4500, "platform");
        assertEq(slots[2].weightBps, 5000, "the creator's row, previewed at 6500");
        assertEq(before - creator.balance, 0.5 ether, "a fee the creator never saw");
        assertEq(platformRecipient.balance, 0.5 ether);
    }

    // ------------------------------------------------------------------
    // Finding: poolKeyFor(token) reads Clanker's live tick spacing, not the coin's
    // ------------------------------------------------------------------

    function test_review_poolKeyForBreaksWhenClankerChangesTickSpacing() public {
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        p.salt = _mineSalt(launcher, creator, p, s);
        vm.prank(creator);
        (address token,,,) = launcher.launch(p, s);
        bytes32 poolId = _poolIdOf(token);
        assertEq(V4Constants.poolId(launcher.poolKeyFor(token)), poolId, "right today");

        vm.prank(factory.owner());
        IClankerV5FactoryAdmin(FACTORY).setTickSpacing(100);
        assertTrue(V4Constants.poolId(launcher.poolKeyFor(token)) != poolId, "wrong key for a coin already launched");
    }

    // ------------------------------------------------------------------
    // Finding: the deploy script leaves the deployer key as owner until the admin accepts
    // ------------------------------------------------------------------

    /// @notice Runs `DeployClankerLauncherV5` against the live v4 launcher, gate and guardian. After the script the
    ///         owner is still the deployer (the admin is only pending). If the admin adds the launcher to the gate
    ///         before accepting, the deployer key alone can redirect the platform slot and the launch fee of every
    ///         coin launched from then on. The same run shows the script's values work against the live system.
    function test_review_deployScriptLeavesDeployerAsOwnerUntilAccept() public {
        BootrClankerLauncher v4 = BootrClankerLauncher(LIVE_V4_LAUNCHER);
        address admin = v4.owner();
        BootrLaunchGate liveGate = v4.gate();
        AgentGuardian liveGuardian = v4.guardian();
        assertEq(liveGate.owner(), admin, "the gate's owner is the platform admin");

        uint256 deployerKey = uint256(keccak256("bootr.review.deployer"));
        address deployer = vm.addr(deployerKey);
        vm.deal(deployer, 1 ether);
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(deployerKey)));
        vm.setEnv("PLATFORM_ADMIN", vm.toString(admin));
        vm.setEnv("OLD_CLANKER_LAUNCHER", vm.toString(LIVE_V4_LAUNCHER));
        BootrClankerLauncherV5 v5 = BootrClankerLauncherV5(vm.computeCreateAddress(deployer, vm.getNonce(deployer)));
        new DeployClankerLauncherV5().run();

        assertGt(address(v5).code.length, 0, "deployed where predicted");
        assertEq(v5.owner(), deployer, "the deployer key still owns the launcher");
        assertEq(v5.pendingOwner(), admin, "the admin has not accepted yet");
        (uint16 agentBps, uint16 platformBps, address recipient,,, uint24 lo, uint24 hi, uint8 rows) = v5.agentDefaults();
        assertEq(agentBps, 500);
        assertEq(platformBps, 3000);
        assertEq(lo, 10_000);
        assertEq(hi, 50_000);
        assertEq(rows, 5);
        assertEq(recipient.code.length, 0, "the platform recipient frozen into every coin is a plain key today");
        assertTrue(v5.allowedQuote(AGENT, NATIVE) && v5.allowedQuote(AGENT, USDC));
        assertEq(address(v5.gate()), address(liveGate));

        // launches are closed until the admin opens the gate
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        p.salt = _mineSalt(v5, creator, p, s);
        uint256 fee = v5.launchFeeWei();
        vm.prank(creator);
        IERC20(USDC).approve(address(v5), type(uint256).max);
        vm.prank(creator);
        vm.expectRevert(BootrLaunchGate.NotLauncher.selector);
        v5.launch{value: fee}(p, s);

        // the admin opens the gate without accepting ownership first
        vm.prank(admin);
        liveGate.addLauncher(address(v5));

        // whoever holds the deployer key now sets the platform recipient of every future coin
        vm.prank(deployer);
        v5.setAgentDefaults(_defaults(500, 4500, thief));
        vm.prank(creator);
        (address token, address kernel,,) = v5.launch{value: fee}(p, s);
        ClankerV5.FeeSlot[] memory slots = hook.poolFeeSlots(_poolIdOf(token));
        assertEq(slots[1].recipient, thief, "the platform slot of this coin pays the key holder, for good");
        assertEq(slots[1].admin, address(v5));
        assertEq(thief.balance, fee, "and so does the launch fee");
        assertTrue(liveGuardian.isRegistered(kernel), "registered on the live guardian through the live gate");
    }

    // ------------------------------------------------------------------
    // Checked and sound
    // ------------------------------------------------------------------

    /// @notice A stranger who learns the creator's salt deploys the kernel first (the Kernel factory is open to
    ///         anyone). The launch still goes through on the same kernel, with the guardian as its root.
    function test_review_strangerPrecreatingTheKernelDoesNotBlockOrHijack() public {
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        p.salt = _mineSalt(launcher, creator, p, s);
        address predicted = launcher.predictKernel(creator, p.salt);

        bytes memory initData = abi.encodeCall(
            IKernel.initialize,
            (KernelLib.validatorId(address(guardian)), address(guardian), bytes(""), hex"00", new bytes[](0))
        );
        vm.prank(stranger);
        address squatted =
            IKernelFactory(KERNEL_FACTORY).createAccount(initData, keccak256(abi.encode(creator, p.salt)));
        assertEq(squatted, predicted, "the stranger deployed the creator's kernel");
        assertFalse(guardian.isRegistered(predicted));

        vm.prank(creator);
        (address token, address kernel,,) = launcher.launch(p, s);
        assertEq(kernel, predicted);
        assertEq(IKernel(kernel).rootValidator(), KernelLib.validatorId(address(guardian)));
        assertEq(guardian.agentInfo(kernel).creator, creator);
        assertEq(guardian.agentInfo(kernel).token, token);
        assertEq(hook.poolFeeSlots(_poolIdOf(token))[0].recipient, kernel);
    }

    /// @notice A stranger cannot launch on a creator's salt: the same parameters from another wallet give another
    ///         token address (not ending in 0xcccc), and the creator's own launch is untouched afterwards.
    function test_review_strangerCannotUseTheCreatorsSalt() public {
        BootrClankerLauncherV5.LaunchParams memory p = _params(0);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        p.fuelUsdc = 0;
        p.salt = _mineSalt(launcher, creator, p, s);
        address predicted = launcher.predictToken(creator, p, s);

        vm.prank(stranger);
        vm.expectPartialRevert(IClankerV5Factory.InvalidTokenAddressSuffix.selector);
        launcher.launch(p, s);

        vm.prank(creator);
        (address token,,,) = launcher.launch(p, s);
        assertEq(token, predicted);
        assertEq(launcher.coinCreator(token), creator);
    }

    /// @notice Money in and out of one launch with a dev buy and a launch fee: the launcher ends with no ETH, no
    ///         WETH, no USDC and none of the coin; the kernel's fee share from the dev buy is claimable as plain
    ///         ETH by anyone and lands on the kernel.
    function test_review_nothingStaysOnTheLauncherAndTheKernelIsPaidInEth() public {
        launcher.setLaunchFee(0.0005 ether);
        BootrClankerLauncherV5.LaunchParams memory p = _params(0.5 ether);
        BootrClankerLauncherV5.TokenSettings memory s = _settings(NATIVE);
        p.salt = _mineSalt(launcher, creator, p, s);

        uint256 before = creator.balance;
        uint256 usdcBefore = IERC20(USDC).balanceOf(creator);
        vm.prank(creator);
        (address token, address kernel,,) = launcher.launch{value: 2 ether}(p, s);

        assertEq(before - creator.balance, 0.5 ether + 0.0005 ether, "dev buy + fee, the rest refunded");
        assertEq(platformRecipient.balance, 0.0005 ether);
        assertEq(usdcBefore - IERC20(USDC).balanceOf(creator), 25e6);
        assertEq(IERC20(USDC).balanceOf(kernel), 25e6);
        assertEq(address(launcher).balance, 0);
        assertEq(IERC20(WETH).balanceOf(address(launcher)), 0);
        assertEq(IERC20(USDC).balanceOf(address(launcher)), 0);
        assertEq(IERC20(token).balanceOf(address(launcher)), 0);
        assertGt(IERC20(token).balanceOf(creator), 0);

        uint256 owed = IClankerV5FeeEscrow(ESCROW).owed(kernel, NATIVE);
        assertGt(owed, 0, "the dev buy paid the buy tax: the agent's slot was credited");
        vm.prank(stranger);
        IClankerV5FeeEscrow(ESCROW).claimFor(kernel, NATIVE);
        assertEq(kernel.balance, owed);
    }
}
