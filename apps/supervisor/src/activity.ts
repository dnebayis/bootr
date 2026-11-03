/**
 * The coin page's activity tape (`GET /internal/agents/:id/activity`): one newest-first list merged from
 *   - `sv_actions`: completed posts, replies and images (`generate_image`), and `config_updated` rows (creator edits);
 *   - `sv_treasury_ops`: confirmed and failed fee claims, swaps, gas and fuel top-ups;
 *   - the runtime's current status (sleeping, paused, held, awake). The supervisor keeps no history of status
 *     changes, so this is one item at `sv_runtimes.updated_at`, not a log of every sleep and wake.
 *   - `sv_approvals`: posts waiting for the creator's review, approvals (the sent post is its own `post` row) and
 *     rejections; texts and notes stay private (this is a public read).
 * `kind` groups the web's filters: Posts = `post` | `reply`; Treasury = `claim` | `swap` | `gas` | `fuel` | `transfer`;
 * `image` (a picture made with `generate_image`) and `approval_*` show under All.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { AgentRow, RuntimeRow, SupervisorContext, TreasuryOpRow } from './context.js';
import { approvalActivity } from './approvals.js';
import { actions, treasuryOps } from './db/schema.js';

export type ActivityKind = 'post' | 'reply' | 'image' | 'config' | 'claim' | 'swap' | 'gas' | 'fuel' | 'transfer' | 'status' | 'approval_pending' | 'approval_approved' | 'approval_rejected';

export interface ActivityItem {
  /** ISO timestamp. */
  at: string;
  kind: ActivityKind;
  /** One short human line ("Posted on X", "Claimed 0.0024 WETH"). */
  summary: string;
  txHash?: string;
  /** The post on X or the tx on the explorer. */
  url?: string;
}

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;

export function explorerTxUrl(chainId: number, txHash: string): string {
  return `${chainId === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org'}/tx/${txHash}`;
}

/** "0.002400" -> "0.0024", "4.50" -> "4.5", tiny amounts keep two significant digits instead of rounding to 0. */
export function shortAmount(raw: string, decimals: number): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  let out = n.toFixed(decimals);
  if (Number(out) === 0 && n > 0) out = n.toFixed(Math.min(18, -Math.floor(Math.log10(n)) + 1));
  return out.includes('.') ? out.replace(/0+$/, '').replace(/\.$/, '') : out;
}

const FIELD_LABELS: Record<string, string> = { instructions: 'instructions', model: 'model', powers: 'powers', cadence: 'cadence', jobLines: 'job lines', requireApproval: 'post review' };

function actionItem(row: typeof actions.$inferSelect, xHandle: string | null): ActivityItem | null {
  const a = row.action as { tool?: unknown; kind?: unknown; fields?: unknown };
  if (a.kind === 'config_updated') {
    const fields = Array.isArray(a.fields) ? a.fields.map((f) => FIELD_LABELS[String(f)] ?? String(f)) : [];
    return { at: row.createdAt.toISOString(), kind: 'config', summary: fields.length ? `Config updated: ${fields.join(', ')}` : 'Config updated' };
  }
  if (row.status !== 'completed') return null;
  if (a.tool === 'generate_image') {
    const alt = (row.result as { result?: { alt?: unknown } } | null)?.result?.alt ?? (a as { input?: { altText?: unknown } }).input?.altText;
    return { at: row.createdAt.toISOString(), kind: 'image', summary: typeof alt === 'string' && alt ? `Made an image: ${alt}` : 'Made an image' };
  }
  if (a.tool !== 'publish_post' && a.tool !== 'publish_reply') return null;
  // The row holds either the bare result or the agent-core ActionResult envelope (`{status, result: {...}}`).
  const res = (row.result ?? {}) as { postId?: unknown; result?: { postId?: unknown; queued?: unknown } };
  // A publish queued for the creator's review is on the tape as `approval_pending`, not as a post.
  if (res.result?.queued === true) return null;
  const postId = res.postId ?? res.result?.postId;
  const url = typeof postId === 'string' && xHandle ? `https://x.com/${xHandle}/status/${postId}` : undefined;
  return { at: row.createdAt.toISOString(), kind: a.tool === 'publish_post' ? 'post' : 'reply', summary: a.tool === 'publish_post' ? 'Posted on X' : 'Replied on X', ...(url ? { url } : {}) };
}

