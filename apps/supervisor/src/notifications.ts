/**
 * What the creator is told about their agent: an inbox in the console and, when a chat is linked, Telegram.
 *
 * Every event is one row per agent while it is true (`sv_notifications`): raising an open event only updates it, and
 * clearing it closes it, which also takes it out of the inbox's active list and stops its repeats. Sending happens
 * here, in the notifier's own pass (notify-health.ts), never inside a tick: an unlinked creator, a refused message or a
 * Telegram outage changes nothing for the agent. The text is built from our own numbers and reason codes, and a coin's
 * symbol is reduced to plain characters first; no text a third party wrote ever reaches a notification.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { getAddress, isAddressEqual, type Address } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { agents, notifications, notificationEvents, notificationSettings, telegramLinks, type NotificationEvent } from './db/schema.js';
import { telegramView } from './telegram.js';

const HOUR = 3_600_000;
/** After this many sends one episode stays in the inbox only, so an abandoned coin does not message its creator forever. */
export const MAX_SENDS_PER_EPISODE = 5;
/** A chat Telegram refused for another reason than a block is tried again after this long. */
export const REJECTED_RETRY_MS = HOUR;
const SEND_BATCH = 30;
const INBOX_LIMIT = 50;
/** How long a closed item stays visible in the inbox. */
export const RESOLVED_VISIBLE_MS = 7 * 24 * HOUR;
/** Closed rows are deleted after this long. */
export const RESOLVED_KEEP_MS = 30 * 24 * HOUR;

export type NotificationTone = 'info' | 'warning' | 'danger';
export type NotificationData = Record<string, number | string | null>;

export interface EventRule {
  /** Name in the console's settings. */
  label: string;
  /** Wait between sends while the event stays true. */
  repeatMs: number;
  /** First send only after the event has been true this long; what often sorts itself out gets the time to. */
  sendAfterMs: number;
  tone: NotificationTone;
}

export const EVENT_RULES: Readonly<Record<NotificationEvent, EventRule>> = {
  review_waiting: { label: 'Posts waiting for your review', repeatMs: 12 * HOUR, sendAfterMs: 0, tone: 'info' },
  review_expiring: { label: 'Reviews about to expire', repeatMs: 6 * HOUR, sendAfterMs: 0, tone: 'warning' },
  fuel_low: { label: 'Low on fuel', repeatMs: 24 * HOUR, sendAfterMs: 0, tone: 'warning' },
  gas_out: { label: 'Out of gas', repeatMs: 24 * HOUR, sendAfterMs: HOUR / 4, tone: 'danger' },
  agent_asleep: { label: 'Agent asleep', repeatMs: 24 * HOUR, sendAfterMs: 0, tone: 'danger' },
  agent_stopped: { label: 'Agent stopped', repeatMs: 24 * HOUR, sendAfterMs: HOUR / 4, tone: 'danger' },
  x_revoked: { label: 'X connection lost', repeatMs: 24 * HOUR, sendAfterMs: 0, tone: 'danger' },
  key_rotation: { label: 'Treasury permission renewal', repeatMs: 72 * HOUR, sendAfterMs: HOUR, tone: 'warning' },
  /** Raised once by the model migration (model-migration.ts); said once, closed by the notifier after a week. */
  model_changed: { label: 'Model changed by the platform', repeatMs: 365 * 24 * HOUR, sendAfterMs: 0, tone: 'info' },
  /** The stored model is not served by BlockRun (model-check.ts, runtime.ts): the agent cannot think until it changes. */
  model_unavailable: { label: 'Model not available', repeatMs: 24 * HOUR, sendAfterMs: 0, tone: 'danger' },
};

