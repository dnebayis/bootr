/**
 * The judge role (docs/design/agent-capabilities.md sections 3.3 and 3.4): one paid thought with no tools that rules
 * on the entries to a bounty job. It sees the job text, its numbered criteria and the entries as artefacts (a picture
 * as vision input, a page as a bounded excerpt), never reply text, author names or addresses: the caller (Bounties,
 * docs/STATUS.md section 3 item 3; none exists yet) strips those before it gets here, and nothing in this module reads
 * X, the inbox or the memories.
 *
 * The answer is a strict JSON object checked in code: the winner in range, every criterion `pass` for it, a reason of at
 * most 200 characters that passes the publish gate (no address, no cashtag, no link, no handle). Any failure is
 * `winner: null` with an `invalid` code, and the job closes unpaid; the judge names a winner, never a payment.
 *
 * Never asked twice for one job: the thought's idempotency key is derived from the job id, so a second call for the
 * same job replays the stored answer (or reconciles an unknown one) through `relayRequest` and never pays again. The
 * model is the agent's own, or `config.judgeModel` when the console pinned a cheaper one (design decision 10).
 *
 * An own-agent coin (docs/design/byo-agent.md; `isOwn`, the stored config, whatever the flag says) is never ruled on
 * here: its creator's client rules (own/judge.ts) through `parseVerdict`, the same check. Should anything ask
 * `judgeJob` for such a coin all the same, it answers `thought_pending` and buys nothing.
 */
import { buildSystemPrompt, countCashtags, digest, linkedHosts, maxQuoteFor, mentionedHandles, postValidation, type AgentConfig } from '@bootr/agent-core';
import type { AgentRow, SupervisorContext } from './context.js';
import { assistantText, parseAssistant, relayRequest, type RelayResult } from './inference.js';
import { isOwn } from './own/registry.js';

export type JudgeMark = 'pass' | 'fail' | 'insufficient_evidence';
export const JUDGE_MARKS: readonly JudgeMark[] = ['pass', 'fail', 'insufficient_evidence'];

export interface JudgeEntry {
  /** The entry's number as the job card shows it (1-based, unique within the job). */
  n: number;
  kind: 'image' | 'link';
  /** The picture, re-encoded by the caller: raw bytes with their mime, or a ready `data:image/...;base64,` url. */
  image?: { mime: string; bytes?: Uint8Array; dataUrl?: string };
  /** The linked page's bounded, re-serialised text (the web-reader's output), for a `link` entry. */
  excerpt?: string;
}

export interface JudgeInput {
  jobId: string;
  task: string;
  /** 1 to 4 criteria, as written at post time. */
  criteria: string[];
  /** 1 to 12 eligible entries (the design's cap). */
  entries: JudgeEntry[];
}

export type JudgeInvalidCode =
  | 'invalid_input'
  | 'input_too_large'
  | 'thought_failed'
  | 'thought_pending'
  | 'malformed_answer'
  | 'winner_out_of_range'
  | 'winner_not_passing'
  | 'reason_too_long'
  | 'reason_forbidden';

export interface JudgeVerdict {
  jobId: string;
  winner: number | null;
  /** Entry number (as a string key) to one mark per criterion, in the criteria's order. */
  perCriterion: Record<string, JudgeMark[]>;
  reason: string;
  /** Why there is no winner although the model may have named one; absent when the verdict stands as answered. */
  invalid?: JudgeInvalidCode;
  /** The thought behind it: `none` when nothing was asked (invalid input), else the relay result's kind. */
  thought: { key: string; model: string; outcome: 'ok' | 'failed' | 'unknown' | 'credit' | 'none'; replayed: boolean; chargedMicroUsdc: string | null };
}

export const JUDGE_MAX_CRITERIA = 4;
export const JUDGE_MAX_ENTRIES = 12;
export const JUDGE_MAX_TASK_CHARS = 600;
export const JUDGE_MAX_CRITERION_CHARS = 300;
export const JUDGE_MAX_EXCERPT_CHARS = 6000;
export const JUDGE_MAX_REASON_CHARS = 200;
/** One re-encoded picture (the design says at most 5 MB before re-encoding; a judged picture needs far less). */
export const JUDGE_MAX_IMAGE_BYTES = 2_000_000;
/** The whole request, pictures as base64 included: what one chat-completions body may carry to the relay or BlockRun. */
export const JUDGE_MAX_REQUEST_BYTES = 12_000_000;
/** The answer is one small JSON object; the room covers twelve entries by four criteria with a reason. */
export const JUDGE_MAX_OUTPUT_TOKENS = 700;

