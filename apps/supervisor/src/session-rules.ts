/**
 * Session rules per power (docs/design/agent-capabilities.md, section 8 item 2).
 *
 * A session key may make exactly the calls `BootrCallPolicy` allows, and which calls those are follows the
 * agent's powers: today the always-on treasury loop (claims, WETH to USDC, spender funding, gas), later Trade and
 * Payouts, each adding its own rules. This module maps powers to rules as data, so that
 *   - `sessionPolicyFor` (onboarding.ts) builds an agent's rule set from its config, not one policy for everyone;
 *   - the stored policy carries `rules` metadata (which power produced which rule, under which label) that an
 *     operator can read on the row and the console shows (`AgentConfigView.sessionRules`);
 *   - rotation rebuilds from the current config and re-applies the agent's OWN rule set (extras survive);
 *   - a power switched on that needs new on-chain rules is detected (`sessionRulesStatus`) and the key rotated
 *     early instead of waiting for the expiry rotation.
 *
 * Each power has one provider in `providers`, registered in `SESSION_POWER_ORDER`; the rules of the always-on
 * powers are byte for byte what the one standard policy produced before this module existed (the fixture
 * test/fixtures/session-policy-layout4.json pins it), and the gas rule keeps its place at the end of the shared
 * set so every earlier index (`FUNDING_RULE_INDEX`) stays where `BootrCallPolicy.windowOf` reads it. Rules of
 * later powers are appended after it. The module's hard limit is `CALL_POLICY_MAX_RULES`
 * (`BootrCallPolicy.MAX_RULES`); a rule set over it is refused here, before any admin transaction.
 *
 * Trade and Payouts have no provider yet: their powers are typed, read from the config (`capabilities.trade`,
 * `capabilities.bounties`) and refused with a clear error until the provider exists (`registerSessionRuleProvider`,
 * which tests also use to exercise the path with a fake power).
 *
 * This module knows nothing of ZeroDev, enable digests or the admin signer: session-key.ts imports it and re-exports
 * the rule primitives (`CallPolicyOp`, `callPolicyRules`, ...) so its callers keep their imports.
 */
import { isAddress, pad, toFunctionSelector, toHex, type Address, type Hex } from 'viem';
import { CLANKER_FEE_LOCKER_CLAIM_SELECTOR, CLANKER_LOCKER_COLLECT_REWARDS_SELECTOR, ERC20_APPROVE_SELECTOR, LOCKER_CLAIM_QUOTE_SELECTOR, LOCKER_SETTLE_AND_CLAIM_SELECTOR, SWAP_HELPER_SWAP_SELECTOR, WETH_WITHDRAW_SELECTOR } from './abi.js';
import type { LaunchSource } from './chain.js';

// ---------------------------------------------------------------------------
// BootrCallPolicy rules (packages/contracts/src/BootrCallPolicy.sol)
// ---------------------------------------------------------------------------

/**
 * `ArgRule.op`: EQUAL compares the 32-byte word, LESS_THAN_OR_EQUAL compares it as uint256 (summed per batch),
 * SUM_PER_WINDOW additionally accumulates it on-chain per `Rule.windowSeconds` window.
 */
export const CallPolicyOp = { EQUAL: 1, LESS_THAN_OR_EQUAL: 2, SUM_PER_WINDOW: 3 } as const;

/** `BootrCallPolicy.MAX_RULES`: the most rules one permission can hold (`onInstall` reverts `TooManyRules` beyond it). */
export const CALL_POLICY_MAX_RULES = 8;

export interface CallPolicyArgRule {
  /** Static argument index: the word at `4 + 32 * index` of the call data. */
  index: number;
  op: (typeof CallPolicyOp)[keyof typeof CallPolicyOp];
  value: Hex; // bytes32
}

export interface CallPolicyRule {
  target: Address;
  selector: Hex;
  /** Window of the rule's SUM_PER_WINDOW arguments in seconds (0 when it has none). */
  windowSeconds: number;
  args: CallPolicyArgRule[];
}