/** How long a `model_changed` notice stays open before the notifier closes it. */
export const MODEL_CHANGED_VISIBLE_MS = 7 * 24 * HOUR;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Title and body of one event, from its stored numbers and reason codes alone. */
export function notificationText(event: NotificationEvent, data: Record<string, unknown>): { title: string; body: string } {
  switch (event) {
    case 'review_waiting': {
      const n = num(data.pending) ?? 1;
      return { title: 'Posts waiting for your review', body: `${plural(n, 'post')} ${n === 1 ? 'waits' : 'wait'} for your approval in the creator console.` };
    }
    case 'review_expiring': {
      const n = num(data.expiring) ?? 1;
      const hours = num(data.hours);
      return { title: 'Reviews about to expire', body: `${plural(n, 'waiting post')} ${n === 1 ? 'expires' : 'expire'} ${hours !== null && hours >= 1 ? `in about ${plural(hours, 'hour')}` : 'within the hour'}. Unreviewed posts are dropped.` };
    }
    case 'fuel_low': {
      const days = num(data.days);
      const left = num(data.thoughtsLeft);
      const how = days !== null && days >= 1 ? `About ${plural(Math.round(days), 'day')} of fuel left at the recent rate.` : days !== null ? 'Less than a day of fuel left at the recent rate.' : left !== null ? `Enough fuel for about ${plural(left, 'more thought')}.` : 'Almost no fuel left.';
      return { title: 'Low on fuel', body: `${how} Add fuel to keep the agent thinking.` };
    }
    case 'gas_out':
      return { title: 'Out of gas', body: 'The agent cannot claim fees, trade or refuel until someone adds gas on the coin page.' };
    case 'agent_asleep':
      return { title: 'Agent asleep', body: 'It ran out of fuel and stopped thinking. Add fuel and it wakes on its own.' };
    case 'agent_stopped': {
      const reason = data.reason;
      if (reason === 'paused_onchain') return { title: 'Agent paused', body: 'It was paused from its on-chain controls and stays stopped until it is resumed.' };
      if (reason === 'paused_by_bootr') return { title: 'Agent paused', body: 'Bootr paused this agent and it stays stopped until it is resumed. Get in touch if you did not expect this.' };
      if (reason === 'blocked') return { title: 'Agent waiting', body: 'One of its actions has no known result yet, so it does nothing else until that is settled.' };
      const failures = num(data.failures);
      return { title: 'Agent keeps failing', body: `Its last ${failures !== null ? plural(failures, 'turn') : 'turns'} failed. It keeps trying, with longer waits.` };
    }
    case 'x_revoked':
      return { title: 'X connection lost', body: 'X no longer accepts this agent’s connection, so it cannot read or post. Connect the same X account again from the inbox in the creator console.' };
    case 'key_rotation': {
      const days = num(data.days);
      const when = data.reason === 'expiring' ? (days !== null && days >= 1 ? `It runs out in about ${plural(days, 'day')}.` : 'It runs out very soon.') : 'It was set up under older limits.';
      return { title: 'Treasury permission renewal', body: `The agent’s permission to use its treasury needs renewing. ${when} Bootr renews it for you; get in touch if this stays.` };
    }
    case 'model_changed': {
      // `summary` is our own sentence (model-migration.ts `changeSummary`), built from catalog names, never from a third party's text.
      const summary = typeof data.summary === 'string' && /^[\w .,;:()'’-]{1,400}$/.test(data.summary) ? data.summary : 'Model changed by the platform; everything else unchanged.';
      return { title: 'Model changed by the platform', body: `${summary} The agent keeps its memory, posting rhythm, powers and X account, and goes on from where it was. You can pick another model in the creator console.` };
    }
    case 'model_unavailable': {
      const picture = data.picture === 1;
      return {
        title: picture ? 'Image model not available' : 'Model not available',
        body: picture
          ? 'The image model this agent draws with is no longer offered, so it posts without pictures until you pick another image model in the creator console.'
          : 'The model this agent thinks with is no longer offered, so it cannot think and nothing is charged. Pick another model in the creator console and it goes on from where it was.',
      };
    }
  }
}

/** The coin as text we can send: `$SYMBOL` when the symbol is plain, otherwise nothing a chat could read as a link or a mention. */
export function coinLabel(config: Record<string, unknown>): string {
  const symbol = (config.token as { symbol?: unknown } | undefined)?.symbol;
  return typeof symbol === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(symbol) ? `$${symbol}` : 'Your coin';
}

export function telegramText(agent: Pick<AgentRow, 'config' | 'token'>, event: NotificationEvent, data: Record<string, unknown>, siteUrl: string): string {
  const { title, body } = notificationText(event, data);
  const page = /^0x[0-9a-fA-F]{40}$/.test(agent.token) ? `\n${siteUrl.replace(/\/+$/, '')}/token/${agent.token}` : '';
  return `${coinLabel(agent.config)}: ${title}\n${body}${page}`;
}

/** Marks the event true: creates its row, or refreshes the open one. A row that comes back keeps the clock of the last send. */
export async function raiseNotification(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, event: NotificationEvent, data: NotificationData = {}): Promise<void> {
  const now = new Date(ctx.now());
  const open = and(eq(notifications.agentId, agentId), eq(notifications.event, event), isNull(notifications.resolvedAt));
  const updated = await ctx.db.update(notifications).set({ data, lastSeenAt: now }).where(open).returning({ id: notifications.id });
  if (updated.length) return;
  const [previous] = await ctx.db
    .select({ lastSentAt: notifications.lastSentAt })
    .from(notifications)
    .where(and(eq(notifications.agentId, agentId), eq(notifications.event, event)))
    .orderBy(desc(notifications.firstAt))
    .limit(1);
  await ctx.db
    .insert(notifications)
    .values({ id: `ntf_${randomUUID()}`, agentId, event, data, firstAt: now, lastSeenAt: now, lastSentAt: previous?.lastSentAt ?? null })
    .onConflictDoNothing();
}

/** Marks the event false: closes the open row, if any. Nothing more is sent for it. */
export async function resolveNotification(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, event: NotificationEvent): Promise<void> {
  await ctx.db
    .update(notifications)
    .set({ resolvedAt: new Date(ctx.now()) })
    .where(and(eq(notifications.agentId, agentId), eq(notifications.event, event), isNull(notifications.resolvedAt)));
}

/** Per event: its data when true, `false` when no longer true. An event left out is unknown, so its state stays as it is. */
export type HealthOutcomes = Partial<Record<NotificationEvent, NotificationData | false>>;

export async function applyOutcomes(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, outcomes: HealthOutcomes): Promise<void> {
  for (const [event, outcome] of Object.entries(outcomes) as [NotificationEvent, NotificationData | false][]) {
    if (outcome === false) await resolveNotification(ctx, agentId, event);
    else await raiseNotification(ctx, agentId, event, outcome);
  }
}

export function parseOptOut(raw: unknown): NotificationEvent[] {
  if (!Array.isArray(raw)) return [];
  return notificationEvents.filter((e) => raw.includes(e));
}

async function optOutOf(ctx: Pick<SupervisorContext, 'db'>, agentId: string): Promise<NotificationEvent[]> {
  const row = await ctx.db.query.notificationSettings.findFirst({ where: eq(notificationSettings.agentId, agentId) });
  return parseOptOut(row?.optOut);
}

export interface NotificationItem {
  id: string;
  event: NotificationEvent;
  title: string;
  body: string;
  tone: NotificationTone;
  state: 'active' | 'resolved';
  firstAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface NotificationsView {
  items: NotificationItem[];
  /** Open items the creator has not turned off. */
  active: number;
  events: { key: NotificationEvent; label: string; enabled: boolean }[];
  telegram: { available: boolean; linked: boolean; linkedAt: string | null };
}

/** The console's inbox: what is true now, then what closed in the last week. Events turned off are not shown. */
export async function notificationsView(ctx: Pick<SupervisorContext, 'db' | 'now' | 'telegram'>, agent: Pick<AgentRow, 'agentId' | 'creator'>): Promise<NotificationsView> {
  const now = ctx.now();
  const optOut = await optOutOf(ctx, agent.agentId);
  const rows = await ctx.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.agentId, agent.agentId), or(isNull(notifications.resolvedAt), gt(notifications.resolvedAt, new Date(now - RESOLVED_VISIBLE_MS)))))
    .orderBy(sql`${notifications.resolvedAt} is not null`, desc(notifications.lastSeenAt))
    .limit(INBOX_LIMIT);
  const items = rows
    .filter((r) => !optOut.includes(r.event))
    .map((r): NotificationItem => ({
      id: r.id,
      event: r.event,
      ...notificationText(r.event, r.data),
      tone: EVENT_RULES[r.event].tone,
      state: r.resolvedAt ? 'resolved' : 'active',
      firstAt: r.firstAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    }));
  return {
    items,
    active: items.filter((i) => i.state === 'active').length,
    events: notificationEvents.map((key) => ({ key, label: EVENT_RULES[key].label, enabled: !optOut.includes(key) })),
    telegram: await telegramView(ctx, agent),
  };
}

