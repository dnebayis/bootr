/**
 * The treasury path of an agent by launch source (docs/design/clanker-launch.md section 3,
 * docs/design/clanker-v5-migration.md section 3): `sv_agents.source` says which launcher emitted the agent's
 * `AgentLaunched`, the config's `clanker` block (decoded from `ClankerLaunched` in the launch receipt) names the
 * Clanker v4 lockers its fees sit in, and the `clankerV5` block (from `ClankerV5Launched` and the rest of the v5 launch
 * receipt) the v5 escrow, the paired asset and the creator's token settings. Shared by onboarding.ts (session-key
 * rules), treasury.ts (reads and claim calls) and coin-fees.ts (the split the agent states); kept apart from all three
 * so none imports the other.
 */
import { getAddress, isAddress, isAddressEqual, isHex, size, zeroAddress, type Address, type Hex } from 'viem';
import type { LaunchSource } from './chain.js';
import type { AgentRow, SupervisorContext } from './context.js';

/** A stored source string as a `LaunchSource`: `bootr` for rows written before the column existed and for anything unknown. */
export function launchSourceFrom(source: unknown): LaunchSource {
  return source === 'clanker' || source === 'clanker-v5' ? source : 'bootr';
}

/** `bootr` for rows written before the column existed and for anything that is not `clanker` or `clanker-v5`. */
export function agentSource(agent: Pick<AgentRow, 'source'>): LaunchSource {
  return launchSourceFrom(agent.source);
}

/** What `BootrClankerLauncher.ClankerLaunched` says about a coin, stored in `sv_agents.config.clanker`. */
export interface ClankerLaunchDetails {
  /** Uniswap v4 pool id of the coin / WETH pool. */
  poolId: Hex;
  /** The Clanker hook the pool runs (static or dynamic fee V2). */
  hook: Address;
  /** `ClankerLpLockerFeeConversion` holding the positions: the `collectRewards(token)` target. */
  locker: Address;
  /** `ClankerFeeLocker` the locker deposits into (`CLANKER_FEE_LOCKER_ADDRESS` at registration): the `claim` target. */
  feeLocker: Address;
  mevModule: Address;
  startingTick: number;
  lpFeeBps: number;
}

const ZERO_BYTES32: Hex = `0x${'0'.repeat(64)}`;
const isPoolId = (v: unknown): v is Hex => typeof v === 'string' && isHex(v) && size(v) === 32 && v !== ZERO_BYTES32;
const isAddr = (v: unknown): v is Address => typeof v === 'string' && isAddress(v);

/** The stored `config.clanker` block, or null when absent or malformed (the receipt could not be read at registration). */
export function clankerDetailsOf(config: Record<string, unknown>): ClankerLaunchDetails | null {
  const raw = config.clanker;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (!isPoolId(c.poolId) || !isAddr(c.hook) || !isAddr(c.locker) || !isAddr(c.feeLocker) || !isAddr(c.mevModule)) return null;
  return {
    poolId: c.poolId,
    hook: getAddress(c.hook),
    locker: getAddress(c.locker),
    feeLocker: getAddress(c.feeLocker),
    mevModule: getAddress(c.mevModule),
    startingTick: typeof c.startingTick === 'number' ? c.startingTick : 0,
    lpFeeBps: typeof c.lpFeeBps === 'number' ? c.lpFeeBps : 0,
  };
}

/**
 * The Clanker lockers an agent's fees sit in: the ones `ClankerLaunched` named (the launch is the truth), else the
 * configured defaults (`CLANKER_LOCKER_ADDRESS` / `CLANKER_FEE_LOCKER_ADDRESS`) while the receipt is unread.
 */
export function clankerLockersFor(ctx: Pick<SupervisorContext, 'chain'>, agent: Pick<AgentRow, 'config'>): { lpLocker: Address; feeLocker: Address; details: ClankerLaunchDetails | null } {
  const details = clankerDetailsOf(agent.config);
  return { lpLocker: details?.locker ?? ctx.chain.clanker.lpLocker, feeLocker: details?.feeLocker ?? ctx.chain.clanker.feeLocker, details };
}

/** Clanker v5's protocol policy for one pool (`LaunchTaxConfigured.admittedPolicy.protocolFeeConfiguration`, 1e8 scale). */
export interface ClankerV5ProtocolPolicy {
  protocolTaxShare: number;
  minimumProtocolFeeRate: number;
  maximumProtocolFeeRate: number;
}