/**
 * Current rule layout: two claim rules keyed by the launch source (Bootr: the RWAGMI v3 locker pair; Clanker:
 * `collectRewards` + `claim`), then WETH approve, swap, USDC funding, WETH withdraw (gas). For a Bootr agent
 * version 4 encodes byte for byte what version 3 did (the layout only gained the Clanker variant), so no Bootr key
 * is rotated for it. Version 3 = the RWAGMI layout with the gas rule; version 2 = the same five rules without it.
 */
export const CALL_POLICY_RULES_VERSION = 4;
/** Oldest layout `callPolicyRules` can still build (the RWAGMI layout without the gas rule). */
export const MIN_CALL_POLICY_RULES_VERSION = 2;
/** First layout with the `WETH.withdraw` rule the gas policy needs (gas.ts). */
export const GAS_RULE_VERSION = 3;
/** First layout whose claim rules follow the launch source (a `clanker` policy needs at least this version). */
export const SOURCE_RULES_VERSION = 4;
/** Position of the USDC funding rule in `callPolicyRules` (for `BootrCallPolicy.windowOf`). */
export const FUNDING_RULE_INDEX = 4;
/** Position of the funding rule in the Clanker-era layout (one `FeeLocker.claim` rule in front). */
export const LEGACY_FUNDING_RULE_INDEX = 3;
/** Position of the SUM_PER_WINDOW amount argument inside that rule. */
export const FUNDING_AMOUNT_ARG_INDEX = 1;

/** Funding rule index of an installed policy (no stored policy = the current layout). */
export function fundingRuleIndex(p?: Pick<SessionRuleInputs, 'rulesVersion'> | null): number {
  if (!p) return FUNDING_RULE_INDEX;
  return (p.rulesVersion ?? 0) >= MIN_CALL_POLICY_RULES_VERSION ? FUNDING_RULE_INDEX : LEGACY_FUNDING_RULE_INDEX;
}

/** Whether a stored policy's session key may unwrap WETH into gas (`WETH.withdraw` rule present). */
export function hasGasRule(p?: Pick<SessionRuleInputs, 'rulesVersion'> | null): boolean {
  return (p?.rulesVersion ?? 0) >= GAS_RULE_VERSION;
}

export const ERC20_TRANSFER_SELECTOR: Hex = toFunctionSelector('transfer(address,uint256)');

// Lower-case bytes32 values so rule data compares byte-for-byte with the lower-cased `validatorData`.
const eqAddress = (index: number, value: Address): CallPolicyArgRule => ({ index, op: CallPolicyOp.EQUAL, value: pad(value, { size: 32 }).toLowerCase() as Hex });
const sumPerWindow = (index: number, value: bigint): CallPolicyArgRule => ({ index, op: CallPolicyOp.SUM_PER_WINDOW, value: toHex(value, { size: 32 }) });

