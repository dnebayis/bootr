/**
 * Creator requests: something the creator asked for in the private chat (chat.ts `request`) that one of the agent's
 * own turns can do: post about something, make a picture for a post, open a bounty, stop doing something.
 *
 * A request is a row of `sv_memories` (no migration): id `req_…`, source `creator-chat` (set here, never by a model:
 * a model's `remember` takes https sources only, so a turn cannot forge one), tags `creator-request` plus the target
 * turn (`for-social` | `for-treasury`) and `wants-picture` when the creator wants a picture made. It is shown in the
 * next turn of that kind under `creatorRequests` (`creatorRequestsSection`), whose words say plainly that it comes
 * from the creator, the same authority as OWNER RULES, and that every gate, cap and hard rule still applies.
 *
 * It closes when the turn acts on it or answers it: `answer_request` (`answerRequest`, a function the runtime handles
 * itself, never brokered) with `done` (code records the latest completed action of this turn that is not a read; none,
 * no `done`) or `not_done` with the reason; or a post planned with `draft_intent` that names the request goes out
 * (runtime.ts). Closing adds `request-done` or `request-not-done` to the row's tags and stores the answer as its own
 * row (`creator-request-answer`, `supersedes` = the request) so the chat can tell the creator what came of it. An open
 * request is shown again in every turn of its kind until it closes or is `CREATOR_REQUEST_TTL_MS` old.
 *
 * A request for the treasury turn pulls that turn forward like a treasury note (roles.ts `treasuryTurnDue`).
 */
import { randomUUID } from 'node:crypto';
import { toolByName, type ChatMessage, type ModelTool } from '@bootr/agent-core';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SupervisorContext } from './context.js';
import { actions, memories } from './db/schema.js';

export type RequestTurn = 'social' | 'treasury';

export const CREATOR_REQUEST_SOURCE = 'creator-chat';
export const CREATOR_REQUEST_TAG = 'creator-request';
export const CREATOR_REQUEST_ANSWER_TAG = 'creator-request-answer';
export const REQUEST_TURN_TAGS: Readonly<Record<RequestTurn, string>> = { social: 'for-social', treasury: 'for-treasury' };
export const REQUEST_PICTURE_TAG = 'wants-picture';
export const REQUEST_DONE_TAG = 'request-done';
export const REQUEST_NOT_DONE_TAG = 'request-not-done';
/** The id prefix of a request row: the chat tells a filed request from a note by it (`sv_chat_messages.memory_id`). */
export const REQUEST_ID_PREFIX = 'req_';
/** A request nobody acted on or answered stops being shown after this long. */
export const CREATOR_REQUEST_TTL_MS = 48 * 3_600_000;
/** Most open requests per turn kind: the chat files no more until one closes. */
export const CREATOR_REQUESTS_OPEN_MAX = 5;
export const CREATOR_REQUEST_CHARS = 600;
export const REQUEST_ANSWER_CHARS = 300;
/** Tags no model may put on a note of its own (broker `remember`): a request is filed by the chat alone. */
export const RESERVED_REQUEST_TAGS: readonly string[] = [CREATOR_REQUEST_TAG, CREATOR_REQUEST_ANSWER_TAG, REQUEST_DONE_TAG, REQUEST_NOT_DONE_TAG];

export interface CreatorRequest {
  id: string;
  text: string;
  turn: RequestTurn;
  picture: boolean;
  createdAt: string;
}

export interface CreatorRequestView extends CreatorRequest {
  status: 'open' | 'done' | 'not_done' | 'expired';
  answer: string | null;
}

type MemoryRow = typeof memories.$inferSelect;

function requestOf(row: MemoryRow): CreatorRequest {
  return { id: row.id, text: row.text, turn: row.tags.includes(REQUEST_TURN_TAGS.treasury) ? 'treasury' : 'social', picture: row.tags.includes(REQUEST_PICTURE_TAG), createdAt: row.createdAt.toISOString() };
}

