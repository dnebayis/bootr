/**
 * The Telegram side of creator notifications (notifications.ts): a small Bot API client, the one-time deep link a
 * creator opens to bind a chat to their wallet, and the long poll that receives `/start <token>` and `/stop`.
 *
 * The bot token sits in every request URL, so no URL and no transport error text ever leaves this file: a failure is
 * only its kind. Every request has a timeout and every failure is a value, not a throw, so an outage costs the caller
 * one short wait. Long polling needs no public route, and the supervisor stays private on the compose network.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getAddress, isAddressEqual, type Address } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { telegramLinks, telegramLinkTokens } from './db/schema.js';

const API_ORIGIN = 'https://api.telegram.org';
/** A send waits at most this long; notifications are never worth holding the notifier for. */
export const TELEGRAM_TIMEOUT_MS = 5_000;
/** How long Telegram holds an empty `getUpdates`, and how much longer the request itself may take. */
const LONG_POLL_S = 25;
const LONG_POLL_GRACE_MS = 10_000;
/** Pause after a failed poll. */
const POLL_BACKOFF_MS = 30_000;
/** A deep link stays good for this long, once. */
export const LINK_TOKEN_TTL_MS = 15 * 60_000;

export type TelegramFailureKind =
  /** The chat is gone or blocked the bot (403): stop sending to it. */
  | 'blocked'
  /** 429: wait `retryAfterMs` before any other call. */
  | 'rate_limited'
  /** Telegram refused this one request (400 and the like). */
  | 'rejected'
  /** Network, timeout, 5xx, or a token Telegram does not accept. */
  | 'unavailable';

export type TelegramResult<T> = { ok: true; result: T } | { ok: false; kind: TelegramFailureKind; status: number | null; retryAfterMs?: number };