/** The source a policy's claim rules follow (`bootr` for every policy stored before the field existed). */
export function policySource(p: Pick<SessionRuleInputs, 'source'>): LaunchSource {
  return p.source === 'clanker' ? 'clanker' : 'bootr';
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The part of a session policy the call rules are built from (session-key.ts `SessionPolicyParams` extends it). */
export interface SessionRuleInputs {
  kernel: Address;
  token: Address;
  /**
   * Launch source the claim rules are built for (chain.ts `LaunchSource`): `bootr` (default, also for every policy
   * stored before the field existed) = the two RWAGMI locker rules; `clanker` = `ClankerLpLockerFeeConversion.
   * collectRewards(token)` + `ClankerFeeLocker.claim(kernel, *)` (docs/design/clanker-launch.md section 3).
   */
  source?: LaunchSource;
  /**
   * Bootr: `RwagmiLpLockerV3`, the only claim target (`settleAndClaim` / `claimQuote`, both with `to == kernel`).
   * Clanker: `ClankerFeeLocker` (`claim(feeOwner == kernel, *)`). Policies stored before the RWAGMI migration
   * (`rulesVersion` unset) hold the Clanker fee locker here with the old single-rule layout.
   */
  feeLocker: Address;
  /** Clanker only: `ClankerLpLockerFeeConversion`, the `collectRewards(token)` target. */
  lpLocker?: Address;
  /**
   * Layout of the BootrCallPolicy rules this policy was installed with (`CALL_POLICY_RULES_VERSION`). Unset = the
   * Clanker-era four-rule layout (`FeeLocker.claim` first, USDC funding at index 3), kept until the key is rotated.
   */
  rulesVersion?: number;
  /** BootrSwapHelper (`addresses.bootr.swapHelper`): the only WETH sink a session may use. */
  swapHelper: Address;
  usdc: Address;
  weth: Address;
  /** The agent's x402 spender EOA: the only USDC recipient the session key may fund. */
  spender: Address;
  /** Max USDC (6 dp units) moved to the spender per window (`SUM_PER_WINDOW`, summed per userOp and per window). */
  usdcTransferCap: bigint;
  /** Window of the USDC cap in seconds (fixed grid anchored at install). */
  usdcWindowSeconds: number;
  /** Which powers produced which rules (`sessionRulesMeta`); absent on policies stored before this module existed. */
  rules?: SessionRulesMeta;
}

/** What a rule's identity (its label) depends on, apart from the power: the layout the policy was built with. */
export interface SessionRuleLayout {
  source: LaunchSource;
  rulesVersion: number;
}

/** The layout of a policy (stored or fresh). */
export function layoutOf(p: Pick<SessionRuleInputs, 'source' | 'rulesVersion'>): SessionRuleLayout {
  return { source: policySource(p), rulesVersion: p.rulesVersion ?? 0 };
}

// ---------------------------------------------------------------------------
// Powers and their rule providers
// ---------------------------------------------------------------------------

/**
 * The powers a session key's rules come from. `claims`, `swap` and `treasury` are the always-on treasury loop
 * (`ALWAYS_ON_CAPABILITIES` in `@bootr/shared/workers` keeps the `treasury` capability on for every agent);
 * `trade` and `bounties` are the designed on-chain powers (design doc sections 3.2 and 3.3), typed here and
 * refused until their provider exists.
 */
export type SessionPower = 'claims' | 'swap' | 'treasury' | 'trade' | 'bounties';

/** Rule order on chain: the powers' rules are concatenated in this order, whatever order the config names them. */
export const SESSION_POWER_ORDER: readonly SessionPower[] = ['claims', 'swap', 'treasury', 'trade', 'bounties'];

/** The powers every agent has, config or not: the fee -> fuel loop. */
export const ALWAYS_ON_SESSION_POWERS: readonly SessionPower[] = ['claims', 'swap', 'treasury'];

/** One rule of one power: its label is stable across installs and is what the reinstall check compares. */
export interface SessionRuleSpec {
  power: SessionPower;
  /** `<power>.<what>`, e.g. `treasury.fundSpender`; unique within a rule set. */
  label: string;
  build(inputs: SessionRuleInputs): CallPolicyRule;
}

/** A built rule with its provenance. */
export interface SessionRule extends CallPolicyRule {
  power: SessionPower;
  label: string;
}

/** The rules of one power for a layout, as specs: labels need no addresses, `build` needs the policy inputs. */
export type SessionRuleProvider = (layout: SessionRuleLayout) => SessionRuleSpec[];

const spec = (power: SessionPower, label: string, build: (inputs: SessionRuleInputs) => CallPolicyRule): SessionRuleSpec => ({ power, label: `${power}.${label}`, build });

/**
 * The two claim rules, by launch source. Bootr: the RWAGMI locker pays `msg.sender`'s (the kernel's) fee balance to
 * `to`, and `to` is pinned to the kernel, so a claim can only move fees into the kernel. Clanker: `collectRewards`
 * only moves the coin's LP fees from the positions into the fee locker (pinned to the agent's own token, anyone may
 * call it anyway), and `ClankerFeeLocker.claim(feeOwner, token)` always pays `feeOwner`, pinned to the kernel; the
 * token is free (WETH today, and nothing else can be stolen since the payee is fixed).
 */
const claimsProvider: SessionRuleProvider = (layout) => {
  if (layout.source === 'clanker') {
    if (layout.rulesVersion < SOURCE_RULES_VERSION) throw new Error(`a clanker session policy needs rule layout ${SOURCE_RULES_VERSION} or later (rulesVersion ${layout.rulesVersion || 'unset'})`);
    return [
      // ClankerLpLockerFeeConversion.collectRewards(address token): word 0 is the token, pinned to the agent's coin.
      spec('claims', 'collectRewards', (p) => {
        if (!p.lpLocker || !isAddress(p.lpLocker)) throw new Error('session policy has no lpLocker (ClankerLpLockerFeeConversion)');
        return { target: p.lpLocker, selector: CLANKER_LOCKER_COLLECT_REWARDS_SELECTOR, windowSeconds: 0, args: [eqAddress(0, p.token)] };
      }),
      // ClankerFeeLocker.claim(address feeOwner, address token): word 0 is `feeOwner`, pinned to the kernel.
      spec('claims', 'claim', (p) => {
        if (!isAddress(p.feeLocker)) throw new Error('session policy has no feeLocker (ClankerFeeLocker)');
        return { target: p.feeLocker, selector: CLANKER_FEE_LOCKER_CLAIM_SELECTOR, windowSeconds: 0, args: [eqAddress(0, p.kernel)] };
      }),
    ];
  }
  const locker = (p: SessionRuleInputs): Address => {
    if (!isAddress(p.feeLocker)) throw new Error('session policy has no feeLocker (RwagmiLpLockerV3)');
    return p.feeLocker;
  };
  return [
    // RwagmiLpLockerV3.settleAndClaim(bytes32[] ids, address currency, address to): static word 2 is `to` (word 0 is
    // the offset of `ids`); pools and currency are free, the payout always lands in the kernel.
    spec('claims', 'settleAndClaim', (p) => ({ target: locker(p), selector: LOCKER_SETTLE_AND_CLAIM_SELECTOR, windowSeconds: 0, args: [eqAddress(2, p.kernel)] })),
    // RwagmiLpLockerV3.claimQuote(address currency, address to): already settled balance, `to == kernel`.
    spec('claims', 'claimQuote', (p) => ({ target: locker(p), selector: LOCKER_CLAIM_QUOTE_SELECTOR, windowSeconds: 0, args: [eqAddress(1, p.kernel)] })),
  ];
};

/**
 * WETH to USDC through the swap helper. The helper pulls WETH from the kernel and pays ALL output USDC back to the
 * kernel at no worse than the Chainlink price minus 3%, so these rules can only ever turn the kernel's WETH into
 * the kernel's USDC (finding C-02).
 */
const swapProvider: SessionRuleProvider = () => {
  const helper = (p: SessionRuleInputs): Address => {
    if (!isAddress(p.swapHelper)) throw new Error('session policy has no swapHelper (bootr.swapHelper)');
    return p.swapHelper;
  };
  return [
    // WETH.approve(swapHelper, *): the helper only ever spends the allowance from msg.sender == kernel.
    spec('swap', 'approveWeth', (p) => ({ target: p.weth, selector: ERC20_APPROVE_SELECTOR, windowSeconds: 0, args: [eqAddress(0, helper(p))] })),
    // swapHelper.swapWethToUsdc(amountIn, maxSlippageBps): output to msg.sender, floor from Chainlink on-chain.
    spec('swap', 'swapWethToUsdc', (p) => ({ target: helper(p), selector: SWAP_HELPER_SWAP_SELECTOR, windowSeconds: 0, args: [] })),
  ];
};

/**
 * The kernel's own money: the only USDC outflow is to the agent's own spender EOA, capped cumulatively per window
 * on-chain (M-02 and the x402 exposure after C-01). `WETH.withdraw` (layout 3 and later) turns the kernel's WETH
 * into ETH held by the kernel itself: WETH9 pays `msg.sender`, and ETH on the kernel can only ever leave as userOp
 * prefund (no rule carries value, the root validator is the guardian), so it is the agent's gas and nothing else
 * (gas.ts). It stays last of the shared set so every earlier index is stable.
 */
const treasuryProvider: SessionRuleProvider = (layout) => [
  // USDC.transfer(spender, SUM_PER_WINDOW <= cap): the spender's float, at most `cap` per window.
  spec('treasury', 'fundSpender', (p) => {
    if (!isAddress(p.spender)) throw new Error('session policy has no spender');
    if (!Number.isInteger(p.usdcWindowSeconds) || p.usdcWindowSeconds <= 0) throw new Error('usdcWindowSeconds must be a positive integer');
    if (p.usdcTransferCap <= 0n || p.usdcTransferCap > 2n ** 128n - 1n) throw new Error('usdcTransferCap must fit uint128');
    return { target: p.usdc, selector: ERC20_TRANSFER_SELECTOR, windowSeconds: p.usdcWindowSeconds, args: [eqAddress(0, p.spender), sumPerWindow(1, p.usdcTransferCap)] };
  }),
  ...(layout.rulesVersion >= GAS_RULE_VERSION
    ? [
        // WETH.withdraw(wad): the kernel's own gas (ETH stays on the kernel; see above).
        spec('treasury', 'withdrawWethForGas', (p) => ({ target: p.weth, selector: WETH_WITHDRAW_SELECTOR, windowSeconds: 0, args: [] })),
      ]
    : []),
];

/**
 * The provider table, one entry per power. Trade (`BootrTradeHelper`: approve rules + one swap selector) and
 * Payouts (`BootrPayouts.propose` + a USDC allowance) are not registered: their contracts do not exist yet
 * (design doc section 4), and a power with no provider is refused by `sessionRuleSpecsFor` rather than silently
 * adding nothing. Register one with `registerSessionRuleProvider` when the contract ships.
 */
const providers = new Map<SessionPower, SessionRuleProvider>([
  ['claims', claimsProvider],
  ['swap', swapProvider],
  ['treasury', treasuryProvider],
]);

/** The provider of a power, or undefined when the power has none yet. */
export function sessionRuleProvider(power: SessionPower): SessionRuleProvider | undefined {
  return providers.get(power);
}

/**
 * Registers (or replaces) the provider of a power and returns a function that restores the previous state. Production
 * code registers the Trade and Payouts providers here when they exist; tests use it for a fake power.
 */
export function registerSessionRuleProvider(power: SessionPower, provider: SessionRuleProvider): () => void {
  if (!SESSION_POWER_ORDER.includes(power)) throw new Error(`unknown session power ${String(power)}`);
  const previous = providers.get(power);
  providers.set(power, provider);
  return () => {
    if (previous) providers.set(power, previous);
    else providers.delete(power);
  };
}

/** Whether `power` is a `SessionPower` (for powers read from stored JSON). */
export function isSessionPower(power: unknown): power is SessionPower {
  return typeof power === 'string' && (SESSION_POWER_ORDER as readonly string[]).includes(power);
}

/**
 * The rule specs of a set of powers for a layout, in `SESSION_POWER_ORDER`, checked against the module's limits:
 * every power must have a provider, the labels must be unique, and the count may not pass `CALL_POLICY_MAX_RULES`.
 */
export function sessionRuleSpecsFor(powers: readonly SessionPower[], layout: SessionRuleLayout): SessionRuleSpec[] {
  for (const power of powers) if (!isSessionPower(power)) throw new Error(`unknown session power ${String(power)}`);
  const specs: SessionRuleSpec[] = [];
  for (const power of SESSION_POWER_ORDER) {
    if (!powers.includes(power)) continue;
    const provider = providers.get(power);
    if (!provider) throw new Error(`the ${power} power is on but has no session rule provider yet (session-rules.ts)`);
    for (const s of provider(layout)) {
      if (s.power !== power) throw new Error(`the ${power} provider produced a rule of power ${s.power} (${s.label})`);
      if (specs.some((o) => o.label === s.label)) throw new Error(`duplicate session rule label ${s.label}`);
      specs.push(s);
    }
  }
  if (specs.length > CALL_POLICY_MAX_RULES) {
    throw new Error(`session rules over the BootrCallPolicy limit: ${specs.length} rules for powers ${powers.join(', ')}, the module holds at most ${CALL_POLICY_MAX_RULES} (${specs.map((s) => s.label).join(', ')})`);
  }
  return specs;
}

/** The rule labels a set of powers implies for a layout (no addresses needed). */
export function sessionRuleLabelsFor(powers: readonly SessionPower[], layout: SessionRuleLayout): string[] {
  return sessionRuleSpecsFor(powers, layout).map((s) => s.label);
}

/** The built rules of a set of powers for a policy's inputs, with their provenance. Pure. */
export function sessionRulesFor(powers: readonly SessionPower[], inputs: SessionRuleInputs): SessionRule[] {
  return sessionRuleSpecsFor(powers, layoutOf(inputs)).map((s) => ({ ...s.build(inputs), power: s.power, label: s.label }));
}

// ---------------------------------------------------------------------------
// Stored metadata
// ---------------------------------------------------------------------------

/** Layout of the `rules` block stored on `sv_agents.session_policy`. */
export const SESSION_RULES_META_VERSION = 1;

/** Stored with the policy: why the key has the rules it has. */
export interface SessionRulesMeta {
  version: number;
  /** The powers that were on when the rules were built, in `SESSION_POWER_ORDER`. */
  powers: SessionPower[];
  /** One entry per rule, in rule (index) order. */
  items: { label: string; power: SessionPower }[];
}

export function sessionRulesMeta(powers: readonly SessionPower[], rules: readonly SessionRule[]): SessionRulesMeta {
  return { version: SESSION_RULES_META_VERSION, powers: SESSION_POWER_ORDER.filter((p) => powers.includes(p)), items: rules.map((r) => ({ label: r.label, power: r.power })) };
}

/** The stored `rules` block of a policy read back from the row, or null when absent or malformed. */
export function sessionRulesMetaOf(raw: unknown): SessionRulesMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as { version?: unknown; powers?: unknown; items?: unknown };
  if (typeof m.version !== 'number' || !Array.isArray(m.powers) || !Array.isArray(m.items)) return null;
  if (!m.powers.every(isSessionPower)) return null;
  const items: SessionRulesMeta['items'] = [];
  for (const it of m.items) {
    if (!it || typeof it !== 'object') return null;
    const { label, power } = it as { label?: unknown; power?: unknown };
    if (typeof label !== 'string' || !isSessionPower(power)) return null;
    items.push({ label, power });
  }
  return { version: m.version, powers: m.powers, items };
}