/** The idempotency key of the one thought a job gets: the same job id always maps to the same key. */
export function judgeKey(agentId: string, jobId: string): string {
  return `judge:${agentId}:${digest({ jobId }).slice(0, 32)}`;
}

/** The model the judge rules with: the console's pin, else the agent's own. */
export function judgeModelFor(config: Pick<AgentConfig, 'model' | 'judgeModel'>): string {
  return config.judgeModel ?? config.model;
}

// eslint-disable-next-line no-control-regex -- stripping them is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const plain = (text: string, max: number) => text.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * A text as the judge gets it: control characters out, whitespace flattened, cut to `max`. The hosted thought's input
 * goes through this in `normalizeJudgeInput`; an own agent's judge turn (own/judge.ts) uses the same function for the
 * job text, the criteria and a page's excerpt, so both judges read the same words.
 */
export function judgeText(text: string, max: number): string {
  return plain(text, max);
}

/** The input as the thought gets it (texts bounded and flattened, pictures as data urls), or the reason it is refused. */
export function normalizeJudgeInput(input: JudgeInput): { ok: true; input: JudgeInput } | { ok: false; invalid: 'invalid_input' | 'input_too_large' } {
  const bad = { ok: false as const, invalid: 'invalid_input' as const };
  if (typeof input.jobId !== 'string' || !input.jobId.trim() || input.jobId.length > 128) return bad;
  if (typeof input.task !== 'string' || !input.task.trim()) return bad;
  if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > JUDGE_MAX_CRITERIA) return bad;
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > JUDGE_MAX_ENTRIES) return bad;
  const criteria = input.criteria.map((c) => (typeof c === 'string' ? plain(c, JUDGE_MAX_CRITERION_CHARS) : ''));
  if (criteria.some((c) => !c)) return bad;
  const seen = new Set<number>();
  const entries: JudgeEntry[] = [];
  for (const entry of input.entries) {
    if (!Number.isInteger(entry.n) || entry.n < 1 || seen.has(entry.n)) return bad;
    seen.add(entry.n);
    if (entry.kind === 'image') {
      const image = entry.image;
      if (!image || typeof image.mime !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(image.mime)) return bad;
      let dataUrl: string;
      if (image.bytes) {
        if (image.bytes.byteLength === 0) return bad;
        if (image.bytes.byteLength > JUDGE_MAX_IMAGE_BYTES) return { ok: false, invalid: 'input_too_large' };
        dataUrl = `data:${image.mime.toLowerCase()};base64,${Buffer.from(image.bytes).toString('base64')}`;
      } else if (typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/')) {
        if (image.dataUrl.length > JUDGE_MAX_IMAGE_BYTES * 1.4) return { ok: false, invalid: 'input_too_large' };
        dataUrl = image.dataUrl;
      } else return bad;
      entries.push({ n: entry.n, kind: 'image', image: { mime: image.mime.toLowerCase(), dataUrl } });
    } else if (entry.kind === 'link') {
      const excerpt = typeof entry.excerpt === 'string' ? plain(entry.excerpt, JUDGE_MAX_EXCERPT_CHARS) : '';
      if (!excerpt) return bad;
      entries.push({ n: entry.n, kind: 'link', excerpt });
    } else return bad;
  }
  return { ok: true, input: { jobId: input.jobId.trim(), task: plain(input.task, JUDGE_MAX_TASK_CHARS), criteria, entries: entries.sort((a, b) => a.n - b.n) } };
}

/**
 * The one request: the judge's prompt as the system message and the job as data in the user message, the criteria
 * numbered, the entries numbered, a text part per link and an image part per picture. No tools, no economy mode.
 */
