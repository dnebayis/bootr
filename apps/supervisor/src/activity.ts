/**
 * The coin page's activity tape (`GET /internal/agents/:id/activity`): one newest-first list merged from
 *   - `sv_actions`: completed posts, replies and images (`generate_image`, or `upload_picture` of an own agent), and
 *     `config_updated` rows (creator edits, a client connected or disconnected, the runner switched). A row an own
 *     agent's client made (`action.via === 'own'`, docs/design/byo-agent.md section 3.5) says so after its summary;
 *   - `sv_treasury_ops`: confirmed and failed fee claims, swaps, gas and fuel top-ups;
 *   - the runtime's current status (sleeping, paused, held, awake). The supervisor keeps no history of status
 *     changes, so this is one item at `sv_runtimes.updated_at`, not a log of every sleep and wake.
 *   - `sv_approvals`: posts waiting for the creator's review, approvals (the sent post is its own `post` row) and
 *     rejections; texts and notes stay private (this is a public read).
 *   - `sv_service_calls`: paid web services (`x402_fetch`): host, amount and the model's reason, answered or lost;
 *   - `sv_bounty_jobs`: one row per job event (posted, judged, paid, no winner, cancelled, expired), in plain words
 *     with no address (bounties.ts `bountyActivity`).
 * `kind` groups the web's filters: Posts = `post` | `reply`; Treasury = `claim` | `swap` | `gas` | `fuel` | `transfer` | `service` | `bounty`;
 * `image` (a picture made with `generate_image`) and `approval_*` show under All.
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { AgentRow, RuntimeRow, SupervisorContext, TreasuryOpRow } from './context.js';
import { approvalActivity } from './approvals.js';
import { bountyActivity } from './bounties.js';
import { actions, images, treasuryOps } from './db/schema.js';
import { tapeServiceCalls, type ServiceCallRow } from './services.js';
import { formatUnits } from 'viem';

export type ActivityKind = 'post' | 'reply' | 'image' | 'config' | 'claim' | 'swap' | 'gas' | 'fuel' | 'transfer' | 'service' | 'bounty' | 'status' | 'approval_pending' | 'approval_approved' | 'approval_rejected';

export interface ActivityItem {
  /** ISO timestamp. */
  at: string;
  kind: ActivityKind;
  /** One short human line ("Posted on X", "Claimed 0.0024 WETH"). */
  summary: string;
  txHash?: string;
  /** The post on X or the tx on the explorer. */
  url?: string;
  /**
   * A `post` or `reply` that went out with a picture: the picture's id and alt text (the alt text is public: X shows
   * it). The bytes are not served here (an image row is a few hundred KB and the tape is a public read); the web can
   * show the alt text as a caption or let the X link carry the picture, and a `GET .../images/:id` route would be the
   * place to serve bytes if a thumbnail is ever wanted. `alt` is null when the stored picture is gone (retention).
   */
  image?: { id: string; alt: string | null };
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

/** What a row made by an own agent's client carries after its summary. */
export const OWN_AGENT_MARK = ' · own agent';

const FIELD_LABELS: Record<string, string> = { runner: 'who runs the agent', clientConnected: 'AI client connected', clientDisconnected: 'AI client disconnected', instructions: 'instructions', model: 'model', powers: 'powers', cadence: 'cadence', postsPerDay: 'posts per day', jobLines: 'job lines', requireApproval: 'post review', imageModel: 'image model', imageStyle: 'image style', routing: 'economy mode', services: 'paid services caps', bounties: 'bounty caps', treasuryTurn: 'treasury turn', judgeModel: 'judge model' };

function actionItem(row: typeof actions.$inferSelect, xHandle: string | null): ActivityItem | null {
  const item = plainActionItem(row, xHandle);
  // Who thought is part of the public record: a row an own agent's client made says so (no client id, no private detail).
  if (item && item.kind !== 'config' && (row.action as { via?: unknown }).via === 'own') item.summary += OWN_AGENT_MARK;
  return item;
}

