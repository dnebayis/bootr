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
 * At most two paid thoughts per job, ever: the idempotency key of each is derived from the job id and the attempt's
 * number, so a second call for the same job replays the stored answers (or reconciles an unknown one) through
 * `relayRequest` and never pays again. The second thought is asked only when the first gave no usable answer
 * (`malformed_answer`: the text was no verdict; `thought_failed`: the relay gave none), under its own key, because the
 * relay replays what it stored for the first. An answer refused in code is handed back as `refused` (its text, cut to
 * JUDGE_MAX_RAW_CHARS, with the provider's finish reason) so the caller can keep it for whoever reads the failure; it
 * is the model's output and is never logged. The model is the agent's own, or `config.judgeModel` when the console
 * pinned a cheaper one (design decision 10).
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
  /** The thought behind it (the last one asked): `none` when nothing was asked (invalid input), else the relay result's kind. */
  thought: JudgeThought;
  /** Every thought asked for this ruling, in order (one, or two when the first gave no usable answer). Absent on a ruling no thought was asked for. */
  thoughts?: JudgeThought[];
  /** The answers code refused as no verdict, in order: what the model wrote, cut to JUDGE_MAX_RAW_CHARS. Never logged, never public. */
  refused?: JudgeRefusedAnswer[];
}

export interface JudgeThought {
  key: string;
  model: string;
  outcome: 'ok' | 'failed' | 'unknown' | 'credit' | 'none';
  replayed: boolean;
  chargedMicroUsdc: string | null;
}

export interface JudgeRefusedAnswer {
  attempt: number;
  invalid: JudgeInvalidCode;
  /** The provider's word for why the answer ended (`stop`, `length`, ...), or null. `length` means the output budget ran out. */
  finishReason: string | null;
  /** Output tokens the provider counted, when it said. */
  completionTokens: number | null;
  /** The answer's text, cut; empty when the model returned no text at all (a tool call, or only reasoning). */
  raw: string;
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
/**
 * The answer is one JSON object: twelve entries by four criteria with a reason is about 500 tokens. The room is four
 * times that, because a model that writes a few lines about each picture before the object (or wraps it in a fence)
 * ran past the earlier 700 on a seven-entry job and left an answer cut off mid-object.
 */
export const JUDGE_MAX_OUTPUT_TOKENS = 2000;
/** Paid thoughts one job may ever get: the first, and one more when the first gave no usable answer. */
export const JUDGE_MAX_THOUGHTS = 2;
/** How much of a refused answer is kept for reading later. */
export const JUDGE_MAX_RAW_CHARS = 4000;
/** The codes that mean "the thought gave no usable answer": the only ones a second thought is asked after. */
export const JUDGE_RETRY_CODES: readonly JudgeInvalidCode[] = ['malformed_answer', 'thought_failed'];

/**
 * The idempotency key of a job's thought: the same job id and attempt always map to the same key. The first attempt's
 * key is the one every job judged before the retry existed was paid under, so its stored answer still replays.
 */
export function judgeKey(agentId: string, jobId: string, attempt = 1): string {
  return `judge:${agentId}:${digest(attempt <= 1 ? { jobId } : { jobId, attempt }).slice(0, 32)}`;
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
    meaning: 'The job this agent posted and the entries that came in. Mark every criterion for every entry, then name the best entry that passes them all, or null. Your whole answer is the one JSON object described under answer: no notes about the entries before it, no code fence around it, nothing after it.',
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

/** Every balanced `{...}` of a text that is not inside another one, in order (strings and escapes respected). */
function topLevelObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === '{') {
      if (depth === 0) from = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && from >= 0) out.push(text.slice(from, i + 1));
    }
  }
  return out;
}