/**
 * The calls a session key may make, in rule order, as `BootrCallPolicy` takes them: the rules of the policy's powers
 * (`rules.powers` when stored, the always-on set for policies from before this module), each with zero ETH value.
 * Throws for the legacy layouts this code no longer builds (rotate the key).
 */
export function callPolicyRules(p: SessionRuleInputs): CallPolicyRule[] {
  if ((p.rulesVersion ?? 0) < MIN_CALL_POLICY_RULES_VERSION) throw new Error(`session policy has the legacy rule layout (rulesVersion ${p.rulesVersion ?? 'unset'}); rotate the session key`);
  const powers = p.rules?.powers ?? ALWAYS_ON_SESSION_POWERS;
  return sessionRulesFor(powers, p).map(({ target, selector, windowSeconds, args }) => ({ target, selector, windowSeconds, args }));
}

/**
 * The labels of the rules a stored policy was installed with: the stored metadata, else (a policy from before the
 * metadata existed) the always-on set rebuilt for its layout; null for a legacy layout this code cannot rebuild.
 */
export function storedRuleLabels(p: Pick<SessionRuleInputs, 'source' | 'rulesVersion' | 'rules'>): string[] | null {
  const meta = sessionRulesMetaOf(p.rules);
  if (meta) return meta.items.map((i) => i.label);
  if ((p.rulesVersion ?? 0) < MIN_CALL_POLICY_RULES_VERSION) return null;
  return sessionRuleLabelsFor(ALWAYS_ON_SESSION_POWERS, layoutOf(p));
}