export function judgeRequest(config: AgentConfig, input: JudgeInput): Record<string, unknown> {
  const job = {
    instructionAuthority: false,
    meaning: 'The job this agent posted and the entries that came in. Mark every criterion for every entry, then name the best entry that passes them all, or null.',
    jobId: input.jobId,
    task: input.task,
    criteria: input.criteria.map((text, i) => ({ n: i + 1, text })),
    entries: input.entries.map((e) => (e.kind === 'link' ? { n: e.n, kind: 'link', excerpt: e.excerpt } : { n: e.n, kind: 'image', note: `the picture follows below as "Entry ${e.n}"` })),
    answer: `{"winner": <entry number or null>, "perCriterion": {"<entry number>": [${input.criteria.map(() => '"pass" | "fail" | "insufficient_evidence"').join(', ')}]}, "reason": "<at most ${JUDGE_MAX_REASON_CHARS} characters>"}`,
  };
  const parts: Record<string, unknown>[] = [{ type: 'text', text: JSON.stringify(job) }];
  for (const e of input.entries) {
    if (e.kind !== 'image' || !e.image?.dataUrl) continue;
    parts.push({ type: 'text', text: `Entry ${e.n} (image):` }, { type: 'image_url', image_url: { url: e.image.dataUrl } });
  }
  return {
    model: judgeModelFor(config),
    messages: [
      { role: 'system', content: buildSystemPrompt(config, 'judge') },
      { role: 'user', content: parts },
    ],
    max_tokens: JUDGE_MAX_OUTPUT_TOKENS,
    stream: false,
    store: false,
  };
}

/**
 * The reason as public text: at most 200 characters, through the publish gate with no address allowed at all, and
 * without a cashtag, a link or a handle. Returns the code when it fails.
 */
export function reasonProblem(reason: unknown): 'reason_too_long' | 'reason_forbidden' | 'malformed_answer' | null {
  if (typeof reason !== 'string') return 'malformed_answer';
  const text = reason.trim();
  if (text.length > JUDGE_MAX_REASON_CHARS) return 'reason_too_long';
  if (!text) return null;
  if (!postValidation(text, [], 'short', false, { publicAddresses: [] }).ok) return 'reason_forbidden';
  if (countCashtags(text) > 0 || linkedHosts(text).length > 0 || /https?:\/\/|www\./i.test(text) || mentionedHandles(text).length > 0) return 'reason_forbidden';
  return null;
}

type Parsed = { winner: number | null; perCriterion: Record<string, JudgeMark[]>; reason: string };

/** The model's text as a verdict, or the code that makes it no verdict. Strict: every entry marked for every criterion. */
export function parseVerdict(text: string | null, input: JudgeInput): { ok: true; verdict: Parsed } | { ok: false; invalid: JudgeInvalidCode; partial?: Partial<Parsed> } {
  if (!text) return { ok: false, invalid: 'malformed_answer' };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, invalid: 'malformed_answer' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, invalid: 'malformed_answer' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, invalid: 'malformed_answer' };
  const o = raw as { winner?: unknown; perCriterion?: unknown; reason?: unknown };
  if (!(o.winner === null || (typeof o.winner === 'number' && Number.isInteger(o.winner)))) return { ok: false, invalid: 'malformed_answer' };
  if (!o.perCriterion || typeof o.perCriterion !== 'object' || Array.isArray(o.perCriterion)) return { ok: false, invalid: 'malformed_answer' };
  const perCriterion: Record<string, JudgeMark[]> = {};
  for (const entry of input.entries) {
    const marks = (o.perCriterion as Record<string, unknown>)[String(entry.n)];
    if (!Array.isArray(marks) || marks.length !== input.criteria.length || !marks.every((m) => (JUDGE_MARKS as readonly unknown[]).includes(m))) return { ok: false, invalid: 'malformed_answer' };
    perCriterion[String(entry.n)] = marks as JudgeMark[];
  }
  const reasonCode = reasonProblem(o.reason);
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  if (reasonCode === 'malformed_answer') return { ok: false, invalid: reasonCode, partial: { winner: o.winner as number | null, perCriterion } };
  const winner = o.winner as number | null;
  if (winner !== null && !input.entries.some((e) => e.n === winner)) return { ok: false, invalid: 'winner_out_of_range', partial: { perCriterion, reason: reasonCode ? '' : reason } };
  if (winner !== null && !perCriterion[String(winner)]!.every((m) => m === 'pass')) return { ok: false, invalid: 'winner_not_passing', partial: { perCriterion, reason: reasonCode ? '' : reason } };
  if (reasonCode) return { ok: false, invalid: reasonCode, partial: { perCriterion, reason: '' } };
  return { ok: true, verdict: { winner, perCriterion, reason } };
}