/** Open items the creator has not turned off, for the console's badge. Database only. */
export async function activeNotificationCount(ctx: Pick<SupervisorContext, 'db'>, agentId: string): Promise<number> {
  const optOut = await optOutOf(ctx, agentId);
  const rows = await ctx.db
    .select({ event: notifications.event })
    .from(notifications)
    .where(and(eq(notifications.agentId, agentId), isNull(notifications.resolvedAt)));
  return rows.filter((r) => !optOut.includes(r.event)).length;
}

export type SettingsResult = { ok: true; view: NotificationsView } | { ok: false; status: 400 | 403; error: string; message: string };

export async function updateNotificationSettings(ctx: SupervisorContext, agent: AgentRow, body: { by?: unknown; optOut?: unknown }): Promise<SettingsResult> {
  let by: Address;
  try {
    by = getAddress(String(body.by));
  } catch {
    return { ok: false, status: 400, error: 'invalid_by', message: '`by` must be the creator address' };
  }
  if (!isAddressEqual(by, agent.creator as Address)) return { ok: false, status: 403, error: 'not_creator', message: '`by` is not the creator of this agent' };
  if (!Array.isArray(body.optOut) || body.optOut.some((e) => !notificationEvents.includes(e as NotificationEvent))) return { ok: false, status: 400, error: 'invalid_opt_out', message: `optOut must list events of: ${notificationEvents.join(', ')}` };
  const optOut = parseOptOut(body.optOut);
  const now = new Date(ctx.now());
  await ctx.db
    .insert(notificationSettings)
    .values({ agentId: agent.agentId, optOut, updatedAt: now })
    .onConflictDoUpdate({ target: notificationSettings.agentId, set: { optOut, updatedAt: now } });
  return { ok: true, view: await notificationsView(ctx, agent) };
}

