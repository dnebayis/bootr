/**
 * The agent's note on what works for its coin (docs/design/agent-tools-2.md sections 6.3 and 6.4). Code computes the
 * facts over the agent's measured posts (post-performance.ts `computeFacts`); the agent keeps ONE short note of its own
 * conclusion, written with `note_what_works`, which replaces the note before it. `sv_what_works` keeps the last
 * WHAT_WORKS_KEEP versions, each with the fact lines the agent had in front of it, and the creator reads and clears
 * them in the console (`GET /internal/agents/:id/what-works`, `POST .../what-works/clear`).
 *
 * What keeps it honest:
 *   - It is advice the agent gives itself. It reaches the model inside the `whatWorks` section with
 *     `instructionAuthority: false`, and no guard, gate, quota or limit anywhere reads it.
 *   - It is revised rarely: at most once every WHAT_WORKS_MIN_INTERVAL_MS, only after WHAT_WORKS_MIN_NEW_POSTS more
 *     posts were measured, and only while the facts have something to say (`reviseNow` in the section). At any other
 *     time the tool refuses (`what_works_not_due`), so a mention that asks for a rewrite gets nothing most of the week.
 *     A creator's clear does not move that clock.
 *   - Its text is checked when it is written (`noteRefusal`): the publish gate's risk checks (no command, wallet
 *     payload, secret or address: agent-core `outgoingActionRisk`, `outgoingDisclosureRisk`), the platform gate's own
 *     check for talk of price, returns or the treasury (`platformPostRisk`, applied to every agent's note), a short
 *     fixed list of calls on the audience (`BAIT_PHRASES`), and three things a note about one's own posts never needs
 *     and an instruction smuggled in by a stranger usually does: an @handle, a link, another coin's cashtag. Invisible
 *     characters are stripped before anything is checked or stored. A refused note leaves the old one in place.
 *   - It cannot grow: WHAT_WORKS_MAX_CHARS characters, replaced and never added to.
 *
 * With WHAT_WORKS_MAX_CHARS at 0 (or the facts off, LEARN_WINDOW_DAYS 0) the piece is off: the tool is not offered
 * (`whatWorksOffered`, asked by the broker's catalog) and the section carries no note.
 */
import { linkedHosts, normalizedCommunication, outgoingActionRisk, outgoingDisclosureRisk, platformPostRisk, type ActionOutcome, type AgentConfig, type PendingAction } from '@bootr/agent-core';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, notInArray, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { getAddress, isAddressEqual, type Address } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { agents, postMetrics, whatWorks } from './db/schema.js';
import type { AuthEnv } from './hmac.js';
import { isOwn } from './own/registry.js';
import { METRICS_MIN_AGE_MS, learnedFacts, type Facts } from './post-performance.js';

export type WhatWorksRow = typeof whatWorks.$inferSelect;

/** `via` of a row the creator's clear wrote: its text is empty and it never counts as a revision by the agent. */
export const VIA_CREATOR = 'creator';
export const VIA_OWN = 'own';

/** Calls on the audience a note may not carry (section 6.4): the short fixed list, matched on the normalised text. */
export const BAIT_PHRASES: readonly string[] = ['giveaway', 'airdrop', 'follow for', 'tag a friend', 'like and repost', 'comment below', 'reply to win'];

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'config'>;

/** Whether the note exists on this deployment: the facts are on and the note has room. */
export function whatWorksOffered(ctx: Pick<SupervisorContext, 'config'>): boolean {
  return ctx.config.LEARN_WINDOW_DAYS > 0 && ctx.config.WHAT_WORKS_MAX_CHARS > 0;
}