function plainActionItem(row: typeof actions.$inferSelect, xHandle: string | null): ActivityItem | null {
  const a = row.action as { tool?: unknown; kind?: unknown; fields?: unknown; by?: unknown; summary?: unknown };
  if (a.kind === 'config_updated') {
    // A change the platform made (model-migration.ts) says so in its own sentence; the creator's edits list the fields.
    if (a.by === 'platform' && typeof a.summary === 'string' && a.summary) return { at: row.createdAt.toISOString(), kind: 'config', summary: a.summary.slice(0, 300) };
    const fields = Array.isArray(a.fields) ? a.fields.map((f) => FIELD_LABELS[String(f)] ?? String(f)) : [];
    return { at: row.createdAt.toISOString(), kind: 'config', summary: fields.length ? `Config updated: ${fields.join(', ')}` : 'Config updated' };
  }
  if (row.status !== 'completed') return null;
  if (a.tool === 'generate_image') {
    const alt = (row.result as { result?: { alt?: unknown } } | null)?.result?.alt ?? (a as { input?: { altText?: unknown } }).input?.altText;
    return { at: row.createdAt.toISOString(), kind: 'image', summary: typeof alt === 'string' && alt ? `Made an image: ${alt}` : 'Made an image' };
  }
  if (a.tool === 'upload_picture') {
    // A picture an own agent's client uploaded: the alt text is public (X shows it), the description is not put here.
    const alt = (a as { input?: { alt?: unknown } }).input?.alt;
    return { at: row.createdAt.toISOString(), kind: 'image', summary: typeof alt === 'string' && alt ? `Uploaded an image: ${alt}` : 'Uploaded an image' };
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

/** A paid service call on the public ledger: who was paid how much, and the model's reason; a free answer shows without an amount. */
export function serviceItem(chainId: number, row: ServiceCallRow): ActivityItem {
  const charged = BigInt(row.chargedMicroUsdc ?? row.quoteMicroUsdc ?? '0');
  const amount = `${shortAmount(formatUnits(charged, 6), 6)} USDC`;
  const lost = row.status !== 'succeeded';
  const summary = charged === 0n ? `Used a free service at ${row.host} for: ${row.reason}` : lost ? `Paid ${amount} to ${row.host} for: ${row.reason}. No answer came back` : `Paid ${amount} to ${row.host} for: ${row.reason}`;
  return { at: row.updatedAt.toISOString(), kind: 'service', summary, ...(row.txHash ? { txHash: row.txHash, url: explorerTxUrl(chainId, row.txHash) } : {}) };
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

/** The alt texts of the pictures the listed posts carry, in one read (none when no post carries one). */
async function imageAlts(ctx: Pick<SupervisorContext, 'db'>, rows: (typeof actions.$inferSelect)[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => (r.action as { input?: { imageId?: unknown } }).input?.imageId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!ids.length) return new Map();
  const found = await ctx.db.select({ id: images.id, alt: images.alt }).from(images).where(inArray(images.id, ids));
  return new Map(found.map((r) => [r.id, r.alt]));
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
  const tapeActions = sql`(${actions.action}->>'tool' in ('publish_post', 'publish_reply', 'generate_image', 'upload_picture') or ${actions.action}->>'kind' = 'config_updated')`;
  const [actionRows, opRows, approvalItems, serviceRows, bountyItems] = await Promise.all([
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
    tapeServiceCalls(ctx, agent.agentId, limit, before),
    bountyActivity(ctx, agent, limit, before),
  ]);
  const items: ActivityItem[] = [];
  const alts = await imageAlts(ctx, actionRows);
  for (const row of actionRows) {
    const item = actionItem(row, xHandle);
    if (!item) continue;
    const imageId = (row.action as { input?: { imageId?: unknown } }).input?.imageId;
    if ((item.kind === 'post' || item.kind === 'reply') && typeof imageId === 'string' && imageId) item.image = { id: imageId, alt: alts.get(imageId) ?? null };
    items.push(item);
  }
  for (const op of opRows) {
    const item = opItem(ctx.chain.chainId, op);
    if (item && (!before || Date.parse(item.at) < before.getTime())) items.push(item);
  }
  for (const item of approvalItems) if (!before || Date.parse(item.at) < before.getTime()) items.push(item);
  for (const row of serviceRows) items.push(serviceItem(ctx.chain.chainId, row));
  for (const item of bountyItems) items.push(item);
  const status = statusItem(agent, runtime);
  if (!before || Date.parse(status.at) < before.getTime()) items.push(status);
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return items.slice(0, limit);
}