// ---------------------------------------------------------------------------
// Powers of a config, diffs, reinstall detection
// ---------------------------------------------------------------------------

/**
 * The session powers an agent's stored config switches on. The treasury loop is always on (it is what keeps the
 * agent fuelled; `ALWAYS_ON_CAPABILITIES`), whatever the stored flag says. `trade` and `bounties` read the raw
 * `capabilities` block so the console switch works the day the key exists in the schema; today nothing sets them.
 */
export function sessionPowersOf(config: Record<string, unknown>): SessionPower[] {
  const caps = config.capabilities && typeof config.capabilities === 'object' && !Array.isArray(config.capabilities) ? (config.capabilities as Record<string, unknown>) : {};
  const powers: SessionPower[] = [...ALWAYS_ON_SESSION_POWERS];
  if (caps.trade === true) powers.push('trade');
  // Bounties stage A (bounties.ts) has no chain footprint: the creator pays by hand, so the power asks nothing of the
  // session key. It joins the key's rules the day stage B registers the `bounties` provider (BootrBounties, three rules).
  if (caps.bounties === true && providers.has('bounties')) powers.push('bounties');
  return powers;
}

export interface RuleLabelDiff {
  added: string[];
  removed: string[];
}

/** Labels in `after` and not in `before`, and the reverse (order-insensitive). */
export function diffRuleLabels(before: readonly string[], after: readonly string[]): RuleLabelDiff {
  return { added: after.filter((l) => !before.includes(l)), removed: before.filter((l) => !after.includes(l)) };
}