/** One paragraph of plain text: control and invisible characters out, runs of whitespace collapsed. */
export function cleanNote(input: string): string {
  return (
    input
      // eslint-disable-next-line no-control-regex -- the C0 and C1 ranges are the point
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

const baitIn = (normalised: string): string | null => BAIT_PHRASES.find((p) => normalised.includes(p)) ?? null;

/**
 * Why a topic word must not reach the facts, or null: its words read as market talk, as the agent's own treasury, as a
 * command or as a call on the audience. `topic` is the slug of `publish_post` (`[a-z0-9-]{1,24}`).
 */
export function topicWordRisk(topic: string): string | null {
  const words = topic.replace(/-/g, ' ');
  const platform = platformPostRisk(words);
  if (platform === 'platform_price_talk_forbidden' || platform === 'platform_treasury_talk_forbidden') return platform;
  return outgoingActionRisk(words) ?? baitIn(normalizedCommunication(words));
}

/**
 * Why a note is not kept, in the words the agent reads after `what_works_refused:`, or null when it may be kept.
 * `text` is the cleaned note (`cleanNote`); `symbol` the agent's own coin, the one cashtag a note may carry.
 */
export function noteRefusal(text: string, opts: { maxChars: number; symbol?: string | null }): string | null {
  const length = [...text].length;
  if (length === 0) return 'the note is empty';
  if (length > opts.maxChars) return `the note has ${length} characters and the most is ${opts.maxChars}`;
  const action = outgoingActionRisk(text);
  if (action) return `the note reads like a command, a payment or a hand-over to a bot (${action}); write what you observed about your own posts`;
  // No address is public here: a note about one's own posts never needs one.
  const disclosure = outgoingDisclosureRisk(text, { publicAddresses: [] });
  if (disclosure) return `the note carries a secret, an address or words from your own machinery (${disclosure}); write what you observed about your own posts`;
  const platform = platformPostRisk(text);
  if (platform === 'platform_price_talk_forbidden') return 'the note talks about price or returns, or uses market words or a multiplier such as 2x (platform_price_talk_forbidden); say it without them';
  if (platform === 'platform_treasury_talk_forbidden') return 'the note talks about your own treasury (platform_treasury_talk_forbidden); it is about your posts only';
  const normalised = normalizedCommunication(text);
  const bait = baitIn(normalised);
  if (bait) return `the note calls on readers to act ("${bait}"); it is about what you write, not about what readers should do`;
  if (/@\s*[a-z0-9_]/.test(normalised)) return 'the note names an account with an @; it is about your own posts, never about an account';
  if (linkedHosts(normalised).length > 0) return 'the note carries a link; it is about your own posts and needs none';
  const own = opts.symbol ? `$${opts.symbol}`.toLowerCase() : null;
  const foreign = [...normalised.matchAll(/(?<![a-z0-9_])\$[a-z][a-z0-9_]*\b/g)].find((m) => m[0] !== own);
  if (foreign) return 'the note names another coin; it is about your own posts only';
  return null;
}

async function rowsOf(ctx: Ctx, agentId: string, limit: number): Promise<WhatWorksRow[]> {
  return ctx.db.select().from(whatWorks).where(eq(whatWorks.agentId, agentId)).orderBy(desc(whatWorks.createdAt), desc(whatWorks.id)).limit(limit);
}

export interface NoteState {
  /** The note in force, or null: none was written yet, or the creator cleared the last one. */
  current: WhatWorksRow | null;
  /** When the agent itself last wrote a note (a creator's clear does not count), epoch ms, or null. */
  lastWrittenAt: number | null;
  /** Posts measured since then (all of them when it never wrote one). */
  measuredSince: number;
  reviseNow: boolean;
  /** The earliest time the note may be revised again; `now` or earlier when `reviseNow`. */
  nextRevisionAt: number;
  /** Why not now, for the section: `interval`, `posts` (too few newly measured) or `facts` (nothing to write from). */
  waitingFor: 'interval' | 'posts' | 'facts' | null;
}

/**
 * Where the note stands: what is in force and whether the agent may revise it now. Due means all three: the interval
 * since its own last note has passed, enough more posts were measured since, and the facts have enough posts to say
 * anything. When posts are what is missing, the next time is a guess of one measuring day ahead: posts are measured
 * about a day after they go out.
 */
export async function noteState(ctx: Ctx, agentId: string, facts: Pick<Facts, 'enough'>): Promise<NoteState> {
  const now = ctx.now();
  const rows = await rowsOf(ctx, agentId, ctx.config.WHAT_WORKS_KEEP + 1);
  const latest = rows[0] ?? null;
  const current = latest && latest.via !== VIA_CREATOR && latest.text ? latest : null;
  const written = rows.find((r) => r.via !== VIA_CREATOR) ?? null;
  const lastWrittenAt = written ? written.createdAt.getTime() : null;
  const [counted] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(postMetrics)
    .where(and(eq(postMetrics.agentId, agentId), eq(postMetrics.unavailable, false), gt(postMetrics.measuredAt, new Date(lastWrittenAt ?? 0))));
  const measuredSince = Number(counted?.n ?? 0);
  const intervalEnd = lastWrittenAt === null ? 0 : lastWrittenAt + ctx.config.WHAT_WORKS_MIN_INTERVAL_MS;
  const waitingFor: NoteState['waitingFor'] = now < intervalEnd ? 'interval' : !facts.enough ? 'facts' : measuredSince < ctx.config.WHAT_WORKS_MIN_NEW_POSTS ? 'posts' : null;
  const nextRevisionAt = waitingFor === null ? now : waitingFor === 'interval' ? intervalEnd : Math.max(intervalEnd, now + METRICS_MIN_AGE_MS);
  return { current, lastWrittenAt, measuredSince, reviseNow: waitingFor === null, nextRevisionAt, waitingFor };
}

export const WHAT_WORKS_HOW = (maxChars: number) =>
  `Your note may be revised now: call note_what_works once with what the facts above show about your own posts, in at most ${maxChars} characters. It replaces your earlier note. Leave it as it is when the facts changed nothing.`;

/**
 * The `note` part of the `whatWorks` section: the note in force (the agent's own earlier words, checked when they were
 * written), when it was written and whether it may be revised now. Null when the note is switched off or the agent
 * has no memory power, since it then holds no `note_what_works` and must not be told to call it.
 */
export async function whatWorksNoteView(ctx: Ctx, agentId: string, facts: Pick<Facts, 'enough'>): Promise<Record<string, unknown> | null> {
  if (!whatWorksOffered(ctx)) return null;
  const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, agentId), columns: { config: true } });
  const capabilities = (agent?.config as { capabilities?: { memory?: unknown } } | undefined)?.capabilities;
  if (capabilities?.memory !== true) return null;
  const state = await noteState(ctx, agentId, facts);
  const waiting =
    state.waitingFor === 'interval'
      ? { nextRevisionAt: new Date(state.nextRevisionAt).toISOString() }
      : state.waitingFor === 'posts'
        ? { waitingFor: `${Math.max(1, ctx.config.WHAT_WORKS_MIN_NEW_POSTS - state.measuredSince)} more measured posts` }
        : state.waitingFor === 'facts'
          ? { waitingFor: 'enough measured posts for the facts' }
          : {};
  return {
    text: state.current?.text ?? null,
    writtenAt: state.current ? state.current.createdAt.toISOString() : null,
    reviseNow: state.reviseNow,
    ...(state.reviseNow ? { how: WHAT_WORKS_HOW(ctx.config.WHAT_WORKS_MAX_CHARS) } : waiting),
  };
}

