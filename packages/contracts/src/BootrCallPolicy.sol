// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Execution, PackedUserOperation} from "./interfaces/IKernel.sol";

/// @title BootrCallPolicy
/// @notice ERC-7579 policy module (module type 5) for ZeroDev Kernel v3.1 permissions. It is a
///         pure allow-list over the calls a session key may make through `Kernel.execute`, plus a
///         windowed spend cap for the one money rule (`USDC.transfer(spender, …)`).
///
/// Why not ZeroDev's CallPolicy: Bootr session permissions carry the `AgentGuardian` as hook, so
/// the Kernel requires every session userOp's callData to be
/// `executeUserOp.selector ‖ execute(bytes32 mode, bytes executionCalldata)`. ZeroDev's CallPolicy
/// v0.0.5 cannot parse the `executeUserOp` wrapper and reverts; this module strips it.
///
/// Rules are stored per `(permission id, kernel)` at install time:
///   `initData = abi.encode(Rule[])`, `Rule = (address target, bytes4 selector, uint32 windowSeconds, ArgRule[] args)`,
///   `ArgRule = (uint8 index, uint8 op, bytes32 value)` on the static word at `4 + 32 * index`
///   (`op` 1 = EQUAL as bytes32, 2 = LESS_THAN_OR_EQUAL as uint256, 3 = SUM_PER_WINDOW as uint256).
/// A userOp passes only if every call it executes has `value == 0`, at least a 4-byte selector,
/// and matches at least one rule (target, selector and every argument rule). Delegatecall and any
/// other call type fail. Policy failures return `SIG_VALIDATION_FAILED` (1) and never revert, so
/// the Kernel reports them as `PolicyFailed(i)`.
///
/// `LESS_THAN_OR_EQUAL` and `SUM_PER_WINDOW` bounds are cumulative per userOp: in a batch, the words
/// of every call that matched the same rule are summed per argument rule and the SUM must stay
/// `<= value` (a batch of `k` calls `USDC.transfer(to, cap)` therefore fails for `k >= 2`; finding
/// M-02). The first rule a call matches is the one it is accounted against.
///
/// ## SUM_PER_WINDOW (cumulative cap per rolling window)
///
/// A `SUM_PER_WINDOW` argument additionally keeps `(uint48 windowEnd, uint128 spent)` per
/// `(id, kernel, rule, arg)`. Windows are a fixed grid anchored at install
/// (`windowEnd = install time + windowSeconds`, `windowSeconds` from the rule). Validation may not read
/// `block.timestamp` (ERC-7562), so the current window is learned the way ZeroDev's RateLimitPolicy
/// does: from the EntryPoint's time check on the returned `validAfter` / `validUntil`.
///   * The session signer tells the policy the current time in its policy-signature slot
///     (`abi.encode(uint256 now)`, 32 bytes; Kernel hands it over as `userOp.signature`). If
///     `now >= windowEnd` the window grid is advanced to the one containing `now` and `spent` resets.
///   * `spent + v > cap` fails (`PolicyFailed`). Otherwise `spent += v` and the policy returns
///     `validAfter = windowEnd - windowSeconds`, `validUntil = windowEnd`.
///   A lie about `now` cannot help: claiming the future selects a window whose `validAfter` the
///   EntryPoint rejects as "not due"; claiming the past keeps a window whose `validUntil` it rejects
///   as "expired" (and the state change is rolled back with the failed validation). Without the slot
///   the current window is kept, which is correct until it lapses. Only calls that spend (`v > 0`)
///   touch a window, so claims and swaps carry no time bound.
///
/// ## Storage layout and ERC-7562 (strict bundlers)
///
/// `checkUserOpPolicy` runs inside the EntryPoint validation phase. ERC-7562 lets an unstaked
/// sender touch only its *associated storage*: slots `keccak256(A ‖ X) + n` with `A` the 32-byte
/// padded sender address and `n < 128`, i.e. a `mapping(address => fixedStruct)` keyed by the
/// kernel, possibly nested under another mapping. Dynamic arrays and `bytes` add another keccak
/// level and count as foreign storage, which strict bundlers (Coinbase CDP, Pimlico/Alto, the
/// reference bundler) reject at `eth_sendUserOperation` with an opcode/storage validation error.
///
/// The rules therefore live in a FIXED-SIZE struct under `mapping(bytes32 id => mapping(address
/// kernel => Config))` (declared in slot 0): the id is the outer key and the kernel the inner one,
/// so the struct starts at `keccak256(kernel ‖ keccak256(id ‖ 0))` and every slot it uses is of the
/// associated form. Slot count of `Config` (must stay < 128):
///   * header (`status`, `ruleCount`, packed)                                           1 slot
///   * `StoredRule` = header (`target`, `selector`, `argCount`, `windowSeconds`, packed) 1 slot
///                  + `StoredArg[MAX_ARGS]` of 2 slots each
///                    (`index`/`op`/`windowEnd`/`spent` packed, `value`)                  8 slots
///                  = 9 slots
///   * `StoredRule[MAX_RULES]` = 8 * 9                                                    72 slots
///   total                                                                               73 slots (< 128)
/// `checkUserOpPolicy` reads and writes nothing outside this struct (window state is associated
/// storage too; ERC-7562 allows writes there) and uses no banned opcodes (no `TIMESTAMP`, `NUMBER`,
/// `GAS`, `BALANCE`, external calls). `test_validationTouchesOnlyAssociatedStorage` pins the property
/// with `vm.record()`. `installedCount` (for `isInitialized`) is only touched on install / uninstall.
///
/// No owner, no upgradeability, no external calls.
contract BootrCallPolicy {
    // ------------------------------------------------------------------
    // Types (external ABI)
    // ------------------------------------------------------------------

    struct ArgRule {
        /// @dev Static argument index: the 32-byte word at `4 + 32 * index` of the call data.
        uint8 index;
        /// @dev `OP_EQUAL`, `OP_LESS_THAN_OR_EQUAL` or `OP_SUM_PER_WINDOW`.
        uint8 op;
        bytes32 value;
    }

    struct Rule {
        address target;
        bytes4 selector;
        /// @dev Window length of this rule's `OP_SUM_PER_WINDOW` arguments (required when one exists).
        uint32 windowSeconds;
        ArgRule[] args;
    }

    // ------------------------------------------------------------------
    // Types (storage; fixed size, see the contract NatSpec)
    // ------------------------------------------------------------------

    /// @notice Maximum rules per `(id, kernel)` and argument rules per rule (fixed storage).
    uint256 public constant MAX_RULES = 8;
    uint256 public constant MAX_ARGS = 4;

    /// @dev 2 slots: `index`, `op`, `windowEnd`, `spent` share slot 0 (24 bytes), `value` is slot 1.
    struct StoredArg {
        uint8 index;
        uint8 op;
        uint48 windowEnd;
        uint128 spent;
        bytes32 value;
    }

    /// @dev 1 + 2 * MAX_ARGS = 9 slots.
    struct StoredRule {
        address target;
        bytes4 selector;
        uint8 argCount;
        uint32 windowSeconds;
        StoredArg[MAX_ARGS] args;
    }

    /// @dev 1 + 9 * MAX_RULES = 73 slots.
    struct Config {
        /// @dev `STATUS_INSTALLED` once `onInstall` succeeded, 0 otherwise.
        uint8 status;
        uint8 ruleCount;
        StoredRule[MAX_RULES] rules;
    }

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint256 public constant MODULE_TYPE_POLICY = 5;
    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    uint8 public constant OP_EQUAL = 1;
    uint8 public constant OP_LESS_THAN_OR_EQUAL = 2;
    uint8 public constant OP_SUM_PER_WINDOW = 3;

    /// @notice Storage slots used by one `Config` (documented bound for ERC-7562: must be < 128).
    uint256 public constant CONFIG_SLOTS = 1 + MAX_RULES * (1 + 2 * MAX_ARGS);
    /// @notice Length of the policy-signature slot carrying the current time (`abi.encode(uint256)`).
    uint256 public constant TIME_SIG_LENGTH = 32;

    uint8 internal constant STATUS_INSTALLED = 1;

    /// @dev `IAccountExecute.executeUserOp(PackedUserOperation,bytes32)`.
    bytes4 internal constant EXECUTE_USER_OP_SELECTOR = 0x8dd7712f;
    /// @dev `Kernel.execute(bytes32,bytes)`.
    bytes4 internal constant EXECUTE_SELECTOR = 0xe9ae5c53;
    bytes1 internal constant CALLTYPE_SINGLE = 0x00;
    bytes1 internal constant CALLTYPE_BATCH = 0x01;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @dev Slot 0. Rules per permission id per kernel (`msg.sender` of `onInstall`). Keep this the
    ///      first state variable: tests derive the associated-storage base from slot 0.
    mapping(bytes32 id => mapping(address kernel => Config)) internal _configs;
    /// @dev Number of installed permission ids per kernel (for `isInitialized`). Never read in
    ///      `checkUserOpPolicy`.
    mapping(address kernel => uint256) public installedCount;

    // ------------------------------------------------------------------
    // Errors / events
    // ------------------------------------------------------------------

    error AlreadyInstalled(bytes32 id, address kernel);
    error NotInstalled(bytes32 id, address kernel);
    error InvalidInstallData();
    error NoRules();
    error InvalidOp(uint8 op);
    error TooManyRules(uint256 count, uint256 max);
    error TooManyArgs(uint256 ruleIndex, uint256 count, uint256 max);
    error WindowRequired(uint256 ruleIndex);
    error CapTooLarge(uint256 ruleIndex, uint256 argIndex);

    event RulesInstalled(bytes32 indexed id, address indexed kernel, uint256 ruleCount);
    event RulesUninstalled(bytes32 indexed id, address indexed kernel);

    // ------------------------------------------------------------------
    // ERC-7579 module lifecycle (called by the Kernel)
    // ------------------------------------------------------------------

    /// @notice Installs the rules for a permission. `data = bytes32 id ‖ abi.encode(Rule[])`.
    ///         The id is the 4-byte Kernel permission id left-aligned in 32 bytes. At most
    ///         `MAX_RULES` rules with at most `MAX_ARGS` argument rules each. `SUM_PER_WINDOW`
    ///         arguments need `windowSeconds > 0` and a cap that fits `uint128`; their first window
    ///         ends at `block.timestamp + windowSeconds` (install is not the validation path).
    function onInstall(bytes calldata data) external payable {
        if (data.length < 32) revert InvalidInstallData();
        bytes32 id = bytes32(data[:32]);
        Config storage config = _configs[id][msg.sender];
        if (config.status == STATUS_INSTALLED) revert AlreadyInstalled(id, msg.sender);
        Rule[] memory rules = abi.decode(data[32:], (Rule[]));
        uint256 ruleCount = rules.length;
        if (ruleCount == 0) revert NoRules();
        if (ruleCount > MAX_RULES) revert TooManyRules(ruleCount, MAX_RULES);
        for (uint256 i; i < ruleCount; ++i) {
            Rule memory rule = rules[i];
            uint256 argCount = rule.args.length;
            if (argCount > MAX_ARGS) revert TooManyArgs(i, argCount, MAX_ARGS);
            StoredRule storage stored = config.rules[i];
            stored.target = rule.target;
            stored.selector = rule.selector;
            stored.argCount = uint8(argCount);
            stored.windowSeconds = rule.windowSeconds;
            for (uint256 j; j < argCount; ++j) {
                ArgRule memory arg = rule.args[j];
                if (arg.op != OP_EQUAL && arg.op != OP_LESS_THAN_OR_EQUAL && arg.op != OP_SUM_PER_WINDOW) {
                    revert InvalidOp(arg.op);
                }
                uint48 windowEnd;
                if (arg.op == OP_SUM_PER_WINDOW) {
                    if (rule.windowSeconds == 0) revert WindowRequired(i);
                    if (uint256(arg.value) > type(uint128).max) revert CapTooLarge(i, j);
                    windowEnd = uint48(block.timestamp + rule.windowSeconds);
                }
                stored.args[j] = StoredArg({index: arg.index, op: arg.op, windowEnd: windowEnd, spent: 0, value: arg.value});
            }
        }
        config.ruleCount = uint8(ruleCount);
        config.status = STATUS_INSTALLED;
        installedCount[msg.sender] += 1;
        emit RulesInstalled(id, msg.sender, ruleCount);
    }

    /// @notice Deletes the rules for a permission. `data = bytes32 id ‖ anything`. Idempotent so a
    ///         revocation never gets stuck on this module. Not in the validation path, so it may loop.
    function onUninstall(bytes calldata data) external payable {
        if (data.length < 32) revert InvalidInstallData();
        bytes32 id = bytes32(data[:32]);
        Config storage config = _configs[id][msg.sender];
        if (config.status != STATUS_INSTALLED) return;
        uint256 ruleCount = config.ruleCount;
        for (uint256 i; i < ruleCount; ++i) {
            StoredRule storage stored = config.rules[i];
            uint256 argCount = stored.argCount;
            for (uint256 j; j < argCount; ++j) {
                delete stored.args[j];
            }
            delete stored.target;
            delete stored.selector;
            delete stored.argCount;
            delete stored.windowSeconds;
        }
        config.ruleCount = 0;
        config.status = 0;
        installedCount[msg.sender] -= 1;
        emit RulesUninstalled(id, msg.sender);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_POLICY;
    }

    function isInitialized(address kernel) external view returns (bool) {
        return installedCount[kernel] != 0;
    }

    // ------------------------------------------------------------------
    // Policy checks (called by the Kernel)
    // ------------------------------------------------------------------

    /// @notice Validates `userOp.callData` against the rules of `(id, msg.sender)` and accounts the
    ///         `SUM_PER_WINDOW` spends. `userOp.signature` is this policy's signature slot: empty, or
    ///         `abi.encode(uint256 now)` (the signer's claim of the current time, see the NatSpec).
    /// @dev Validation phase: touches only `_configs[id][msg.sender]` (associated storage, ERC-7562).
    /// @return 0 (optionally with `validAfter` / `validUntil` packed ERC-4337 style) if every call is
    ///         allowed and within budget, 1 (`SIG_VALIDATION_FAILED`) otherwise.
    function checkUserOpPolicy(bytes32 id, PackedUserOperation calldata userOp) external payable returns (uint256) {
        Config storage config = _configs[id][msg.sender];
        if (config.status != STATUS_INSTALLED) revert NotInstalled(id, msg.sender);
        (bool ok, uint256[MAX_RULES * MAX_ARGS] memory sums) = _checkCallData(config, userOp.callData);
        if (!ok) return SIG_VALIDATION_FAILED;
        uint256 claimedNow;
        bytes calldata slot = userOp.signature;
        if (slot.length == TIME_SIG_LENGTH) {
            claimedNow = uint256(bytes32(slot));
            if (claimedNow > type(uint48).max) return SIG_VALIDATION_FAILED; // cannot be a real time
        }
        return _applyWindows(config, sums, claimedNow);
    }

    /// @notice ERC-1271 path: this policy does not gate signatures (the supervisor installs it with
    ///         `NOT_FOR_VALIDATE_SIG`; production permissions skip the signature path entirely).
    function checkSignaturePolicy(bytes32, address, bytes32, bytes calldata) external pure returns (uint256) {
        return SIG_VALIDATION_SUCCESS;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Whether `(id, kernel)` is installed.
    function installed(bytes32 id, address kernel) external view returns (bool) {
        return _configs[id][kernel].status == STATUS_INSTALLED;
    }

    /// @notice Rules installed for `(id, kernel)` in the external `Rule[]` shape (empty when not installed).
    function rulesOf(bytes32 id, address kernel) external view returns (Rule[] memory rules) {
        Config storage config = _configs[id][kernel];
        if (config.status != STATUS_INSTALLED) return rules;
        uint256 ruleCount = config.ruleCount;
        rules = new Rule[](ruleCount);
        for (uint256 i; i < ruleCount; ++i) {
            StoredRule storage stored = config.rules[i];
            uint256 argCount = stored.argCount;
            ArgRule[] memory args = new ArgRule[](argCount);
            for (uint256 j; j < argCount; ++j) {
                StoredArg storage arg = stored.args[j];
                args[j] = ArgRule({index: arg.index, op: arg.op, value: arg.value});
            }
            rules[i] = Rule({target: stored.target, selector: stored.selector, windowSeconds: stored.windowSeconds, args: args});
        }
    }

    /// @notice Window state of a `SUM_PER_WINDOW` argument: the end of the window last accounted
    ///         against and what was spent in it (`spent` is stale once `windowEnd` has passed).
    function windowOf(bytes32 id, address kernel, uint256 ruleIndex, uint256 argIndex)
        external
        view
        returns (uint48 windowEnd, uint128 spent, uint32 windowSeconds, uint256 cap)
    {
        StoredRule storage rule = _configs[id][kernel].rules[ruleIndex];
        StoredArg storage arg = rule.args[argIndex];
        return (arg.windowEnd, arg.spent, rule.windowSeconds, uint256(arg.value));
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Parses `[executeUserOp.selector ‖] execute(bytes32 mode, bytes executionCalldata)` and
    ///      checks every call it contains, accumulating the bounded words per `(rule, arg)` in `sums`.
    ///      Malformed outer encodings fail (return false) instead of reverting; a structurally invalid
    ///      batch encoding reverts in `abi.decode`, exactly as the Kernel itself would when executing it.
    function _checkCallData(Config storage config, bytes calldata callData)
        internal
        view
        returns (bool ok, uint256[MAX_RULES * MAX_ARGS] memory sums)
    {
        if (callData.length >= 4 && bytes4(callData[:4]) == EXECUTE_USER_OP_SELECTOR) callData = callData[4:];
        // selector (4) + mode word (32) + offset word (32)
        if (callData.length < 68 || bytes4(callData[:4]) != EXECUTE_SELECTOR) return (false, sums);
        bytes32 mode = bytes32(callData[4:36]);
        // `executionCalldata` is ABI-encoded `bytes`: offset relative to the start of the arguments,
        // then a length word, then the payload. Bounds are checked without any arithmetic overflow.
        uint256 offset = uint256(bytes32(callData[36:68]));
        if (offset > callData.length - 36) return (false, sums);
        uint256 start = 36 + offset; // = 4 + offset + 32
        uint256 length = uint256(bytes32(callData[start - 32:start]));
        if (length > callData.length - start) return (false, sums);
        bytes calldata executionCalldata = callData[start:start + length];

        bytes1 callType = mode[0];
        if (callType == CALLTYPE_SINGLE) {
            // target (20) ‖ value (32) ‖ data
            if (executionCalldata.length < 52) return (false, sums);
            address target = address(bytes20(executionCalldata[:20]));
            uint256 value = uint256(bytes32(executionCalldata[20:52]));
            ok = _account(config, target, value, executionCalldata[52:], sums);
            return (ok, sums);
        }
        if (callType == CALLTYPE_BATCH) {
            Execution[] memory executions = abi.decode(executionCalldata, (Execution[]));
            for (uint256 i; i < executions.length; ++i) {
                if (!_account(config, executions[i].target, executions[i].value, executions[i].callData, sums)) {
                    return (false, sums);
                }
            }
            return (true, sums);
        }
        return (false, sums); // delegatecall (0xff) and anything else
    }

    /// @dev Matches one call and adds its bounded words to the running sums (`rule * MAX_ARGS + arg`),
    ///      failing once a sum exceeds the rule's value.
    function _account(
        Config storage config,
        address target,
        uint256 value,
        bytes memory data,
        uint256[MAX_RULES * MAX_ARGS] memory sums
    ) internal view returns (bool) {
        (bool ok, uint256 ruleIndex) = _match(config, target, value, data);
        if (!ok) return false;
        StoredRule storage rule = config.rules[ruleIndex];
        uint256 n = rule.argCount;
        for (uint256 i; i < n; ++i) {
            StoredArg storage arg = rule.args[i];
            if (arg.op == OP_EQUAL) continue;
            uint256 word = uint256(_word(data, 4 + 32 * uint256(arg.index)));
            uint256 slot = ruleIndex * MAX_ARGS + i;
            // `word <= value <= 2^256 - 1` and at most a few hundred calls per op: no realistic overflow,
            // but detect a wrap anyway so a huge word can never bring the sum back under the bound.
            uint256 total;
            unchecked {
                total = sums[slot] + word;
            }
            if (total < sums[slot] || total > uint256(arg.value)) return false;
            sums[slot] = total;
        }
        return true;
    }

    /// @dev A call is allowed if it carries no value, has a selector and matches at least one rule.
    ///      Returns the index of the first matching rule.
    function _match(Config storage config, address target, uint256 value, bytes memory data)
        internal
        view
        returns (bool ok, uint256 ruleIndex)
    {
        if (value != 0 || data.length < 4) return (false, 0);
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(data); // the selector is the leading 4 bytes; truncation is intended
        uint256 n = config.ruleCount;
        for (uint256 i; i < n; ++i) {
            StoredRule storage rule = config.rules[i];
            if (rule.target == target && rule.selector == selector && _argsMatch(rule, data)) return (true, i);
        }
        return (false, 0);
    }

    /// @dev Every argument rule must hold; a rule on a word beyond the call data fails. Per-call bounds
    ///      only; sums and windows are applied afterwards.
    function _argsMatch(StoredRule storage rule, bytes memory data) internal view returns (bool) {
        uint256 n = rule.argCount;
        for (uint256 i; i < n; ++i) {
            StoredArg storage arg = rule.args[i];
            uint256 position = 4 + 32 * uint256(arg.index);
            if (position + 32 > data.length) return false;
            bytes32 word = _word(data, position);
            if (arg.op == OP_EQUAL) {
                if (word != arg.value) return false;
            } else {
                // OP_LESS_THAN_OR_EQUAL / OP_SUM_PER_WINDOW (the only other ops accepted at install)
                if (uint256(word) > uint256(arg.value)) return false;
            }
        }
        return true;
    }

    /// @dev Accounts every non-zero `SUM_PER_WINDOW` sum against its window (advanced to the window
    ///      containing `claimedNow` when that is past the current one) and returns the packed validation
    ///      data: 0 when no window was touched, else `validAfter` / `validUntil` of the tightest window.
    function _applyWindows(Config storage config, uint256[MAX_RULES * MAX_ARGS] memory sums, uint256 claimedNow)
        internal
        returns (uint256)
    {
        uint48 validAfter;
        uint48 validUntil;
        uint256 ruleCount = config.ruleCount;
        for (uint256 i; i < ruleCount; ++i) {
            StoredRule storage rule = config.rules[i];
            uint256 argCount = rule.argCount;
            for (uint256 j; j < argCount; ++j) {
                StoredArg storage arg = rule.args[j];
                if (arg.op != OP_SUM_PER_WINDOW) continue;
                uint256 v = sums[i * MAX_ARGS + j];
                if (v == 0) continue;
                uint256 window = rule.windowSeconds;
                uint256 windowEnd = arg.windowEnd;
                uint256 spent = arg.spent;
                if (claimedNow >= windowEnd) {
                    // advance the fixed grid to the window containing the claimed time (claimedNow <= 2^48, no overflow)
                    windowEnd += ((claimedNow - windowEnd) / window + 1) * window;
                    if (windowEnd > type(uint48).max) return SIG_VALIDATION_FAILED;
                    spent = 0;
                }
                if (spent + v > uint256(arg.value)) return SIG_VALIDATION_FAILED;
                arg.windowEnd = uint48(windowEnd);
                arg.spent = uint128(spent + v); // cap fits uint128 (checked at install), so does the sum
                uint48 windowStart = uint48(windowEnd - window);
                if (windowStart > validAfter) validAfter = windowStart;
                if (validUntil == 0 || uint48(windowEnd) < validUntil) validUntil = uint48(windowEnd);
            }
        }
        if (validUntil == 0) return SIG_VALIDATION_SUCCESS;
        // ERC-4337 validation data: aggregator (20 bytes, 0 = success) ‖ validUntil (6) ‖ validAfter (6)
        return (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
    }

    /// @dev Reads the 32-byte word at byte `position` of `data`; the caller checks the bounds.
    function _word(bytes memory data, uint256 position) private pure returns (bytes32 word) {
        assembly ("memory-safe") {
            word := mload(add(add(data, 0x20), position))
        }
    }
}