/** The live policy on Base (read 2026-11-10; apps/indexer/src/lib/fees.ts `CLANKER_V5_DEFAULT_POLICY`): 10% of the tax, 0.5% to 1% of the trade. */
export const CLANKER_V5_DEFAULT_POLICY: ClankerV5ProtocolPolicy = { protocolTaxShare: 10_000_000, minimumProtocolFeeRate: 500_000, maximumProtocolFeeRate: 1_000_000 };

/**
 * Who a v5 fee slot pays, from the hook's `FeeSlotCreated` in the launch receipt (docs/design/clanker-v5-token-settings.md
 * section 2.2: `[0] agent`, `[1] platform`, `[2..] creator rows`): `agent` is the kernel's slot under the launcher's
 * admin, `platform` the other launcher-admin slot, `creator` the first row the creator set (their own), `other` every
 * extra reward row. Addresses are not kept: the agent speaks of "other recipients", never of who they are.
 */
export type ClankerV5SlotRole = 'agent' | 'platform' | 'creator' | 'other';

/**
 * The creator's token settings of a v5 coin (docs/design/clanker-v5-token-settings.md section 2), read once from the
 * launch receipt by `decodeClankerV5Launch` (onboarding.ts): `ClankerV5Launched` v2 (taxes, burn, dividends, switches),
 * the hook's `FeeSlotCreated` (the slots and their weights) and the factory's `LaunchTaxConfigured` (Clanker's policy
 * and the dividend minimum). All of it is frozen per pool by Clanker.
 */
export interface ClankerV5TokenSettings {
  /** Each side's tax in hundredths of a bip (15_000 = 1.5%), like `lpFeeBps`. */
  buyTaxBps: number;
  sellTaxBps: number;
  /** Shares of the tax after Clanker's cut, in bps: the burn (taken in the coin) and the holder dividends (in the quote). */
  burnBps: number;
  dividendBps: number;
  /** The fee slots in slot order, each weight in bps of the slot pool (`10_000 - burnBps - dividendBps` of the tax after Clanker). */
  slots: { role: ClankerV5SlotRole; weightBps: number }[];
  /** Clanker's cut; the live policy when the receipt carried no `LaunchTaxConfigured`. */
  protocolPolicy: ClankerV5ProtocolPolicy;
  /** `minimumDividendHolding` in raw coin units (18 decimals) as a decimal string; null when unknown or without dividends. */
  minDividendHolding: string | null;
  metadataEditable: boolean;
}

/**
 * What a v5 launch receipt says about the coin, stored in `sv_agents.config.clankerV5` (docs/design/clanker-v5-migration.md,
 * docs/design/clanker-v5-token-settings.md section 2.2). `settings` is there for the settings launcher (`ClankerV5Launched`
 * v2 plus the slots of the same receipt); a row from the fixed launcher's v1 event (never deployed) has none.
 */
export interface ClankerV5LaunchDetails {
  /** Uniswap v4 pool id of the coin / quote pool (fee 0, the v5 hook). */
  poolId: Hex;
  /** `TaxLaunchHook`: takes the tax on every swap and credits the escrow. */
  hook: Address;
  /** `FeeEscrow`: the kernel's `owed(kernel, quote)` balance and the `claimFor(kernel, quote)` target. */
  feeEscrow: Address;
  /** The pool's quote, the asset every slot is paid in: `0x0` = native ETH, else an ERC-20 (USDC for agent coins). */
  quoteToken: Address;
  tickSpacing: number;
  /** The buy tax in hundredths of a bip (15_000 = 1.5%); on a v1 row buy and sell alike. */
  taxBps: number;
  antiSnipe: boolean;
  settings?: ClankerV5TokenSettings;
}

const SLOT_ROLES: readonly ClankerV5SlotRole[] = ['agent', 'platform', 'creator', 'other'];
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The stored `settings` block, or null when absent or malformed (then nothing is said that it would have said). */
function settingsOf(raw: unknown): ClankerV5TokenSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (![s.buyTaxBps, s.sellTaxBps, s.burnBps, s.dividendBps].every(isCount) || !Array.isArray(s.slots) || !s.slots.length) return null;
  const slots = (s.slots as unknown[]).map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}));
  if (slots.some((x) => !SLOT_ROLES.includes(x.role as ClankerV5SlotRole) || !isCount(x.weightBps))) return null;
  const p = (s.protocolPolicy && typeof s.protocolPolicy === 'object' ? s.protocolPolicy : {}) as Record<string, unknown>;
  const protocolPolicy = [p.protocolTaxShare, p.minimumProtocolFeeRate, p.maximumProtocolFeeRate].every(isCount)
    ? { protocolTaxShare: p.protocolTaxShare as number, minimumProtocolFeeRate: p.minimumProtocolFeeRate as number, maximumProtocolFeeRate: p.maximumProtocolFeeRate as number }
    : CLANKER_V5_DEFAULT_POLICY;
  return {
    buyTaxBps: s.buyTaxBps as number,
    sellTaxBps: s.sellTaxBps as number,
    burnBps: s.burnBps as number,
    dividendBps: s.dividendBps as number,
    slots: slots.map((x) => ({ role: x.role as ClankerV5SlotRole, weightBps: x.weightBps as number })),
    protocolPolicy,
    minDividendHolding: typeof s.minDividendHolding === 'string' && /^\d+$/.test(s.minDividendHolding) ? s.minDividendHolding : null,
    metadataEditable: s.metadataEditable === true,
  };
}