/** `+trade.approveCoin, +trade.swap, -swap.approveWeth` ('' when nothing changed). */
export function formatRuleDiff(diff: RuleLabelDiff): string {
  return [...diff.added.map((l) => `+${l}`), ...diff.removed.map((l) => `-${l}`)].join(', ');
}

export function sameRuleLabels(a: readonly string[], b: readonly string[]): boolean {
  const diff = diffRuleLabels(a, b);
  return diff.added.length === 0 && diff.removed.length === 0;
}

/** `AgentConfigView.sessionRules`: what the installed key allows against what the config asks for. */
export interface SessionRulesStatus {
  /** Labels of the installed key's rules ([] when no policy is stored, or its layout is too old to read back). */
  current: string[];
  /** Labels the config's powers imply (for the installed key's layout, so a layout bump alone changes nothing). */
  wanted: string[];
  /** A key is installed and its rules differ from `wanted`: the next rotation scan rotates it (one try a day). */
  reinstallNeeded: boolean;
  /** Set when `wanted` could not be computed (a power without a provider): the console shows it, nothing rotates. */
  error?: string;
}

/** The fields of an agent row this check reads. */
export interface SessionRulesAgent {
  permissionId: string | null;
  sessionPolicy: Record<string, unknown> | null;
  source?: string | null;
}