/** The row id of the note one `note_what_works` action writes: derived from the action's id, so a repeat finds its row. */
export function noteIdOf(actionId: string): string {
  return `ww_${createHash('sha256').update(actionId).digest('hex').slice(0, 24)}`;
}

/** Deletes every version of the agent's note but the newest WHAT_WORKS_KEEP. */
async function prune(ctx: Ctx, agentId: string): Promise<void> {
  const keep = (await rowsOf(ctx, agentId, ctx.config.WHAT_WORKS_KEEP)).map((r) => r.id);
  if (keep.length < ctx.config.WHAT_WORKS_KEEP) return;
  await ctx.db.delete(whatWorks).where(and(eq(whatWorks.agentId, agentId), notInArray(whatWorks.id, keep)));
}

const failed = (error: string): ActionOutcome => ({ kind: 'failed', error });

export function whatWorksNotDue(at: number): string {
  return `what_works_not_due: your note can be revised again at ${new Date(at).toISOString()}; nothing was changed.`;
}
export function whatWorksRefused(reason: string): string {
  return `what_works_refused: ${reason}; your earlier note stands.`;
}

/**
 * `note_what_works`: replaces the agent's note. Refused while it is not due (`what_works_not_due`) and when the text
 * does not pass the checks (`what_works_refused`); either way the earlier note stands. Safe to repeat: the row's id
 * comes from the action's id, and a repeat of an action that already wrote its row answers from that row.
 */
export async function noteWhatWorks(ctx: SupervisorContext, agent: AgentRow, config: Pick<AgentConfig, 'token'>, pending: PendingAction): Promise<ActionOutcome> {
  if (pending.action.tool !== 'note_what_works') return failed('what_works_refused: not a note; your earlier note stands.');
  if (!whatWorksOffered(ctx)) return failed(whatWorksRefused('the note is switched off'));
  const id = noteIdOf(pending.id);
  const interval = ctx.config.WHAT_WORKS_MIN_INTERVAL_MS;
  const kept = await ctx.db.query.whatWorks.findFirst({ where: and(eq(whatWorks.agentId, agent.agentId), eq(whatWorks.id, id)) });
  if (kept) return { kind: 'completed', result: { kept: true, nextRevisionAt: new Date(kept.createdAt.getTime() + interval).toISOString() } };

  const facts = await learnedFacts(ctx, agent.agentId);
  const state = await noteState(ctx, agent.agentId, facts);
  if (!state.reviseNow) return failed(whatWorksNotDue(state.nextRevisionAt));
  const text = cleanNote(pending.action.input.text);
  const reason = noteRefusal(text, { maxChars: ctx.config.WHAT_WORKS_MAX_CHARS, symbol: config.token.symbol });
  if (reason) {
    ctx.log.info({ agentId: agent.agentId, actionId: pending.id, reason: reason.slice(0, 80) }, 'what-works note refused');
    return failed(whatWorksRefused(reason));
  }
  const createdAt = new Date(ctx.now());
  await ctx.db
    .insert(whatWorks)
    .values({ id, agentId: agent.agentId, text, facts: { originals: facts.originals, replies: facts.replies, lines: facts.lines }, actionId: pending.id, via: isOwn(agent) ? VIA_OWN : null, createdAt })
    .onConflictDoNothing();
  await prune(ctx, agent.agentId);
  ctx.log.info({ agentId: agent.agentId, actionId: pending.id, chars: [...text].length }, 'what-works note kept');
  return { kind: 'completed', result: { kept: true, nextRevisionAt: new Date(createdAt.getTime() + interval).toISOString() } };
}