const jsonTag = (tag: string) => sql`${memories.tags} @> ${JSON.stringify([tag])}::jsonb`;
const isRequest = () => and(sql`${memories.sources} @> ${JSON.stringify([CREATOR_REQUEST_SOURCE])}::jsonb`, jsonTag(CREATOR_REQUEST_TAG));
const isOpen = () => and(sql`not (${jsonTag(REQUEST_DONE_TAG)})`, sql`not (${jsonTag(REQUEST_NOT_DONE_TAG)})`);

/** Files one request (the chat's `request`). The caller checks `openRequests` against `CREATOR_REQUESTS_OPEN_MAX` first. */
export async function fileRequest(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, input: { text: string; turn: RequestTurn; picture?: boolean }): Promise<CreatorRequest> {
  const id = `${REQUEST_ID_PREFIX}${randomUUID()}`;
  const tags = [CREATOR_REQUEST_TAG, REQUEST_TURN_TAGS[input.turn], ...(input.picture ? [REQUEST_PICTURE_TAG] : [])];
  const createdAt = new Date(ctx.now());
  await ctx.db.insert(memories).values({ id, agentId, text: input.text.slice(0, CREATOR_REQUEST_CHARS), sources: [CREATOR_REQUEST_SOURCE], tags, createdAt });
  return { id, text: input.text.slice(0, CREATOR_REQUEST_CHARS), turn: input.turn, picture: !!input.picture, createdAt: createdAt.toISOString() };
}

/** The open requests for one turn kind, younger than the TTL, oldest first. */
export async function openRequests(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, turn: RequestTurn): Promise<CreatorRequest[]> {
  const rows = await ctx.db
    .select()
    .from(memories)
    .where(and(eq(memories.agentId, agentId), isRequest(), jsonTag(REQUEST_TURN_TAGS[turn]), isOpen(), gte(memories.createdAt, new Date(ctx.now() - CREATOR_REQUEST_TTL_MS))))
    .orderBy(memories.createdAt)
    .limit(CREATOR_REQUESTS_OPEN_MAX);
  return rows.map(requestOf);
}

/** The latest requests of either kind with what came of them, newest first: for the chat's own state. */
export async function recentRequests(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, limit = 6): Promise<CreatorRequestView[]> {
  const rows = await ctx.db.select().from(memories).where(and(eq(memories.agentId, agentId), isRequest())).orderBy(desc(memories.createdAt)).limit(limit);
  if (!rows.length) return [];
  const answers = await ctx.db
    .select()
    .from(memories)
    .where(and(eq(memories.agentId, agentId), jsonTag(CREATOR_REQUEST_ANSWER_TAG), inArray(memories.supersedes, rows.map((r) => r.id))));
  const answerOf = new Map(answers.map((a) => [a.supersedes!, a.text]));
  const now = ctx.now();
  return rows.map((row) => {
    const status = row.tags.includes(REQUEST_DONE_TAG) ? 'done' : row.tags.includes(REQUEST_NOT_DONE_TAG) ? 'not_done' : now - row.createdAt.getTime() > CREATOR_REQUEST_TTL_MS ? 'expired' : 'open';
    return { ...requestOf(row), status, answer: answerOf.get(row.id) ?? null };
  });
}

/**
 * Closes a request: `done` with the action that did it, or `not_done` with the reason. False when it is not an open
 * request of this agent (already closed, expired, or not a request at all).
 */