/** The stored `config.clankerV5` block, or null when absent or malformed (the receipt could not be read at registration). */
export function clankerV5DetailsOf(config: Record<string, unknown>): ClankerV5LaunchDetails | null {
  const raw = config.clankerV5;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (!isPoolId(c.poolId) || !isAddr(c.hook) || !isAddr(c.feeEscrow) || !isAddr(c.quoteToken)) return null;
  const settings = settingsOf(c.settings);
  return {
    poolId: c.poolId,
    hook: getAddress(c.hook),
    feeEscrow: getAddress(c.feeEscrow),
    quoteToken: getAddress(c.quoteToken),
    tickSpacing: typeof c.tickSpacing === 'number' ? c.tickSpacing : 0,
    taxBps: typeof c.taxBps === 'number' ? c.taxBps : 0,
    antiSnipe: c.antiSnipe === true,
    ...(settings ? { settings } : {}),
  };
}

/**
 * The asset a v5 coin is paired with, hence the asset of every slot's fees (docs/design/clanker-v5-token-settings.md
 * section 3): `ETH` for native ETH (`0x0`), `USDC` for the chain's USDC, `other` for anything else (no agent coin can
 * have one, the launcher's allow-list for agent coins being ETH and USDC; the supervisor neither values nor claims it).
 */
export type PairedAsset = 'ETH' | 'USDC' | 'other';

export function pairedAssetOf(ctx: Pick<SupervisorContext, 'chain'>, quoteToken: Address | null | undefined): PairedAsset {
  if (!quoteToken || isAddressEqual(quoteToken, zeroAddress)) return 'ETH';
  return isAddressEqual(quoteToken, ctx.chain.addresses.usdc) ? 'USDC' : 'other';
}

/** A v5 agent's stored launch details with its paired asset (coin-fees.ts `coinFeesSection`); null for any other source. */
export function clankerV5CoinOf(ctx: Pick<SupervisorContext, 'chain'>, agent: Pick<AgentRow, 'config' | 'source'>): { details: ClankerV5LaunchDetails | null; pairedAsset: PairedAsset } | null {
  if (agentSource(agent) !== 'clanker-v5') return null;
  const details = clankerV5DetailsOf(agent.config);
  return { details, pairedAsset: pairedAssetOf(ctx, details?.quoteToken) };
}

/**
 * The quote of a v5 agent's coin: what `ClankerV5Launched` named, native ETH (`0x0`, the launcher's default) while the
 * receipt is unread. A USDC coin then reads an empty ETH balance and claims nothing until the onboarding backfill
 * stores the receipt's details; it never claims to a wrong asset, because `claimFor` always pays the kernel.
 */
export function clankerV5QuoteOf(agent: Pick<AgentRow, 'config'>): Address {
  return clankerV5DetailsOf(agent.config)?.quoteToken ?? zeroAddress;
}

/**
 * The v5 `FeeEscrow` an agent's fees sit in: the one `ClankerV5Launched` named (the launch is the truth), else the
 * address book's (`addresses.clankerV5.feeEscrow`) while the receipt is unread. Throws when neither is known (a chain
 * without Clanker v5): a v5 agent must never get a claim rule or a claim call to a guessed address.
 */
export function clankerV5EscrowFor(ctx: Pick<SupervisorContext, 'chain'>, agent: Pick<AgentRow, 'config'>): { feeEscrow: Address; details: ClankerV5LaunchDetails | null } {
  const details = clankerV5DetailsOf(agent.config);
  const feeEscrow = details?.feeEscrow ?? ctx.chain.clankerV5.feeEscrow;
  if (!feeEscrow) throw new Error(`clankerV5.feeEscrow address is not configured for chain ${ctx.chain.chainId}`);
  return { feeEscrow, details };
}