// ---------------------------------------------------------------------------
// The creator's view (console, Mind section)
// ---------------------------------------------------------------------------

export interface WhatWorksItem {
  id: string;
  /** '' on a row the creator's clear wrote. */
  text: string;
  at: string;
  by: 'agent' | 'creator';
  /** The fact lines the agent had in front of it when it wrote this version. */
  facts: string[];
}

/** `GET /internal/agents/:id/what-works`. */
export interface WhatWorksView {
  /** False when the note is switched off on this deployment; the kept versions are listed either way. */
  enabled: boolean;
  maxChars: number;
  /** The id of the note in force, or null (none yet, or cleared). */
  current: string | null;
  /** When the agent may next revise its note (ISO); null while that waits on more measured posts. */
  nextRevisionAt: string | null;
  /** The kept versions, newest first. */
  items: WhatWorksItem[];
}

function itemOf(row: WhatWorksRow): WhatWorksItem {
  const lines = (row.facts as { lines?: unknown } | null)?.lines;
  return {
    id: row.id,
    text: row.via === VIA_CREATOR ? '' : row.text,
    at: row.createdAt.toISOString(),
    by: row.via === VIA_CREATOR ? 'creator' : 'agent',
    facts: Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string').slice(0, 16) : [],
  };
}

export async function whatWorksView(ctx: Ctx, agentId: string): Promise<WhatWorksView> {
  const rows = await rowsOf(ctx, agentId, ctx.config.WHAT_WORKS_KEEP);
  const latest = rows[0] ?? null;
  const written = rows.find((r) => r.via !== VIA_CREATOR) ?? null;
  const next = written ? written.createdAt.getTime() + ctx.config.WHAT_WORKS_MIN_INTERVAL_MS : null;
  return {
    enabled: whatWorksOffered(ctx),
    maxChars: ctx.config.WHAT_WORKS_MAX_CHARS,
    current: latest && latest.via !== VIA_CREATOR && latest.text ? latest.id : null,
    nextRevisionAt: next !== null && next > ctx.now() ? new Date(next).toISOString() : null,
    items: rows.map(itemOf),
  };
}

export type ClearResult = { ok: true; view: WhatWorksView } | { ok: false; status: 400 | 403; error: string; message: string };

/**
 * The creator clears the note in force: a row of its own with no text, so the agent reads none from its next turn on
 * and the versions before stay readable. The agent's own clock is not moved: it writes a new note when that is due.
 * Nothing in force means nothing is written.
 */
export async function clearWhatWorks(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'creator'>, by: unknown): Promise<ClearResult> {
  let signer: Address;
  try {
    signer = getAddress(String(by ?? ''));
  } catch {
    return { ok: false, status: 400, error: 'invalid_by', message: '`by` must be the creator address' };
  }
  if (!isAddressEqual(signer, agent.creator as Address)) return { ok: false, status: 403, error: 'not_creator', message: '`by` is not the creator of this agent' };
  const [latest] = await rowsOf(ctx, agent.agentId, 1);
  if (latest && latest.via !== VIA_CREATOR && latest.text) {
    await ctx.db.insert(whatWorks).values({ id: `ww_clear_${randomUUID()}`, agentId: agent.agentId, text: '', facts: {}, actionId: null, via: VIA_CREATOR, createdAt: new Date(Math.max(ctx.now(), latest.createdAt.getTime() + 1)) });
    await prune(ctx, agent.agentId);
  }
  return { ok: true, view: await whatWorksView(ctx, agent.agentId) };
}

/** The two internal routes of the note (HMAC, like every `/internal/*` route; api.ts mounts this). */
export function mountWhatWorks(app: Hono<AuthEnv>, ctx: SupervisorContext): void {
  app.get('/internal/agents/:id/what-works', async (c) => {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, c.req.param('id')), columns: { agentId: true } });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    return c.json(await whatWorksView(ctx, agent.agentId));
  });

  app.post('/internal/agents/:id/what-works/clear', async (c) => {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, c.req.param('id')) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { by?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body', message: 'JSON object expected' }, 400);
    const result = await clearWhatWorks(ctx, agent, body.by);
    if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
    return c.json(result.view);
  });
}
