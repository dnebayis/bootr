/**
 * The public ledger of an agent's money (`GET /internal/agents/:id/ledger`, docs/design/agent-capabilities.md section 5):
 * one list, newest first, of every movement of the agent's money and of the promises it made, read from rows code wrote
 * when the thing happened. Nothing here is editable and nothing is stored: every row is rebuilt from its source on each
 * read, so the weekly report card (docs/design/agent-report-card.md section 2.5) can read the same rows through
 * `ledgerRowsBetween` and the two cannot disagree.
 *
 * Sources, each with the id prefix of its rows:
 *   - `claim:` the indexer's `feeClaim` rows paid to the agent's wallet (`recipient` = kernel): fee claims, in, with the
 *     amount the chain moved and its dollar value at the block;
 *   - `fuel:` the indexer's `fuel` rows (USDC transfers into the kernel), less the agent's own transactions (a swap's
 *     USDC, a USDC fee claim) and the fee contracts: money people sent it, in;
 *   - `op:` `sv_treasury_ops` that left the supervisor (sent, unknown, confirmed, failed): fuel top-ups (wallet to its
 *     thinking wallet), gas top-ups, swaps and transfers; a fee claim op only while the indexer has no row of its
 *     transaction (failed, unknown, or confirmed and not indexed yet), so a claim is never counted twice;
 *   - `think:` `sv_inference` summed per UTC day and per payee (Bootr's thinking service or BlockRun): paid calls as
 *     `confirmed`, signed calls whose outcome is open as `unknown`;
 *   - `svc:` `sv_service_calls` that moved or may have moved money (host, amount, the model's stated reason);
 *   - `bounty:` `sv_bounty_jobs`, one row per event: posted (the amount offered), judged, paid (by its creator, stage A),
 *     closed without payment.
 *   - Trades: none exist yet (the Trade power is designed, not built). The `trade` kind is part of the row type so the
 *     page and the card already know its shape (both legs and the memo); there is no source for it.
 *
 * Status is `confirmed`, `failed` or `unknown`; an `unknown` row stays unknown until the chain closes its source row.
 *
 * Paging: every row has a unique id and a millisecond time; the order is (time desc, id desc) and the cursor is the
 * pair of the last row shown. Each source applies the cursor and its own filters in its query and returns at most
 * `limit + 1` rows in that order, so the merge of all sources holds the true first `limit + 1` rows of the whole ledger
 * and no row can be skipped (the bug the activity tape had, docs/dev/behaviour-check.md section 6).
 */
import { and, desc, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import { decodeFunctionData, erc20Abi, formatUnits, parseUnits, type Address } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { bountyJobs, inference, serviceCalls, treasuryOps } from './db/schema.js';
import { CHARGED_MICRO_USDC, PAID_CALL } from './inference.js';
import { SERVICES_PAID_NO_ANSWER } from './services.js';

export type LedgerKind = 'fee_claim' | 'fuel_received' | 'fuel_topup' | 'gas_topup' | 'swap' | 'transfer' | 'thinking' | 'service' | 'trade' | 'bounty_posted' | 'bounty_judged' | 'bounty_paid' | 'bounty_closed';
/** `move`: between the agent's own wallets or from one of its assets to another (not spent); `none`: no money moved. */
export type LedgerDirection = 'in' | 'out' | 'move' | 'none';
export type LedgerStatus = 'confirmed' | 'failed' | 'unknown';
export type LedgerAsset = 'USDC' | 'WETH' | 'ETH';

export interface LedgerAmount {
  asset: LedgerAsset;
  decimals: number;
  /** Base units as a decimal string. */
  raw: string;
  /** The dollar value: USDC is dollars; a fee claim carries the indexer's value at its block; otherwise absent. */
  usd?: number;
  /** `about`: an estimate written when the op was prepared; `at_least` / `at_most`: a bound, not the moved amount. */
  bound?: 'about' | 'at_least' | 'at_most';
}

export type LedgerRole = 'fee_locker' | 'person' | 'creator' | 'own_wallet' | 'thinking_service' | 'blockrun' | 'service' | 'bounty_winner' | 'swap' | 'gas' | 'unknown';

export interface LedgerParty {
  role: LedgerRole;
  /** A public address (never a creator's private data: a creator's address is on chain and on the coin page). */
  address?: string;
  /** A paid service's host. */
  host?: string;
}

export interface LedgerRow {
  id: string;
  /** ISO time, millisecond precision. */
  at: string;
  kind: LedgerKind;
  direction: LedgerDirection;
  status: LedgerStatus;
  amount?: LedgerAmount;
  /** The other leg of a swap or a trade. */
  received?: LedgerAmount;
  counterparty?: LedgerParty;
  /** One plain line written by code, or the model's own stated reason for a paid service. */
  reason: string;
  txHash?: string;
  /** A link that is not a transaction: the bounty's post on X. */
  url?: string;
  /** Whose money moved when it was not the agent's: a bounty is paid by its creator's wallet (stage A). */
  paidBy?: 'creator';
}

export interface LedgerCursor {
  at: number;
  id: string;
}

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;
/** Days of totals the first page carries (today included). */
export const LEDGER_DAYS = 7;

const ID_RE = /^[a-z]+:[A-Za-z0-9_:.-]{1,200}$/;

export function encodeCursor(c: LedgerCursor): string {
  return Buffer.from(JSON.stringify([c.at, c.id])).toString('base64url');
}

/** The cursor of a page, or null for anything that is not one this module wrote. */
export function decodeCursor(raw: string): LedgerCursor | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(raw)) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [at, id] = v as [unknown, unknown];
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || typeof id !== 'string' || !ID_RE.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