/** The op's amounts come from its stored description (treasury.ts writes them; the calls are raw calldata). */
function opSummary(op: TreasuryOpRow): { kind: ActivityKind; summary: string } {
  const d = op.description;
  const failed = op.status === 'failed';
  switch (op.kind) {
    case 'claim_fees': {
      const m = /claim ([\d.]+) WETH/.exec(d);
      return { kind: 'claim', summary: failed ? 'Fee claim failed' : m ? `Claimed ${shortAmount(m[1]!, 6)} WETH` : 'Claimed fees' };
    }
    case 'swap': {
      const m = /swap ([\d.]+) WETH -> ~>= ([\d.]+) USDC/.exec(d);
      return { kind: 'swap', summary: failed ? 'Swap failed' : m ? `Swapped ${shortAmount(m[1]!, 6)} WETH to at least ${shortAmount(m[2]!, 2)} USDC` : 'Swapped WETH to USDC' };
    }
    case 'fund_gas': {
      const m = /unwrap ([\d.]+) WETH/.exec(d);
      return { kind: 'gas', summary: failed ? 'Gas top-up failed' : m ? `Added gas (${shortAmount(m[1]!, 6)} WETH)` : 'Added gas' };
    }
    case 'fund_model': {
      const m = /(?:with|transfer) ([\d.]+) USDC/.exec(d);
      return { kind: 'fuel', summary: failed ? 'Fuel top-up failed' : m ? `Added ${shortAmount(m[1]!, 2)} USDC of fuel` : 'Added fuel' };
    }
    default:
      return { kind: 'transfer', summary: failed ? 'Transfer failed' : 'Transferred funds' };
  }
}

function opItem(chainId: number, op: TreasuryOpRow): ActivityItem | null {
  if (op.status !== 'confirmed' && op.status !== 'failed') return null;
  const at = (op.status === 'confirmed' ? (op.confirmedAt ?? op.updatedAt) : op.updatedAt).toISOString();
  const { kind, summary } = opSummary(op);
  return { at, kind, summary, ...(op.txHash ? { txHash: op.txHash, url: explorerTxUrl(chainId, op.txHash) } : {}) };
}

/** The current status as one tape item (no history is kept; see the module comment). */
export function statusItem(agent: AgentRow, runtime: RuntimeRow | null): ActivityItem {
  const at = (runtime?.updatedAt ?? agent.updatedAt).toISOString();
  const xHandle = (agent.config as { xHandle?: unknown }).xHandle;
  let summary: string;
  if (agent.status === 'onboarding') summary = xHandle ? 'Onboarding: installing the session key' : 'Sleeping: waiting for an X account';
  else if (agent.status === 'revoked') summary = 'Revoked';
  else if (!runtime) summary = 'Awake';
  else if (runtime.status === 'sleeping') summary = 'Went to sleep: fuel below 1 USDC';
  else if (runtime.status === 'paused') summary = runtime.pausedBy === 'guardian' ? 'Paused by creator' : 'Paused by operator';
  else if (runtime.status === 'held') summary = 'Waiting on a held action';
  else if (runtime.status === 'running') summary = 'Awake: working';
  else summary = 'Awake';
  return { at, kind: 'status', summary };
}

export interface ActivityQuery {
  limit?: number | undefined;
  /** Only items strictly older than this instant. */
  before?: Date | undefined;
}

export async function agentActivity(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow | null, query: ActivityQuery = {}): Promise<ActivityItem[]> {
  const limit = Math.min(ACTIVITY_MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? ACTIVITY_DEFAULT_LIMIT)));
  const before = query.before;
  const xHandle = typeof (agent.config as { xHandle?: unknown }).xHandle === 'string' ? ((agent.config as { xHandle: string }).xHandle) : null;
  // Each source gives its `limit` newest rows (older than the cursor); the merge keeps the newest `limit` overall.
  const tapeActions = sql`(${actions.action}->>'tool' in ('publish_post', 'publish_reply', 'generate_image') or ${actions.action}->>'kind' = 'config_updated')`;
  const [actionRows, opRows, approvalItems] = await Promise.all([
    ctx.db
      .select()
      .from(actions)
      .where(before ? and(eq(actions.agentId, agent.agentId), lt(actions.createdAt, before), tapeActions) : and(eq(actions.agentId, agent.agentId), tapeActions))
      .orderBy(desc(actions.createdAt))
      .limit(limit),
    ctx.db
      .select()
      .from(treasuryOps)
      .where(before ? and(eq(treasuryOps.agentId, agent.agentId), lt(treasuryOps.updatedAt, before)) : eq(treasuryOps.agentId, agent.agentId))
      .orderBy(desc(treasuryOps.updatedAt))
      .limit(limit),
    approvalActivity(ctx, agent, limit, before),
  ]);
  const items: ActivityItem[] = [];
  for (const row of actionRows) {
    const item = actionItem(row, xHandle);
    if (item) items.push(item);
  }
  for (const op of opRows) {
    const item = opItem(ctx.chain.chainId, op);
    if (item && (!before || Date.parse(item.at) < before.getTime())) items.push(item);
  }
  for (const item of approvalItems) if (!before || Date.parse(item.at) < before.getTime()) items.push(item);
  const status = statusItem(agent, runtime);
  if (!before || Date.parse(status.at) < before.getTime()) items.push(status);
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return items.slice(0, limit);
}