const asObject = (text: string): Record<string, unknown> | null => {
  try {
    const raw: unknown = JSON.parse(text);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * The verdict object in a model's text. A model told to answer with one JSON object still wraps it in a ```json fence
 * or writes a line before it, so the object is looked for in this order: inside a code fence, the text from its first
 * `{` to its last `}`, then each balanced object on its own (the last one that carries `winner` or `perCriterion`).
 * Which object is read changes nothing about what may win: the rules below are applied to whatever is found.
 */
function verdictObject(text: string): Record<string, unknown> | null {
  const looksLikeVerdict = (o: Record<string, unknown> | null): o is Record<string, unknown> => !!o && ('winner' in o || 'perCriterion' in o);
  for (const fence of text.matchAll(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/g)) {
    const inner = fence[1] ?? '';
    const o = asObject(inner.slice(Math.max(0, inner.indexOf('{')), inner.lastIndexOf('}') + 1));
    if (looksLikeVerdict(o)) return o;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const whole = asObject(text.slice(start, end + 1));
  if (whole) return whole;
  const parts = topLevelObjects(text).map(asObject).filter(looksLikeVerdict);
  return parts.length ? parts[parts.length - 1]! : null;
}

/** An entry number as a model writes it: 3, "3", "Entry 3", "entry_3", "#3". Null for anything else. */
function entryNumberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 ? value : null;
  if (typeof value !== 'string') return null;
  const m = /^\s*(?:entry|no\.?|number|n)?[\s_#:.-]*(\d{1,4})\s*$/i.exec(value);
  return m ? Number(m[1]) : null;
}

/** One mark in the three words the rules know, whatever its case or its separator ("PASS", "Insufficient evidence"). Null for any other word. */
function markOf(value: unknown): JudgeMark | null {
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (JUDGE_MARKS as readonly string[]).includes(word) ? (word as JudgeMark) : null;
}

/** The marks of one entry, one per criterion in order: an array, or an object keyed by the criteria's numbers 1..k. Null when it is neither or a mark is no mark. */
function marksOf(value: unknown, criteria: number): JudgeMark[] | null {
  let list: unknown[];
  if (Array.isArray(value)) list = value;
  else if (value && typeof value === 'object') {
    const byNumber = new Map<number, unknown>();
    for (const [key, mark] of Object.entries(value as Record<string, unknown>)) {
      const m = /^\s*(?:criterion|c)?[\s_#:.-]*(\d{1,2})\s*$/i.exec(key);
      if (!m || byNumber.has(Number(m[1]))) return null;
      byNumber.set(Number(m[1]), mark);
    }
    if (byNumber.size !== criteria) return null;
    list = [];
    for (let i = 1; i <= criteria; i++) list.push(byNumber.get(i));
  } else return null;
  if (list.length !== criteria) return null;
  const marks = list.map(markOf);
  return marks.every((m): m is JudgeMark => m !== null) ? marks : null;
}

/** `perCriterion` by entry number: an object whose keys name entries, or a list of `{entry | n, marks}`. An entry named twice is no answer. */
function marksByEntry(value: unknown): Map<number, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const out = new Map<number, unknown>();
  const put = (n: number | null, marks: unknown): boolean => {
    if (n === null || out.has(n)) return false;
    out.set(n, marks);
    return true;
  };
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const o = item as Record<string, unknown>;
      if (!put(entryNumberOf(o.entry ?? o.n), o.marks ?? o.criteria)) return null;
    }
    return out;
  }
  for (const [key, marks] of Object.entries(value as Record<string, unknown>)) if (!put(entryNumberOf(key), marks)) return null;
  return out;
}

/**
 * The model's text as a verdict, or the code that makes it no verdict. Tolerant about the wrapping and the spelling (a
 * code fence, a line before the object, entry keys written "Entry 3", marks in capitals), strict about the ruling:
 * every entry marked for every criterion with one of the three marks, the winner one of the entries and `pass` on
 * every criterion, the reason through `reasonProblem`.
 */
export function parseVerdict(text: string | null, input: JudgeInput): { ok: true; verdict: Parsed } | { ok: false; invalid: JudgeInvalidCode; partial?: Partial<Parsed> } {
  if (!text) return { ok: false, invalid: 'malformed_answer' };
  const o = verdictObject(text) as { winner?: unknown; perCriterion?: unknown; reason?: unknown } | null;
  if (!o) return { ok: false, invalid: 'malformed_answer' };
  let winner: number | null;
  if (o.winner === null || (typeof o.winner === 'string' && /^\s*(?:null|none)\s*$/i.test(o.winner))) winner = null;
  else {
    const n = typeof o.winner === 'number' ? (Number.isInteger(o.winner) ? o.winner : null) : entryNumberOf(o.winner);
    if (n === null) return { ok: false, invalid: 'malformed_answer' };
    winner = n;
  }
  const byEntry = marksByEntry(o.perCriterion);
  if (!byEntry) return { ok: false, invalid: 'malformed_answer' };
  const perCriterion: Record<string, JudgeMark[]> = {};
  for (const entry of input.entries) {
    const marks = marksOf(byEntry.get(entry.n), input.criteria.length);
    if (!marks) return { ok: false, invalid: 'malformed_answer' };
    perCriterion[String(entry.n)] = marks;
  }
  const reasonCode = reasonProblem(o.reason);
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  if (reasonCode === 'malformed_answer') return { ok: false, invalid: reasonCode, partial: { winner, perCriterion } };
  if (winner !== null && !input.entries.some((e) => e.n === winner)) return { ok: false, invalid: 'winner_out_of_range', partial: { perCriterion, reason: reasonCode ? '' : reason } };
  if (winner !== null && !perCriterion[String(winner)]!.every((m) => m === 'pass')) return { ok: false, invalid: 'winner_not_passing', partial: { perCriterion, reason: reasonCode ? '' : reason } };
  if (reasonCode) return { ok: false, invalid: reasonCode, partial: { perCriterion, reason: '' } };
  return { ok: true, verdict: { winner, perCriterion, reason } };
}

function thoughtOf(key: string, model: string, res: RelayResult | null): JudgeThought {
  if (!res) return { key, model, outcome: 'none', replayed: false, chargedMicroUsdc: null };
  return { key, model, outcome: res.kind, replayed: res.kind === 'ok' ? res.replayed : false, chargedMicroUsdc: res.kind === 'ok' ? (res.receipt?.chargedMicroUsdc ?? null) : null };
}

/**
 * Rules on one job: two paid thoughts at most, ever, for this job id. The second is asked only when the first gave no
 * usable answer (`JUDGE_RETRY_CODES`), under its own key; a thought whose outcome is unknown is never replaced.
 * `invalid` says why there is no winner when the model's answer (or the thought itself) did not hold; a verdict without
 * it stands as answered, `winner` null included (nothing met the job). The caller pays nothing on `invalid` and nothing
 * on a null winner. `fromAttempt: 2` skips the first thought: for a job whose first answer was given on other artefacts
 * than the ones in hand (a re-judge whose pictures changed), where replaying it would rule on what is no longer there.
 */
export async function judgeJob(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, rawInput: JudgeInput, opts: { fromAttempt?: 1 | 2 } = {}): Promise<JudgeVerdict> {
  const model = judgeModelFor(config);
  const first = opts.fromAttempt === 2 ? 2 : 1;
  const key = judgeKey(agent.agentId, typeof rawInput?.jobId === 'string' ? rawInput.jobId.trim() : '', first);
  // An own coin buys no thought, ever: the caller (bounties.ts) does not ask for one, and this is the lock behind that
  // door. `thought_pending` leaves the job as it is, waiting for its own agent's ruling.
  // ...and the row in the caller's hand may be older than a runner switch (the bounty sweep reads it once per sweep),
  // so the stored config is asked too: either one saying `own` is enough.
  const stored = await ctx.db.query.agents.findFirst({ where: (t, { eq }) => eq(t.agentId, agent.agentId), columns: { config: true } });
  if (isOwn(agent) || (stored && isOwn(stored))) {
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
  const thoughts: JudgeThought[] = [];
  const refused: JudgeRefusedAnswer[] = [];
  let verdict: Omit<JudgeVerdict, 'thoughts' | 'refused'> | null = null;
  for (let attempt = first; attempt <= JUDGE_MAX_THOUGHTS; attempt++) {
    const one = await judgeOnce(ctx, agent, model, input, request, attempt);
    thoughts.push(one.verdict.thought);
    if (one.refused) refused.push(one.refused);
    verdict = one.verdict;
    if (!one.verdict.invalid || !JUDGE_RETRY_CODES.includes(one.verdict.invalid)) break;
    if (attempt < JUDGE_MAX_THOUGHTS) ctx.log.info({ agentId: agent.agentId, role: 'judge', jobId: input.jobId, invalid: one.verdict.invalid, attempt }, 'judge thought gave no usable answer; asking once more under a new key');
  }
  return { ...verdict!, thoughts, ...(refused.length ? { refused } : {}) };
}

/** One thought of a job's ruling, under the key of its attempt: replayed when that key was already paid for. */
async function judgeOnce(ctx: SupervisorContext, agent: AgentRow, model: string, input: JudgeInput, request: Record<string, unknown>, attempt: number): Promise<{ verdict: Omit<JudgeVerdict, 'thoughts' | 'refused'>; refused?: JudgeRefusedAnswer }> {
  const key = judgeKey(agent.agentId, input.jobId, attempt);
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
      attempt,
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
  if (res.kind === 'failed') return { verdict: { jobId: input.jobId, winner: null, perCriterion: {}, reason: '', invalid: 'thought_failed', thought } };
  if (res.kind !== 'ok') return { verdict: { jobId: input.jobId, winner: null, perCriterion: {}, reason: '', invalid: 'thought_pending', thought } };
  const { message, toolCall, finishReason } = parseAssistant(res.body);
  const text = assistantText(message.content);
  const parsed = toolCall ? { ok: false as const, invalid: 'malformed_answer' as const, partial: undefined } : parseVerdict(text, input);
  if (!parsed.ok) {
    const completion = (res.body.usage as { completion_tokens?: unknown } | undefined)?.completion_tokens;
    // The answer's text is the model's and may quote a picture: its length and how it ended are logged, never the text.
    ctx.log.info({ agentId: agent.agentId, role: 'judge', jobId: input.jobId, invalid: parsed.invalid, attempt, finishReason, answerChars: text?.length ?? 0 }, 'judge verdict refused in code; no winner');
    return {
      verdict: { jobId: input.jobId, winner: null, perCriterion: parsed.partial?.perCriterion ?? {}, reason: parsed.partial?.reason ?? '', invalid: parsed.invalid, thought },
      refused: { attempt, invalid: parsed.invalid, finishReason, completionTokens: typeof completion === 'number' ? completion : null, raw: (text ?? '').slice(0, JUDGE_MAX_RAW_CHARS) },
    };
  }
  return { verdict: { jobId: input.jobId, ...parsed.verdict, thought } };
}