export interface SendState {
  event: NotificationEvent;
  firstAt: Date;
  lastSentAt: Date | null;
  sendCount: number;
  nextAttemptAt: Date | null;
}

/** Whether this open row should go out now: not turned off, past its first wait and repeat interval, under the cap. */
export function sendDue(row: SendState, optOut: readonly string[], now: number): boolean {
  const rule = EVENT_RULES[row.event];
  if (optOut.includes(row.event)) return false;
  if (row.sendCount >= MAX_SENDS_PER_EPISODE) return false;
  if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now) return false;
  if (now - row.firstAt.getTime() < rule.sendAfterMs) return false;
  return !row.lastSentAt || now - row.lastSentAt.getTime() >= rule.repeatMs;
}

export interface FlushReport {
  sent: number;
  failed: number;
}

/**
 * Sends what is due, one message at a time. A failure stays a row state: a block removes the link, a refusal waits an
 * hour, and an outage or a rate limit ends the pass, so one bad minute costs at most one request timeout. Never throws.
 */
export async function flushNotifications(ctx: SupervisorContext): Promise<FlushReport> {
  const report: FlushReport = { sent: 0, failed: 0 };
  const telegram = ctx.telegram;
  if (!telegram) return report;
  const now = ctx.now();
  try {
    const rows = await ctx.db
      .select({ row: notifications, agent: agents, chatId: telegramLinks.chatId, optOut: notificationSettings.optOut })
      .from(notifications)
      .innerJoin(agents, eq(agents.agentId, notifications.agentId))
      .innerJoin(telegramLinks, eq(telegramLinks.creator, sql`lower(${agents.creator})`))
      .leftJoin(notificationSettings, eq(notificationSettings.agentId, notifications.agentId))
      .where(isNull(notifications.resolvedAt))
      .orderBy(asc(sql`coalesce(${notifications.lastSentAt}, ${notifications.firstAt})`))
      .limit(SEND_BATCH * 10);
    const due = rows.filter((r) => sendDue(r.row, parseOptOut(r.optOut), now)).slice(0, SEND_BATCH);
    const blocked = new Set<string>();
    for (const { row, agent, chatId } of due) {
      if (blocked.has(chatId)) continue;
      const res = await telegram.sendMessage(chatId, telegramText(agent, row.event, row.data, ctx.config.SITE_URL));
      if (res.ok) {
        report.sent += 1;
        await ctx.db.update(notifications).set({ lastSentAt: new Date(now), sendCount: row.sendCount + 1, nextAttemptAt: null }).where(eq(notifications.id, row.id));
        continue;
      }
      report.failed += 1;
      ctx.log.warn({ agentId: row.agentId, event: row.event, kind: res.kind, status: res.status }, 'telegram send failed');
      if (res.kind === 'blocked') {
        blocked.add(chatId);
        await ctx.db.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId));
      } else if (res.kind === 'rejected') {
        await ctx.db.update(notifications).set({ nextAttemptAt: new Date(now + REJECTED_RETRY_MS) }).where(eq(notifications.id, row.id));
      } else {
        break;
      }
    }
  } catch (err) {
    ctx.log.warn({ err }, 'notification flush failed');
  }
  return report;
}

/** Closed rows nobody can see any more. */
export async function pruneNotifications(ctx: Pick<SupervisorContext, 'db' | 'now'>): Promise<void> {
  await ctx.db.delete(notifications).where(lt(notifications.resolvedAt, new Date(ctx.now() - RESOLVED_KEEP_MS)));
}