export interface TelegramMessage {
  chat?: { id?: number | string; type?: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

type TelegramEnvelope<T> = { ok?: boolean; result?: T; parameters?: { retry_after?: unknown } };

export class TelegramClient {
  private username: string | null = null;
  private pausedUntil = 0;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly timeoutMs: number = TELEGRAM_TIMEOUT_MS,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<TelegramResult<T>> {
    if (this.now() < this.pausedUntil) return { ok: false, kind: 'rate_limited', status: 429, retryAfterMs: this.pausedUntil - this.now() };
    let res: Response;
    try {
      res = await this.fetchImpl(`${API_ORIGIN}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, kind: 'unavailable', status: null };
    }
    let json: TelegramEnvelope<T> | null = null;
    try {
      json = (await res.json()) as TelegramEnvelope<T>;
    } catch {
      json = null;
    }
    if (res.ok && json?.ok === true) return { ok: true, result: json.result as T };
    if (res.status === 429) {
      const seconds = Number(json?.parameters?.retry_after);
      const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
      this.pausedUntil = this.now() + retryAfterMs;
      return { ok: false, kind: 'rate_limited', status: 429, retryAfterMs };
    }
    if (res.status === 403) return { ok: false, kind: 'blocked', status: 403 };
    if (res.status === 401 || res.status === 404 || res.status === 409 || res.status >= 500) return { ok: false, kind: 'unavailable', status: res.status };
    return { ok: false, kind: 'rejected', status: res.status };
  }

  /**
   * Plain text only: no `parse_mode`, so nothing in a message is read as markup, and no link preview, so Telegram fetches
   * nothing on the creator's behalf.
   */
  sendMessage(chatId: string, text: string): Promise<TelegramResult<unknown>> {
    return this.call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
  }

  getUpdates(offset: number | null, waitSeconds = LONG_POLL_S): Promise<TelegramResult<TelegramUpdate[]>> {
    return this.call<TelegramUpdate[]>('getUpdates', { ...(offset !== null ? { offset } : {}), timeout: waitSeconds, allowed_updates: ['message'] }, waitSeconds * 1000 + LONG_POLL_GRACE_MS);
  }

  /** The bot's @username (for deep links), cached once known; null while Telegram cannot be reached. */
  async botUsername(): Promise<string | null> {
    if (this.username) return this.username;
    const me = await this.call<{ username?: unknown }>('getMe', {});
    if (me.ok && typeof me.result.username === 'string' && /^\w{1,64}$/.test(me.result.username)) this.username = me.result.username;
    return this.username;
  }
}

export function telegramClientFor(token: string | undefined, fetchImpl: typeof fetch, now: () => number): TelegramClient | null {
  return token ? new TelegramClient(token, fetchImpl, now) : null;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const walletKey = (address: string) => address.toLowerCase();

export type LinkFailure = { ok: false; status: 400 | 403 | 503; error: string; message: string };

function checkCreator(agent: AgentRow, by: unknown): LinkFailure | null {
  let who: Address;
  try {
    who = getAddress(String(by));
  } catch {
    return { ok: false, status: 400, error: 'invalid_by', message: '`by` must be the creator address' };
  }
  if (!isAddressEqual(who, agent.creator as Address)) return { ok: false, status: 403, error: 'not_creator', message: '`by` is not the creator of this agent' };
  return null;
}

/** A one-time deep link for the creator's wallet. The raw token exists only in the answer; the database holds its hash. */
export async function createTelegramLink(ctx: SupervisorContext, agent: AgentRow, by: unknown): Promise<{ ok: true; url: string; expiresAt: string } | LinkFailure> {
  const bad = checkCreator(agent, by);
  if (bad) return bad;
  if (!ctx.telegram) return { ok: false, status: 503, error: 'telegram_unavailable', message: 'Telegram is not set up on this deployment.' };
  const username = await ctx.telegram.botUsername();
  if (!username) return { ok: false, status: 503, error: 'telegram_unavailable', message: 'Telegram cannot be reached right now. Try again in a minute.' };
  const token = randomBytes(32).toString('base64url');
  const now = ctx.now();
  const expiresAt = new Date(now + LINK_TOKEN_TTL_MS);
  await ctx.db.insert(telegramLinkTokens).values({ tokenHash: tokenHash(token), creator: walletKey(agent.creator), expiresAt, createdAt: new Date(now) });
  return { ok: true, url: `https://t.me/${username}?start=${token}`, expiresAt: expiresAt.toISOString() };
}

export async function removeTelegramLink(ctx: SupervisorContext, agent: AgentRow, by: unknown): Promise<{ ok: true } | LinkFailure> {
  const bad = checkCreator(agent, by);
  if (bad) return bad;
  await ctx.db.delete(telegramLinks).where(eq(telegramLinks.creator, walletKey(agent.creator)));
  return { ok: true };
}

export async function telegramView(ctx: Pick<SupervisorContext, 'db' | 'telegram'>, agent: Pick<AgentRow, 'creator'>): Promise<{ available: boolean; linked: boolean; linkedAt: string | null }> {
  const link = await ctx.db.query.telegramLinks.findFirst({ where: eq(telegramLinks.creator, walletKey(agent.creator)) });
  return { available: !!ctx.telegram, linked: !!link, linkedAt: link ? link.linkedAt.toISOString() : null };
}

const START = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/;
const STOP = /^\/stop(?:@\w+)?\s*$/;

function shortWallet(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Spends a deep-link token: exactly once and only before it expires. Returns the wallet, or null. */
export async function consumeLinkToken(ctx: Pick<SupervisorContext, 'db' | 'now'>, token: string, chatId: string): Promise<string | null> {
  const now = new Date(ctx.now());
  const [row] = await ctx.db
    .update(telegramLinkTokens)
    .set({ usedAt: now })
    .where(and(eq(telegramLinkTokens.tokenHash, tokenHash(token)), isNull(telegramLinkTokens.usedAt), gt(telegramLinkTokens.expiresAt, now)))
    .returning({ creator: telegramLinkTokens.creator });
  if (!row) return null;
  await ctx.db
    .insert(telegramLinks)
    .values({ creator: row.creator, chatId, linkedAt: now })
    .onConflictDoUpdate({ target: telegramLinks.creator, set: { chatId, linkedAt: now } });
  return row.creator;
}

/** One incoming message. Private chats only; replies are fixed text, and nothing the sender wrote is repeated back. */
export async function handleTelegramUpdate(ctx: SupervisorContext, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const chatId = message?.chat?.id;
  if (!ctx.telegram || !message || message.chat?.type !== 'private' || chatId === undefined || typeof message.text !== 'string') return;
  const chat = String(chatId);
  const text = message.text.trim();
  if (STOP.test(text)) {
    await ctx.db.delete(telegramLinks).where(eq(telegramLinks.chatId, chat));
    await ctx.telegram.sendMessage(chat, 'Alerts are off for this chat. To turn them on again, link it from your coin’s creator console.');
    return;
  }
  const start = START.exec(text);
  if (!start) return;
  const token = start[1];
  if (!token) {
    await ctx.telegram.sendMessage(chat, 'This bot sends alerts about your Bootr coins. To start, open the creator console on your coin’s page and choose Connect Telegram.');
    return;
  }
  const wallet = /^[\w-]{16,64}$/.test(token) ? await consumeLinkToken(ctx, token, chat) : null;
  await ctx.telegram.sendMessage(
    chat,
    wallet
      ? `Linked. Alerts for the coins of ${shortWallet(wallet)} now come here. Send /stop to turn them off.`
      : 'This link has expired or was already used. Make a new one from your coin’s creator console.',
  );
}

/** One `getUpdates` round. Returns the next offset. An update that fails is logged and skipped, so it cannot wedge the poll. */
export async function pollTelegramOnce(ctx: SupervisorContext, offset: number | null, waitSeconds?: number): Promise<{ ok: boolean; offset: number | null }> {
  if (!ctx.telegram) return { ok: false, offset };
  const res = await ctx.telegram.getUpdates(offset, waitSeconds);
  if (!res.ok) {
    ctx.log.warn({ kind: res.kind, status: res.status }, 'telegram poll failed');
    return { ok: false, offset };
  }
  let next = offset;
  for (const update of res.result) {
    next = Math.max(next ?? 0, update.update_id + 1);
    try {
      await handleTelegramUpdate(ctx, update);
    } catch (err) {
      ctx.log.warn({ err, updateId: update.update_id }, 'telegram update failed');
    }
  }
  return { ok: true, offset: next };
}

/** The background receive loop: runs until `signal` aborts, and never throws. Started only when a token is configured. */
export async function runTelegramLoop(ctx: SupervisorContext, signal: AbortSignal): Promise<void> {
  let offset: number | null = null;
  while (!signal.aborted) {
    let ok = false;
    try {
      const round = await pollTelegramOnce(ctx, offset);
      offset = round.offset;
      ok = round.ok;
    } catch (err) {
      ctx.log.warn({ err }, 'telegram poll crashed');
    }
    if (!ok && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, POLL_BACKOFF_MS));
  }
}