function thoughtOf(key: string, model: string, res: RelayResult | null): JudgeVerdict['thought'] {
  if (!res) return { key, model, outcome: 'none', replayed: false, chargedMicroUsdc: null };
  return { key, model, outcome: res.kind, replayed: res.kind === 'ok' ? res.replayed : false, chargedMicroUsdc: res.kind === 'ok' ? (res.receipt?.chargedMicroUsdc ?? null) : null };
}

/**
 * Rules on one job: one paid thought at most, ever, for this job id. `invalid` says why there is no winner when the
 * model's answer (or the thought itself) did not hold; a verdict without it stands as answered, `winner` null
 * included (nothing met the job). The caller pays nothing on `invalid` and nothing on a null winner.
 */
export async function judgeJob(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, rawInput: JudgeInput): Promise<JudgeVerdict> {
  const model = judgeModelFor(config);
  const key = judgeKey(agent.agentId, typeof rawInput?.jobId === 'string' ? rawInput.jobId.trim() : '');
  // An own coin buys no thought, ever: the caller (bounties.ts) does not ask for one, and this is the lock behind that
  // door. `thought_pending` leaves the job as it is, waiting for its own agent's ruling.
  if (isOwn(agent)) {
    ctx.log.warn({ agentId: agent.agentId, role: 'judge', jobId: rawInput?.jobId }, "judge asked for an own-agent coin; no thought bought, the job waits for its own agent's ruling");
    return { jobId: typeof rawInput?.jobId === 'string' ? rawInput.jobId : '', winner: null, perCriterion: {}, reason: '', invalid: 'thought_pending', thought: thoughtOf(key, model, null) };
  }
  const normalized = normalizeJudgeInput(rawInput);
  if (!normalized.ok) {
    ctx.log.info({ agentId: agent.agentId, role: 'judge', jobId: rawInput?.jobId, invalid: normalized.invalid }, 'judge refused the job input; no thought bought');
    return { jobId: typeof rawInput?.jobId === 'string' ? rawInput.jobId : '', winner: null, perCriterion: {}, reason: '', invalid: normalized.invalid, thought: thoughtOf(key, model, null) };
  }
  const input = normalized.input;
  const request = judgeRequest(config, input);
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > JUDGE_MAX_REQUEST_BYTES) {
    ctx.log.info({ agentId: agent.agentId, role: 'judge', jobId: input.jobId, invalid: 'input_too_large' }, 'judge refused the job input; no thought bought');
    return { jobId: input.jobId, winner: null, perCriterion: {}, reason: '', invalid: 'input_too_large', thought: thoughtOf(key, model, null) };
  }
  let res: RelayResult;
  try {
    res = await relayRequest(ctx, agent, { key, cycle: 0, request, maxQuoteMicroUsdc: BigInt(maxQuoteFor(model)) });
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, role: 'judge', jobId: input.jobId, key, err }, 'judge: relay call crashed');
    res = { kind: 'unknown', key, error: 'crashed' };
  }
  const receipt = res.kind === 'ok' ? res.receipt : null;
  ctx.log.info(
    {
      agentId: agent.agentId,
      role: 'judge',
      jobId: input.jobId,
      key,
      model,
      outcome: res.kind,
      entries: input.entries.length,
      criteria: input.criteria.length,
      ...(res.kind === 'ok' ? { replayed: res.replayed } : { error: res.error }),
      ...(receipt ? { chargedMicroUsdc: receipt.chargedMicroUsdc, quoteMicroUsdc: receipt.quoteMicroUsdc } : {}),
    },
    'thought',
  );
  const thought = thoughtOf(key, model, res);
  if (res.kind === 'failed') return { jobId: input.jobId, winner: null, perCriterion: {}, reason: '', invalid: 'thought_failed', thought };
  if (res.kind !== 'ok') return { jobId: input.jobId, winner: null, perCriterion: {}, reason: '', invalid: 'thought_pending', thought };
  const { message, toolCall } = parseAssistant(res.body);
  const parsed = toolCall ? { ok: false as const, invalid: 'malformed_answer' as const } : parseVerdict(assistantText(message.content), input);
  if (!parsed.ok) {
    ctx.log.info({ agentId: agent.agentId, role: 'judge', jobId: input.jobId, invalid: parsed.invalid }, 'judge verdict refused in code; no winner');
    return { jobId: input.jobId, winner: null, perCriterion: parsed.partial?.perCriterion ?? {}, reason: parsed.partial?.reason ?? '', invalid: parsed.invalid, thought };
  }
  return { jobId: input.jobId, ...parsed.verdict, thought };
}