/**
 * Compares the rule labels of the stored policy with the ones the current config implies. The wanted set is built for
 * the stored policy's layout (source, rulesVersion): only a change of powers asks for a reinstall; layout bumps keep
 * following the code's own version rules and the expiry rotation, as before this module. With no stored policy the
 * wanted set is for the current layout and nothing needs a reinstall (the install builds from the config anyway).
 */
export function sessionRulesStatus(agent: SessionRulesAgent, config: Record<string, unknown>): SessionRulesStatus {
  const stored = agent.sessionPolicy as Pick<SessionRuleInputs, 'source' | 'rulesVersion' | 'rules'> | null;
  const layout: SessionRuleLayout = stored ? layoutOf({ source: stored.source, rulesVersion: typeof stored.rulesVersion === 'number' ? stored.rulesVersion : undefined }) : { source: agent.source === 'clanker' ? 'clanker' : 'bootr', rulesVersion: CALL_POLICY_RULES_VERSION };
  let current: string[] | null = null;
  try {
    current = stored ? storedRuleLabels(stored) : [];
  } catch {
    current = null;
  }
  let wanted: string[];
  try {
    wanted = sessionRuleLabelsFor(sessionPowersOf(config), layout);
  } catch (err) {
    return { current: current ?? [], wanted: current ?? [], reinstallNeeded: false, error: err instanceof Error ? err.message : String(err) };
  }
  const reinstallNeeded = !!agent.permissionId && !!stored && current !== null && !sameRuleLabels(current, wanted);
  return { current: current ?? [], wanted, reinstallNeeded };
}

/** Whether the installed key's rules are behind the config (`sessionRulesStatus(...).reinstallNeeded`). */
export function sessionKeyNeedsReinstall(agent: SessionRulesAgent, config: Record<string, unknown>): boolean {
  return sessionRulesStatus(agent, config).reinstallNeeded;
}