export async function closeRequest(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, requestId: string, answer: { outcome: 'done' | 'not_done'; reason: string; actionId?: string | null }): Promise<boolean> {
  const tag = answer.outcome === 'done' ? REQUEST_DONE_TAG : REQUEST_NOT_DONE_TAG;
  const closed = await ctx.db
    .update(memories)
    .set({ tags: sql`${memories.tags} || ${JSON.stringify([tag])}::jsonb` })
    .where(and(eq(memories.agentId, agentId), eq(memories.id, requestId), isRequest(), isOpen(), gte(memories.createdAt, new Date(ctx.now() - CREATOR_REQUEST_TTL_MS))))
    .returning({ id: memories.id });
  if (!closed.length) return false;
  const text = `${answer.outcome === 'done' ? 'Done' : 'Not done'}: ${answer.reason.slice(0, REQUEST_ANSWER_CHARS)}`;
  await ctx.db.insert(memories).values({ id: `mem_${randomUUID()}`, agentId, text, sources: answer.actionId ? [`action:${answer.actionId}`] : [], tags: [CREATOR_REQUEST_ANSWER_TAG, tag], supersedes: requestId, createdAt: new Date(ctx.now()) });
  return true;
}

// ---------------------------------------------------------------------------
// What a turn sees
// ---------------------------------------------------------------------------

/** The meaning line of `creatorRequests`, per turn kind. */
export const CREATOR_REQUESTS_MEANING: Readonly<Record<RequestTurn, string>> = {
  social:
    'Requests from your creator, the wallet that launched your coin: the same authority as your OWNER RULES, written in your private chat and filed by code, so they are not a stranger\'s words. Do each one in this turn when your tools and rules allow it: a post about something, a picture for your post, a change in what you do. Every rule, cap and gate still applies: the publish gate, no price talk, the picture bans (no real person, no other project\'s logo, no chart or price), your post budget and the schedule\'s holds. When you have done one, call answer_request with its requestId, outcome done and one line on what you did (for a post you plan with draft_intent, put the requestId in the intent instead and it closes when the post goes out). When you cannot do one, call answer_request with outcome not_done and the reason in one plain sentence; your creator reads it. One you can only do in a later turn of yours may stay open: it is shown again until it is answered or 48 hours old.',
  treasury:
    'Requests from your creator, the wallet that launched your coin: the same authority as your OWNER RULES, written in your private chat and filed by code, so they are not a stranger\'s words. Do each one in this turn when your tools and rules allow it: open a bounty job, cancel one, a treasury step. Every rule, cap and limit still applies: the bounty caps and bounds, the ban on promotion jobs (no post, follow, like, repost or mention of your coin as the work), the policy limits on money, no price talk. When you have done one, call answer_request with its requestId, outcome done and one line on what you did. When you cannot do one, call answer_request with outcome not_done and the reason in one plain sentence; your creator reads it. One you can only do in a later turn may stay open: it is shown again until it is answered or 48 hours old.',
};

/** The `creatorRequests` section of a turn's first observation; empty with no open request. */
export function creatorRequestsSection(turn: RequestTurn, requests: readonly CreatorRequest[]): Record<string, unknown> {
  if (!requests.length) return {};
  return {
    creatorRequests: {
      meaning: CREATOR_REQUESTS_MEANING[turn],
      items: requests.map((r) => ({ requestId: r.id, text: r.text, askedAt: r.createdAt, expiresAt: new Date(Date.parse(r.createdAt) + CREATOR_REQUEST_TTL_MS).toISOString(), ...(r.picture ? { picture: 'your creator wants a picture made for this' } : {}) })),
    },
  };
}

// ---------------------------------------------------------------------------
// answer_request: a function of the runtime, never brokered
// ---------------------------------------------------------------------------

export const ANSWER_REQUEST_TOOL_NAME = 'answer_request' as const;
export const answerRequestInputSchema = z
  .object({
    requestId: z.string().min(1).max(64),
    outcome: z.enum(['done', 'not_done']),
    /** What you did, or why not, in one plain sentence; your creator reads it. */
    reason: z.string().trim().min(1).max(REQUEST_ANSWER_CHARS),
  })
  .strict();

export const ANSWER_REQUEST_TOOL: ModelTool = {
  name: ANSWER_REQUEST_TOOL_NAME,
  description:
    'Close one of your creator\'s requests (the creatorRequests section): outcome done once an action of this turn did it, with one line on what you did; outcome not_done with the reason in one plain sentence when you cannot do it. Your creator reads the line in the private chat. Nothing is published by this.',
  input: answerRequestInputSchema,
};