/** (time desc, id desc): the one order of the ledger, the same in SQL (`collate "C"`) and here (ASCII ids). */
export function compareRows(a: { at: string; id: string }, b: { at: string; id: string }): number {
  const d = Date.parse(b.at) - Date.parse(a.at);
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function afterCursor(row: { at: string; id: string }, cursor: LedgerCursor | null): boolean {
  if (!cursor) return true;
  const at = Date.parse(row.at);
  return at < cursor.at || (at === cursor.at && row.id < cursor.id);
}

// ---------------------------------------------------------------------------------------------
// SQL helpers: millisecond time and the prefixed id, compared and ordered the same way everywhere
// ---------------------------------------------------------------------------------------------

const msOf = (col: SQL | unknown): SQL => sql`floor(extract(epoch from ${col}) * 1000)`;
const idOf = (prefix: string, col: SQL | unknown): SQL => sql`(${prefix} || ${col}) collate "C"`;

function keyset(at: SQL, id: SQL, cursor: LedgerCursor | null): SQL[] {
  return cursor ? [sql`(${at} < ${cursor.at} or (${at} = ${cursor.at} and ${id} < ${cursor.id}))`] : [];
}

const isoMs = (ms: number) => new Date(ms).toISOString();
const lc = (a: string | null | undefined) => (a ?? '').toLowerCase();

function usdcAmount(raw: bigint | string, bound?: LedgerAmount['bound']): LedgerAmount {
  const r = BigInt(raw);
  return { asset: 'USDC', decimals: 6, raw: r.toString(), usd: Number(formatUnits(r, 6)), ...(bound ? { bound } : {}) };
}

function assetAmount(asset: LedgerAsset, raw: bigint, bound?: LedgerAmount['bound']): LedgerAmount {
  if (asset === 'USDC') return usdcAmount(raw, bound);
  return { asset, decimals: 18, raw: raw.toString(), ...(bound ? { bound } : {}) };
}

/** A decimal written by code ("0.0024") as an amount; null when the text holds none. */
function parsedAmount(asset: LedgerAsset, text: string | undefined, bound?: LedgerAmount['bound']): LedgerAmount | null {
  if (!text) return null;
  try {
    return assetAmount(asset, parseUnits(text, asset === 'USDC' ? 6 : 18), bound);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------------------------

type Ctx = Pick<SupervisorContext, 'db' | 'chain' | 'indexer' | 'now' | 'log'>;

/** Who an address is to this agent: its creator, one of its own wallets, or a person. */
function partyOf(agent: AgentRow, address: string): LedgerParty {
  const a = lc(address);
  if (a === lc(agent.creator)) return { role: 'creator', address: a };
  if (a === lc(agent.kernel) || (agent.spender && a === lc(agent.spender))) return { role: 'own_wallet', address: a };
  return { role: 'person', address: a };
}

/** The fee contract a coin of this launch path is paid from. */
function feeLockerOf(ctx: Ctx, agent: AgentRow): string | null {
  if (agent.source === 'clanker-v5') return ctx.chain.clankerV5.feeEscrow;
  if (agent.source === 'clanker') return ctx.chain.clanker.feeLocker;
  return ctx.chain.rwagmi.lpLocker;
}

function assetOfAddress(ctx: Ctx, address: string): LedgerAsset | null {
  const a = lc(address);
  if (a === lc(ctx.chain.addresses.usdc)) return 'USDC';
  if (a === lc(ctx.chain.addresses.weth)) return 'WETH';
  if (/^0x0{40}$/.test(a)) return 'ETH';
  return null;
}

type OpRow = typeof treasuryOps.$inferSelect;

const OP_STATUS: Record<string, LedgerStatus | undefined> = { confirmed: 'confirmed', failed: 'failed', sent: 'unknown', unknown: 'unknown' };

/** One treasury op as a ledger row: amounts from its calls (exact) or its description (written by code when prepared). */
export function opRow(ctx: Ctx, agent: AgentRow, op: OpRow, atMs: number): LedgerRow | null {
  const status = OP_STATUS[op.status];
  if (!status) return null;
  const base = { id: `op:${op.opId}`, at: isoMs(atMs), status, ...(op.txHash ? { txHash: op.txHash } : {}) };
  const d = op.description;
  const calls = Array.isArray(op.calls) ? op.calls : [];
  const failed = status === 'failed';
  switch (op.kind) {
    case 'claim_fees': {
      const m = /claim ([\d.]+) (WETH|USDC|ETH)/.exec(d);
      const amount = m && !failed ? parsedAmount(m[2] as LedgerAsset, m[1], 'about') : null;
      const locker = calls[calls.length - 1]?.to;
      return { ...base, kind: 'fee_claim', direction: 'in', ...(amount ? { amount } : {}), ...(locker ? { counterparty: { role: 'fee_locker', address: lc(locker) } } : {}), reason: failed ? 'Fee claim did not go through; nothing moved' : 'Collected its share of the trading fees' };
    }
    case 'fund_model': {
      const call = calls[0];
      let amount: LedgerAmount | null = null;
      let to: string | null = agent.spender;
      try {
        const dec = call ? decodeFunctionData({ abi: erc20Abi, data: call.data as `0x${string}` }) : null;
        if (dec?.functionName === 'transfer') {
          to = String(dec.args[0]);
          amount = usdcAmount(dec.args[1] as bigint);
        }
      } catch {
        amount = parsedAmount('USDC', /(?:with|transfer) ([\d.]+) USDC/.exec(d)?.[1]);
      }
      return { ...base, kind: 'fuel_topup', direction: 'move', ...(amount ? { amount } : {}), ...(to ? { counterparty: { role: 'own_wallet', address: lc(to) } } : {}), reason: failed ? 'Moving fuel to its thinking wallet did not go through' : 'Moved fuel to the wallet that pays for its thinking' };
    }
    case 'fund_gas': {
      const amount = parsedAmount('WETH', /unwrap ([\d.]+) WETH/.exec(d)?.[1]);
      return { ...base, kind: 'gas_topup', direction: 'move', ...(amount ? { amount } : {}), counterparty: { role: 'gas' }, reason: failed ? 'Gas top-up did not go through' : 'Turned WETH into ETH for its own transactions' };
    }
    case 'swap': {
      const m = /swap ([\d.]+) WETH -> ~>= ([\d.]+) USDC/.exec(d);
      const amount = m ? parsedAmount('WETH', m[1]) : null;
      const received = m && !failed ? parsedAmount('USDC', m[2], 'at_least') : null;
      const helper = calls[calls.length - 1]?.to;
      return { ...base, kind: 'swap', direction: 'move', ...(amount ? { amount } : {}), ...(received ? { received } : {}), ...(helper ? { counterparty: { role: 'swap', address: lc(helper) } } : {}), reason: failed ? 'Swap to fuel did not go through' : 'Swapped WETH to USDC for fuel' };
    }
    default: {
      // A transfer out: an ERC-20 `transfer(to, amount)` or plain ETH.
      const call = calls[0];
      let amount: LedgerAmount | null = null;
      let party: LedgerParty | null = null;
      try {
        if (call && BigInt(call.value || '0') > 0n) {
          amount = assetAmount('ETH', BigInt(call.value));
          party = partyOf(agent, call.to);
        } else if (call) {
          const dec = decodeFunctionData({ abi: erc20Abi, data: call.data as `0x${string}` });
          const asset = assetOfAddress(ctx, call.to);
          if (dec.functionName === 'transfer' && asset) {
            amount = assetAmount(asset, dec.args[1] as bigint);
            party = partyOf(agent, String(dec.args[0]));
          }
        }
      } catch {
        /* calls this module cannot read: the row keeps its tx and no amount */
      }
      return { ...base, kind: 'transfer', direction: 'out', ...(amount ? { amount } : {}), ...(party ? { counterparty: party } : {}), reason: failed ? 'Transfer did not go through' : 'Sent money from its wallet' };
    }
  }
}

async function opRows(ctx: Ctx, agent: AgentRow, cursor: LedgerCursor | null, take: number, indexedClaims: Set<string>): Promise<LedgerRow[]> {
  const at = msOf(sql`coalesce(${treasuryOps.sentAt}, ${treasuryOps.updatedAt})`);
  const id = idOf('op:', treasuryOps.opId);
  const hidden = [...indexedClaims];
  const rows = await ctx.db
    .select({ op: treasuryOps, atMs: sql<number>`${at}::float8` })
    .from(treasuryOps)
    .where(
      and(
        eq(treasuryOps.agentId, agent.agentId),
        inArray(treasuryOps.status, ['sent', 'unknown', 'confirmed', 'failed']),
        // A confirmed claim the indexer has is its `claim:` row; this one would count it twice.
        ...(hidden.length ? [sql`not (${treasuryOps.kind} = 'claim_fees' and ${treasuryOps.status} = 'confirmed' and lower(${treasuryOps.txHash}) in (${sql.join(hidden.map((h) => sql`${h}`), sql`, `)}))`] : []),
        ...keyset(at, id, cursor),
      ),
    )
    .orderBy(sql`${at} desc`, sql`${id} desc`)
    .limit(take);
  return rows.map((r) => opRow(ctx, agent, r.op, Number(r.atMs))).filter((r): r is LedgerRow => r !== null);
}

/** What an unsettled thought may have cost: signed, no outcome yet. A pending row this old crashed mid-flight. */
const STALE_PENDING_MS = 10 * 60_000;

async function thinkingRows(ctx: Ctx, agent: AgentRow, cursor: LedgerCursor | null, take: number): Promise<LedgerRow[]> {
  const stale = new Date(ctx.now() - STALE_PENDING_MS);
  const open = sql`((${inference.status} = 'unknown' or (${inference.status} = 'pending' and ${inference.createdAt} < ${stale})) and ${inference.receipt}->'payment' is not null)`;
  const day = sql`to_char(${inference.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const route = sql`case when ${inference.receipt}->>'route' = 'blockrun' then 'blockrun' else 'relay' end`;
  const state = sql`case when ${PAID_CALL} then 'paid' else 'open' end`;
  const signed = sql`(${inference.receipt}->'payment'->'accepted'->>'amount')::numeric`;
  // A day holds at most four groups (two payees, paid or open): enough whole days for `take` rows and one spare day.
  const groups = take * 4 + 4;
  const dayEnd = cursor ? new Date(Math.floor(cursor.at / 86_400_000) * 86_400_000 + 86_400_000) : null;
  const rows = await ctx.db
    .select({
      day: sql<string>`${day}`,
      route: sql<string>`${route}`,
      state: sql<string>`${state}`,
      atMs: sql<number>`${msOf(sql`max(${inference.createdAt})`)}::float8`,
      thoughts: sql<number>`count(*) filter (where ${inference.request}->'modalities' is null)::int`,
      pictures: sql<number>`count(*) filter (where ${inference.request}->'modalities' is not null)::int`,
      amount: sql<string>`coalesce(sum(case when ${PAID_CALL} then ${CHARGED_MICRO_USDC} else ${signed} end), 0)::text`,
      payTo: sql<string | null>`max(${inference.receipt}->'payment'->'accepted'->>'payTo')`,
    })
    .from(inference)
    .where(and(eq(inference.agentId, agent.agentId), sql`(${PAID_CALL} or ${open})`, ...(dayEnd ? [sql`${inference.createdAt} < ${dayEnd}`] : [])))
    .groupBy(sql`1`, sql`2`, sql`3`)
    .orderBy(sql`1 desc`)
    .limit(groups);
  // A full read may have cut its oldest day short: that day is left to the next read.
  const lastDay = rows.length === groups ? rows[rows.length - 1]!.day : null;
  const out: LedgerRow[] = [];
  for (const r of rows) {
    if (lastDay && r.day === lastDay) continue;
    const thoughts = Number(r.thoughts);
    const pictures = Number(r.pictures);
    const what = [thoughts ? `${thoughts} ${thoughts === 1 ? 'thought' : 'thoughts'}` : '', pictures ? `${pictures} ${pictures === 1 ? 'picture' : 'pictures'}` : ''].filter(Boolean).join(' and ');
    const paid = r.state === 'paid';
    const raw = String(r.amount).replace(/\.\d*$/, '');
    const row: LedgerRow = {
      id: `think:${r.day}:${r.route}:${r.state}`,
      at: isoMs(Number(r.atMs)),
      kind: 'thinking',
      direction: 'out',
      status: paid ? 'confirmed' : 'unknown',
      amount: usdcAmount(/^\d+$/.test(raw) ? raw : '0', paid ? undefined : 'at_most'),
      counterparty: { role: r.route === 'blockrun' ? 'blockrun' : 'thinking_service', ...(r.payTo && /^0x[0-9a-fA-F]{40}$/.test(r.payTo) ? { address: lc(r.payTo) } : {}) },
      reason: paid ? `Paid for ${what || 'its thinking'} on ${r.day} (UTC)` : `${what || 'Thinking'} on ${r.day} (UTC) signed for, the payment not settled yet`,
    };
    if (afterCursor(row, cursor)) out.push(row);
  }
  return out;
}

async function serviceRows(ctx: Ctx, agent: AgentRow, cursor: LedgerCursor | null, take: number): Promise<LedgerRow[]> {
  const at = msOf(serviceCalls.createdAt);
  const id = idOf('svc:', serviceCalls.id);
  const charged = sql`coalesce(${serviceCalls.chargedMicroUsdc}, ${serviceCalls.quoteMicroUsdc}, '0')::numeric`;
  const moved = sql`(${serviceCalls.status} in ('succeeded', 'paid', 'unknown') or ${serviceCalls.error} = ${SERVICES_PAID_NO_ANSWER})`;
  const rows = await ctx.db
    .select({ row: serviceCalls, atMs: sql<number>`${at}::float8` })
    .from(serviceCalls)
    .where(and(eq(serviceCalls.agentId, agent.agentId), moved, sql`${charged} > 0`, ...keyset(at, id, cursor)))
    .orderBy(sql`${at} desc`, sql`${id} desc`)
    .limit(take);
  return rows.map(({ row, atMs }) => {
    const settled = row.status === 'succeeded' || row.error === SERVICES_PAID_NO_ANSWER;
    const raw = row.chargedMicroUsdc ?? row.quoteMicroUsdc ?? '0';
    return {
      id: `svc:${row.id}`,
      at: isoMs(Number(atMs)),
      kind: 'service',
      direction: 'out',
      status: settled ? 'confirmed' : 'unknown',
      amount: usdcAmount(raw, settled ? undefined : 'at_most'),
      counterparty: { role: 'service', host: row.host, ...(row.payTo && /^0x[0-9a-fA-F]{40}$/.test(row.payTo) ? { address: lc(row.payTo) } : {}) },
      reason: row.status === 'succeeded' ? row.reason : settled ? `${row.reason} (paid, no answer came back)` : row.reason,
      ...(row.txHash ? { txHash: row.txHash } : {}),
    } satisfies LedgerRow;
  });
}

type JobRow = typeof bountyJobs.$inferSelect;
const shortTask = (task: string) => (task.length > 120 ? `${task.slice(0, 117).trimEnd()}...` : task);
const postLink = (job: JobRow) => (job.postId && /^\d{1,25}$/.test(job.postId) ? { url: `https://x.com/i/status/${job.postId}` } : {});

function closedReason(job: JobRow): string {
  if (job.status === 'cancelled') return job.openedAt ? 'Bounty cancelled, nothing paid' : 'Bounty draft withdrawn before it was posted';
  if (job.status === 'expired') return 'The winner was never paid: the proposal expired';
  if (job.status === 'failed') return job.openedAt ? 'Bounty closed: the replies could not be read, nothing paid' : 'Bounty could not be posted';
  if (job.error?.startsWith('declined')) return 'Bounty closed: the creator declined the winner, nothing paid';
  if (job.error === 'judge_absent') return 'Bounty closed: the entries were not judged in time, nothing paid';
  return `Bounty closed: no entry met the job (${job.entriesReceived} ${job.entriesReceived === 1 ? 'reply' : 'replies'}), nothing paid`;
}

async function bountyRows(ctx: Ctx, agent: AgentRow, cursor: LedgerCursor | null, take: number): Promise<LedgerRow[]> {
  const event = async (name: string, col: typeof bountyJobs.openedAt, cond: SQL | undefined, build: (job: JobRow) => Omit<LedgerRow, 'id' | 'at'>): Promise<LedgerRow[]> => {
    const at = msOf(col);
    const id = idOf('bounty:', sql`${bountyJobs.id} || ${`:${name}`}`);
    const rows = await ctx.db
      .select({ job: bountyJobs, atMs: sql<number>`${at}::float8` })
      .from(bountyJobs)
      .where(and(eq(bountyJobs.agentId, agent.agentId), isNotNull(col), ...(cond ? [cond] : []), ...keyset(at, id, cursor)))
      .orderBy(sql`${at} desc`, sql`${id} desc`)
      .limit(take);
    return rows.map(({ job, atMs }) => ({ id: `bounty:${job.id}:${name}`, at: isoMs(Number(atMs)), ...build(job) }));
  };
  const lists = await Promise.all([
    event('posted', bountyJobs.openedAt, undefined, (job) => ({ kind: 'bounty_posted', direction: 'none', status: 'confirmed', amount: usdcAmount(job.amountMicroUsdc), reason: `Offered a bounty: ${shortTask(job.task)}`, ...postLink(job) })),
    event('judged', bountyJobs.judgedAt, ne(bountyJobs.status, 'no_winner'), (job) => {
      const winner = (job.verdict as { winner?: unknown } | null)?.winner;
      return { kind: 'bounty_judged', direction: 'none', status: 'confirmed', reason: `Judged its bounty: entry ${typeof winner === 'number' ? winner : '?'} of ${job.entriesConsidered} won`, ...postLink(job) };
    }),
    event('paid', bountyJobs.paidAt, eq(bountyJobs.status, 'paid'), (job) => ({
      kind: 'bounty_paid',
      direction: 'out',
      status: 'confirmed',
      amount: usdcAmount(job.amountMicroUsdc),
      ...(job.payee && /^0x[0-9a-fA-F]{40}$/.test(job.payee) ? { counterparty: { role: 'bounty_winner' as const, address: lc(job.payee) } } : {}),
      reason: 'Paid the winner of its bounty, from its creator’s wallet',
      paidBy: 'creator',
      ...(job.txHash && /^0x[0-9a-fA-F]{64}$/.test(job.txHash) ? { txHash: job.txHash } : {}),
    })),
    event('closed', bountyJobs.closedAt, inArray(bountyJobs.status, ['no_winner', 'cancelled', 'expired', 'failed']), (job) => ({ kind: 'bounty_closed', direction: 'none', status: 'confirmed', reason: closedReason(job), ...postLink(job) })),
  ]);
  return lists.flat().sort(compareRows).slice(0, take);
}

// ---------------------------------------------------------------------------------------------
// The indexer: fee claims and money sent to the wallet
// ---------------------------------------------------------------------------------------------

interface ChainRow {
  id: string;
  timestamp: number;
  amount: string;
  amountUsd: number;
  txHash: string;
  asset?: string;
  from?: string;
}

const CLAIM_FIELDS = 'id timestamp amount amountUsd txHash asset';
const FUEL_FIELDS = 'id timestamp amount amountUsd txHash from';

/** The most of the agent's own transactions the fuel read leaves out; an agent with more says nothing older is hidden. */
const OWN_TX_MAX = 1000;
/** Rows of one block second the indexer is asked for; no wallet gets this many in one second. */
const SAME_SECOND_MAX = 1000;

function chainRowsOf(data: Record<string, unknown> | null, key: string): ChainRow[] | null {
  const items = (data?.[key] as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return null;
  const out: ChainRow[] = [];
  for (const it of items as Record<string, unknown>[]) {
    const timestamp = Number(it.timestamp);
    const amount = typeof it.amount === 'string' || typeof it.amount === 'number' ? String(it.amount) : '';
    if (typeof it.id !== 'string' || !Number.isSafeInteger(timestamp) || !/^\d{1,40}$/.test(amount) || typeof it.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(it.txHash)) continue;
    out.push({ id: it.id, timestamp, amount, amountUsd: Number(it.amountUsd) || 0, txHash: lc(it.txHash), ...(typeof it.asset === 'string' ? { asset: it.asset } : {}), ...(typeof it.from === 'string' ? { from: it.from } : {}) });
  }
  return out;
}

interface ListPart {
  alias: string;
  field: 'feeClaims' | 'fuels';
  where: Record<string, unknown>;
  fields: string;
  limit: number;
}

/** Several of the indexer's lists in one GraphQL request; the filters travel as variables, never in the query text. */
async function readLists(ctx: Ctx, name: string, parts: readonly ListPart[]): Promise<Record<string, unknown> | null> {
  const vars = parts.map((p, i) => `$w${i}: ${p.field === 'fuels' ? 'fuelFilter' : 'feeClaimFilter'}`).join(', ');
  const body = parts.map((p, i) => `${p.alias}: ${p.field}(where: $w${i}, orderBy: "timestamp", orderDirection: "desc", limit: ${p.limit}) { items { ${p.fields} } }`).join('\n');
  return ctx.indexer.graphql(`query ${name}(${vars}) { ${body} }`, Object.fromEntries(parts.map((p, i) => [`w${i}`, p.where]))).catch(() => null);
}

interface ChainRead {
  claims: LedgerRow[];
  fuel: LedgerRow[];
  /** Transactions of confirmed claim ops the indexer already has (their op rows are hidden). */
  indexedClaims: Set<string>;
  ok: boolean;
}

/**
 * The indexer's rows after the cursor, `take` of each kind at least when it has them. Its lists are ordered by block
 * second (and its own key), so a read takes the cursor's second whole, `take` rows strictly older, and then the whole
 * second of the oldest of those: no row is left behind inside a second, whatever order the indexer gives ties.
 */
async function chainRows(ctx: Ctx, agent: AgentRow, cursor: LedgerCursor | null, take: number): Promise<ChainRead> {
  const kernel = lc(agent.kernel);
  const ownOps = await ctx.db
    .select({ kind: treasuryOps.kind, status: treasuryOps.status, txHash: treasuryOps.txHash })
    .from(treasuryOps)
    .where(and(eq(treasuryOps.agentId, agent.agentId), isNotNull(treasuryOps.txHash)))
    .orderBy(desc(treasuryOps.createdAt))
    .limit(OWN_TX_MAX);
  const ownTx = [...new Set(ownOps.map((o) => lc(o.txHash)))];
  const claimTx = [...new Set(ownOps.filter((o) => o.kind === 'claim_fees' && o.status === 'confirmed').map((o) => lc(o.txHash)))];
  const notFuel = [ctx.chain.addresses.bootr.swapHelper, ctx.chain.addresses.uniswap.poolManager, ctx.chain.addresses.uniswap.universalRouter, ctx.chain.addresses.uniswap.swapRouter02, ctx.chain.rwagmi.lpLocker, ctx.chain.clanker.feeLocker, ctx.chain.clankerV5.feeEscrow].filter((a): a is Address => !!a).map(lc);
  const sec = cursor ? Math.floor(cursor.at / 1000) : null;
  const claimWhere = { recipient: kernel };
  const fuelWhere = { kernel, ...(ownTx.length ? { txHash_not_in: ownTx } : {}), ...(notFuel.length ? { from_not_in: notFuel } : {}) };
  const parts: ListPart[] = [
    { alias: 'claims', field: 'feeClaims', where: { ...claimWhere, ...(sec !== null ? { timestamp_lt: sec } : {}) }, fields: CLAIM_FIELDS, limit: take },
    { alias: 'fuel', field: 'fuels', where: { ...fuelWhere, ...(sec !== null ? { timestamp_lt: sec } : {}) }, fields: FUEL_FIELDS, limit: take },
    ...(sec !== null
      ? [
          { alias: 'claimsAt', field: 'feeClaims' as const, where: { ...claimWhere, timestamp: sec }, fields: CLAIM_FIELDS, limit: SAME_SECOND_MAX },
          { alias: 'fuelAt', field: 'fuels' as const, where: { ...fuelWhere, timestamp: sec }, fields: FUEL_FIELDS, limit: SAME_SECOND_MAX },
        ]
      : []),
    ...(claimTx.length ? [{ alias: 'indexed', field: 'feeClaims' as const, where: { recipient: kernel, txHash_in: claimTx }, fields: 'txHash', limit: SAME_SECOND_MAX }] : []),
  ];
  const data = await readLists(ctx, 'Ledger', parts);
  const claims = chainRowsOf(data, 'claims');
  const fuel = chainRowsOf(data, 'fuel');
  if (!claims || !fuel) return { claims: [], fuel: [], indexedClaims: new Set(), ok: false };
  const all = { claims: [...claims, ...(chainRowsOf(data, 'claimsAt') ?? [])], fuel: [...fuel, ...(chainRowsOf(data, 'fuelAt') ?? [])] };
  // The oldest second of a full list may hold more rows than the list showed: read that second whole.
  const tail: ListPart[] = [
    ...(claims.length === take ? [{ alias: 'claimsTail', field: 'feeClaims' as const, where: { ...claimWhere, timestamp: claims[claims.length - 1]!.timestamp }, fields: CLAIM_FIELDS, limit: SAME_SECOND_MAX }] : []),
    ...(fuel.length === take ? [{ alias: 'fuelTail', field: 'fuels' as const, where: { ...fuelWhere, timestamp: fuel[fuel.length - 1]!.timestamp }, fields: FUEL_FIELDS, limit: SAME_SECOND_MAX }] : []),
  ];
  let ok = true;
  if (tail.length) {
    const more = await readLists(ctx, 'LedgerTail', tail);
    if (!more) ok = false;
    all.claims.push(...(chainRowsOf(more, 'claimsTail') ?? []));
    all.fuel.push(...(chainRowsOf(more, 'fuelTail') ?? []));
  }
  const dedupe = (rows: ChainRow[]) => [...new Map(rows.map((r) => [r.id, r])).values()];
  const indexedClaims = new Set((((data?.indexed as { items?: { txHash?: unknown }[] } | undefined)?.items ?? []).map((i) => lc(String(i.txHash ?? '')))).filter((h) => /^0x[0-9a-f]{64}$/.test(h)));
  const locker = feeLockerOf(ctx, agent);
  const claimRows = dedupe(all.claims).flatMap((r): LedgerRow[] => {
    const asset = assetOfAddress(ctx, r.asset ?? '');
    if (!asset) return [];
    const amount = assetAmount(asset, BigInt(r.amount));
    if (asset !== 'USDC' && r.amountUsd > 0) amount.usd = r.amountUsd;
    return [{ id: `claim:${r.id}`, at: isoMs(r.timestamp * 1000), kind: 'fee_claim', direction: 'in', status: 'confirmed', amount, ...(locker ? { counterparty: { role: 'fee_locker', address: lc(locker) } } : {}), reason: 'Collected its share of the trading fees', txHash: r.txHash }];
  });
  const fuelRows = dedupe(all.fuel).map((r): LedgerRow => {
    const party = partyOf(agent, r.from ?? '');
    return { id: `fuel:${r.id}`, at: isoMs(r.timestamp * 1000), kind: 'fuel_received', direction: 'in', status: 'confirmed', amount: usdcAmount(r.amount), counterparty: party, reason: party.role === 'creator' ? 'Its creator sent it fuel' : party.role === 'own_wallet' ? 'Fuel came back from its own wallet' : 'Someone sent it fuel', txHash: r.txHash };
  });
  return { claims: claimRows.filter((r) => afterCursor(r, cursor)), fuel: fuelRows.filter((r) => afterCursor(r, cursor)), indexedClaims, ok };
}

// ---------------------------------------------------------------------------------------------
// Pages, ranges and daily totals
// ---------------------------------------------------------------------------------------------

export interface LedgerPage {
  rows: LedgerRow[];
  /** The cursor of the next page, or null at the end. */
  next: string | null;
  /** True when the chain rows (fee claims, money sent to it) could not be read: the page holds the rest. */
  partial: boolean;
}

export interface LedgerQuery {
  limit?: number | undefined;
  cursor?: LedgerCursor | null | undefined;
}

export async function ledgerPage(ctx: Ctx, agent: AgentRow, query: LedgerQuery = {}): Promise<LedgerPage> {
  const limit = Math.min(LEDGER_MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? LEDGER_DEFAULT_LIMIT)));
  const cursor = query.cursor ?? null;
  const take = limit + 1;
  const chain = await chainRows(ctx, agent, cursor, take);
  const lists = await Promise.all([opRows(ctx, agent, cursor, take, chain.indexedClaims), thinkingRows(ctx, agent, cursor, take), serviceRows(ctx, agent, cursor, take), bountyRows(ctx, agent, cursor, take)]);
  const merged = [...chain.claims, ...chain.fuel, ...lists.flat()].sort(compareRows);
  const rows = merged.slice(0, limit);
  const last = rows[rows.length - 1];
  return { rows, next: merged.length > limit && last ? encodeCursor({ at: Date.parse(last.at), id: last.id }) : null, partial: !chain.ok };
}

/** The most rows a range read takes before it stops and says so: about a month of a busy agent. */
export const LEDGER_RANGE_MAX_ROWS = 5000;

/**
 * Every row with `from <= at < to`, newest first, read page by page through `ledgerPage`: what the daily totals and
 * the report card sum. `complete` is false when the read stopped at `LEDGER_RANGE_MAX_ROWS` or a page lacked the chain.
 */
export async function ledgerRowsBetween(ctx: Ctx, agent: AgentRow, from: Date, to: Date): Promise<{ rows: LedgerRow[]; complete: boolean }> {
  const rows: LedgerRow[] = [];
  let cursor: LedgerCursor | null = { at: to.getTime(), id: '' };
  let complete = true;
  while (cursor) {
    const page = await ledgerPage(ctx, agent, { limit: LEDGER_MAX_LIMIT, cursor });
    if (page.partial) complete = false;
    for (const r of page.rows) {
      if (Date.parse(r.at) < from.getTime()) return { rows, complete };
      rows.push(r);
    }
    if (rows.length >= LEDGER_RANGE_MAX_ROWS) return { rows, complete: false };
    cursor = page.next ? decodeCursor(page.next) : null;
  }
  return { rows, complete };
}

export interface LedgerDayLine {
  kind: LedgerKind;
  direction: LedgerDirection;
  asset: LedgerAsset;
  decimals: number;
  raw: string;
  /** The dollar value when every row of the line has one. */
  usd: number | null;
  count: number;
  paidBy?: 'creator';
}

export interface LedgerDay {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Confirmed rows, per kind and asset. */
  lines: LedgerDayLine[];
  /** Dollar sums of the agent's own money in and out, when every line has a value; null when one does not. */
  inUsd: number | null;
  outUsd: number | null;
  /** Rows of the day still `unknown`, not in any sum. */
  unknown: number;
  failed: number;
}

/** Daily totals of confirmed rows. A bounty paid from the creator's wallet and a promise are lines, never in `inUsd`/`outUsd`. */
export function ledgerDays(rows: readonly LedgerRow[], days: readonly string[]): LedgerDay[] {
  const out = new Map<string, LedgerDay>(days.map((d) => [d, { day: d, lines: [], inUsd: 0, outUsd: 0, unknown: 0, failed: 0 }]));
  for (const r of rows) {
    const day = out.get(r.at.slice(0, 10));
    if (!day) continue;
    if (r.status === 'unknown') day.unknown += 1;
    if (r.status === 'failed') day.failed += 1;
    if (r.status !== 'confirmed' || !r.amount) continue;
    const a = r.amount;
    let line = day.lines.find((l) => l.kind === r.kind && l.asset === a.asset);
    if (!line) {
      line = { kind: r.kind, direction: r.direction, asset: a.asset, decimals: a.decimals, raw: '0', usd: 0, count: 0, ...(r.paidBy ? { paidBy: r.paidBy } : {}) };
      day.lines.push(line);
    }
    line.raw = (BigInt(line.raw) + BigInt(a.raw)).toString();
    line.count += 1;
    line.usd = line.usd === null || a.usd === undefined ? null : Math.round((line.usd + a.usd) * 1e6) / 1e6;
  }
  for (const day of out.values()) {
    for (const dir of ['in', 'out'] as const) {
      const own = day.lines.filter((l) => l.direction === dir && !l.paidBy);
      const sum = own.some((l) => l.usd === null) ? null : Math.round(own.reduce((s, l) => s + (l.usd ?? 0), 0) * 100) / 100;
      if (dir === 'in') day.inUsd = sum;
      else day.outUsd = sum;
    }
  }
  return [...out.values()];
}

/** The last `n` UTC days, today first. */
export function lastDays(nowMs: number, n: number): string[] {
  const start = Math.floor(nowMs / 86_400_000) * 86_400_000;
  return Array.from({ length: n }, (_, i) => new Date(start - i * 86_400_000).toISOString().slice(0, 10));
}

/** The first page and the totals of the last `LEDGER_DAYS` days: what the coin's ledger page opens with. */
export async function ledgerSummary(ctx: Ctx, agent: AgentRow): Promise<{ days: LedgerDay[]; complete: boolean }> {
  const days = lastDays(ctx.now(), LEDGER_DAYS);
  const from = new Date(`${days[days.length - 1]}T00:00:00.000Z`);
  const { rows, complete } = await ledgerRowsBetween(ctx, agent, from, new Date(ctx.now() + 60_000));
  return { days: ledgerDays(rows, days), complete };
}