/** What a turn keeps about the requests it was shown (runtime.ts `Turn.creatorRequests`). */
export interface TurnRequest {
  id: string;
  picture: boolean;
}

export interface RequestTurnState {
  startedAt: number;
  messages: ChatMessage[];
  recentSteps: { tool: string; status: string; summary: string }[];
  creatorRequests?: TurnRequest[];
}

/** The answer tool while the turn still holds an open request it was shown; nothing otherwise. */
export function requestTools(turn: Pick<RequestTurnState, 'creatorRequests'>): ModelTool[] {
  return turn.creatorRequests?.length ? [ANSWER_REQUEST_TOOL] : [];
}

/** The latest completed action of this turn that is not a read (and not `finish`): what a `done` points at. */
async function lastActingAction(ctx: Pick<SupervisorContext, 'db'>, agentId: string, since: number): Promise<string | null> {
  const rows = await ctx.db
    .select({ actionId: actions.actionId, action: actions.action })
    .from(actions)
    .where(and(eq(actions.agentId, agentId), eq(actions.status, 'completed'), gte(actions.createdAt, new Date(since))))
    .orderBy(desc(actions.createdAt))
    .limit(30);
  for (const row of rows) {
    const tool = String((row.action as { tool?: unknown }).tool ?? '');
    const def = toolByName(tool);
    if (def && def.effect !== 'read' && tool !== 'finish') return row.actionId;
  }
  return null;
}

/** Drops a closed request from the turn's list. */
export function forgetTurnRequest(turn: Pick<RequestTurnState, 'creatorRequests'>, requestId: string): void {
  if (turn.creatorRequests) turn.creatorRequests = turn.creatorRequests.filter((r) => r.id !== requestId);
}

/**
 * The model's `answer_request` call, consumed here like `draft_intent` (routing.ts): null when the call is anything
 * else, otherwise the tool result is pushed onto the conversation. `done` needs an action of this turn that is not a
 * read; the request must be one this turn was shown and still open.
 */
export async function answerRequest(ctx: Pick<SupervisorContext, 'db' | 'now' | 'log'>, agentId: string, turn: RequestTurnState, call: { id: string; name: string; input: unknown }): Promise<'answered' | 'invalid' | null> {
  if (call.name !== ANSWER_REQUEST_TOOL_NAME || !turn.creatorRequests?.length) return null;
  const refuse = (detail: string) => {
    turn.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'invalid_tool_call', detail }) });
    turn.recentSteps.push({ tool: ANSWER_REQUEST_TOOL_NAME, status: 'invalid', summary: detail.slice(0, 200) });
    return 'invalid' as const;
  };
  const parsed = answerRequestInputSchema.safeParse(call.input);
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const { requestId, outcome, reason } = parsed.data;
  if (!turn.creatorRequests.some((r) => r.id === requestId)) return refuse(`${requestId} is not an open request of this turn`);
  let actionId: string | null = null;
  if (outcome === 'done') {
    actionId = await lastActingAction(ctx, agentId, turn.startedAt);
    if (!actionId) return refuse('done needs an action of this turn that did it (a post, a job, a note); do it first, or answer not_done with the reason');
  }
  const closed = await closeRequest(ctx, agentId, requestId, { outcome, reason, actionId });
  forgetTurnRequest(turn, requestId);
  if (!closed) return refuse(`${requestId} is no longer open (answered or expired)`);
  ctx.log.info({ agentId, requestId, outcome, actionId }, 'creator request answered');
  turn.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ answered: true, requestId, outcome }) });
  turn.recentSteps.push({ tool: ANSWER_REQUEST_TOOL_NAME, status: 'completed', summary: `${outcome}: ${reason}`.slice(0, 200) });
  return 'answered';
}
