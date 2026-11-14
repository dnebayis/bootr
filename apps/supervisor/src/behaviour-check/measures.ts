/**
 * The weekly behaviour check, as arithmetic (docs/design/agent-behaviour.md section 5; docs/dev/behaviour-check.md).
 *
 * Nobody compared an agent's posts before and after a change, so every stage of the behaviour work is judged by these
 * ten measures, taken over one agent and one window. This file is pure: it is handed rows (read from the database by
 * `database.ts`, or from public endpoints by `public.ts`) and returns the lines of one table. What a mode could not
 * read is `null` in the input and comes out as "needs the database" (or "needs the table"), never as a zero.
 *
 * What a post says is compared by `factFingerprints` and `openerOf` of agent-core and by nothing else: the said-ledger
 * and the repeat gate read the same two functions, so the check measures what the gate will refuse.
 */
import { factFingerprints, openerOf } from '@bootr/agent-core';

export const DAY_MS = 86_400_000;
/** How far back an earlier original counts as "already said" (M1). */
export const REPEAT_LOOKBACK_MS = 7 * DAY_MS;
/** "Answered in time" for a mention (M7). */
export const ANSWER_IN_TIME_MS = 15 * 60_000;
/** Reasons code closes a mention with, before any turn sees it: such a mention was never the agent's to answer (M7). */
export const CLOSED_BY_CODE: readonly string[] = ['verified_audience_required', 'bounty_entry', 'stale_after_downtime'];

export const NEEDS_DATABASE = 'needs the database';

export interface PostRow {
  /** Epoch ms. */
  at: number;
  kind: 'post' | 'reply';
  /** `completed`: it went out (or, in public mode, it is on the tape). `failed`: refused. Anything else is still open. */
  status: 'completed' | 'failed' | 'open';
  /** The whole text: for a thread, every part, joined by a newline. */
  text: string;
  /** The head of the refusal (`errorCode`), for a failed row. */
  error?: string | null;
  /** The publish named where its fact comes from in a field of its own (an attribution, a record id). */
  attributed?: boolean;
  /** Stored for the creator's review instead of sent: an attempt, and no post. */
  queued?: boolean;
  /** The embed endpoint cut the text (public mode): the end of the post was not read. */
  cut?: boolean;
}

export interface TurnRow {
  role: string;
  thoughts: number;
  outcome: string;
  posted: number;
  replied: number;
  chargedMicroUsdc: number;
}

export interface StepRow {
  at: number;
  tool: string;
  status: string;
  /** `treasury` or `judge`; absent for a social turn's step. */
  role?: string | null;
}

export interface CheckInput {
  mode: 'database' | 'public';
  agent: { id: string; handle: string | null; symbol: string | null; platform: boolean };
  /** The window, epoch ms: from (inclusive) to (exclusive). */
  from: number;
  to: number;
  readAt: number;
  /** Publishes of the window and of the `REPEAT_LOOKBACK_MS` before it. */
  posts: PostRow[];
  /** Paid thoughts of the window and what they cost; `label` says what period a public read really covers. */
  fuel: { thoughts: number; chargedMicroUsdc: number; label?: string } | null;
  /** `sv_turns` rows of the window; null when the table is not there (or in public mode). */
  turns: TurnRow[] | null;
  /** Every step of the window, oldest first: the fallback for M5 while `sv_turns` has no rows for it. */
  steps: StepRow[] | null;
  approvals: { status: string; decidedBy: string | null; note: string | null }[] | null;
  /** The sender's own refusals of the window, by error. */
  senderRejected: { error: string; n: number }[] | null;
  mentions: { observedAt: number; status: string; reason: string | null; sentAt: number | null }[] | null;
  /** `sv_gate_shadow` rows of the window, grouped; null when the table is not there. */
  shadow: { gate: string; code: string; enforced: boolean; n: number }[] | null;
  /** Context beside the ten measures (database mode). */
  notes?: { written: number; rememberCompleted: number; rememberFailed: number } | null;
  checkpoint?: { memory: number; agenda: number; summary: number } | null;
  observation?: { thoughts: number; medianChars: number; maxChars: number } | null;
  /** Things the reader must know about how complete the read was. */
  caveats?: string[];
}

export interface Line {
  id: string;
  measure: string;
  value: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Reading a post
// ---------------------------------------------------------------------------

/**
 * The stable code at the head of a tool error (`sender_rejected:policy:x`, `question_quota`), without the explanation
 * after the first space. The same rule as runtime.ts `errorCodeOf`, which a test holds this to: importing the runtime
 * here would pull the whole supervisor into a script that needs a database address and nothing else.
 */
export function errorCode(error: string | null | undefined): string {
  return (error ?? '').trim().split(/\s/)[0]!.replace(/:$/, '').slice(0, 120);
}

const LINKS = /https?:\/\/\S+/gi;
const HANDLE = /(?<![\w@])@\w{1,15}\b/;
/** A named source in words: "per Base", "Eco says", "according to", "as reported by". */
const SOURCE_CUE = /\b(?:per|says|said|according to|reported|reports|announced|posted|writes|wrote|as reported|source)\b/i;
/** What the platform account was found opening with on 2026-11-14 ("I like" in 20 of 46 posts). */
const FEELING_OPENER = /^(?:i\s+(?:like|love|enjoy|admire|appreciate)\b|i['’]?m\s+(?:excited|thrilled|glad|happy|proud)\b|(?:love|loving|excited|thrilled)\b)/i;
const I_LIKE = /\bi like\b/i;
/** The words of section 2.2: floor, dip, entry, exit, conviction, rebound, and a move written as -n%. */
const TRADING_WORDS = /\b(?:floors?|dips?|entry|entries|exits?|conviction|rebounds?|retests?)\b|(?<![\w.])[-−–]\d+(?:\.\d+)?%/i;
const ON_BOOTR = /\bon bootr\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

export interface Shapes {
  feelingOpener: boolean;
  iLike: boolean;
  closingQuestion: boolean;
  capitals: boolean;
  emoji: boolean;
  tradingWords: boolean;
  onBootr: boolean;
}

/** The shapes M9 counts, for one post. Capitals are looked for outside links, handles and cashtags, which are spelled as they are. */
export function shapesOf(text: string): Shapes {
  const plain = text.replace(LINKS, ' ');
  const words = plain.replace(/[@$]\w+/g, ' ');
  const ending = plain.replace(/[\s\p{Extended_Pictographic}️‍]+$/u, '');
  return {
    feelingOpener: FEELING_OPENER.test(plain.trim()),
    iLike: I_LIKE.test(plain),
    closingQuestion: ending.endsWith('?'),
    capitals: /[A-Z]/.test(words),
    emoji: EMOJI.test(plain),
    tradingWords: TRADING_WORDS.test(plain),
    onBootr: ON_BOOTR.test(plain),
  };
}

/** Whether a post names where its fact comes from: a field of its own, a link, an account, or a named source in words. */
export function namesSource(post: Pick<PostRow, 'text' | 'attributed'>): boolean {
  if (post.attributed) return true;
  if (/https?:\/\//i.test(post.text)) return true;
  const plain = post.text.replace(LINKS, ' ');
  return HANDLE.test(plain) || SOURCE_CUE.test(plain);
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

const share = (n: number, of: number, what: string): string => (of > 0 ? `${Math.round((n / of) * 100)}% (${n} of ${of})` : `no ${what}`);
const usdc = (micro: number): string => (micro / 1_000_000).toFixed(micro > 0 && micro < 10_000 ? 4 : 2);

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function duration(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** The posts of the agent that went out: completed, not waiting in the review queue. */
const wentOut = (p: PostRow): boolean => p.status === 'completed' && !p.queued;

/** A fingerprint without its subject word: the number and its unit (`holders:1.1e2` -> `1.1e2`, `fee:4.8e-2$` -> `4.8e-2$`). */
const numberOf = (fingerprint: string): string => fingerprint.slice(fingerprint.indexOf(':') + 1);

/**
 * M1. For each original of the window, whether it carries a fact fingerprint that an earlier original of the same
 * agent carried in the `REPEAT_LOOKBACK_MS` before it. `repeatsByNumber` is the same count with the subject word left
 * out of the comparison: the subject is the list word nearest the number, so one fact said in two sentences can come
 * out under two subjects ("$0.05 WETH" stood under five in one agent's week), and the gap between the two counts says
 * how often that happens.
 */
export function repeatRate(posts: readonly PostRow[], from: number, to: number): { originals: number; repeats: number; repeatsByNumber: number } {
  const originals = posts.filter((p) => p.kind === 'post' && wentOut(p)).sort((a, b) => a.at - b.at);
  const prints = originals.map((p) => new Set(factFingerprints(p.text)));
  const numbers = prints.map((set) => new Set([...set].map(numberOf)));
  let repeats = 0;
  let repeatsByNumber = 0;
  let count = 0;
  originals.forEach((post, i) => {
    if (post.at < from || post.at >= to) return;
    count += 1;
    let whole = false;
    let byNumber = false;
    for (let j = 0; j < i && !(whole && byNumber); j++) {
      if (originals[j]!.at < post.at - REPEAT_LOOKBACK_MS) continue;
      if (!whole && [...prints[i]!].some((f) => prints[j]!.has(f))) whole = true;
      if (!byNumber && [...numbers[i]!].some((n) => numbers[j]!.has(n))) byNumber = true;
    }
    if (whole) repeats += 1;
    if (byNumber) repeatsByNumber += 1;
  });
  return { originals: count, repeats, repeatsByNumber };
}

/** Any figure as written, with its `$` or `%`: dates, clock times and "24h" included. Section 2.2 of the design note counted these. */
const WRITTEN_NUMBER = /\$?\d[\d,]*(?:\.\d+)?%?/g;

/**
 * The two figures of the design note's section 2.2 that M1 and M2 replaced, counted the way that table counted them
 * (any figure as written, not a fact fingerprint): originals carrying a number that three or more originals of the
 * window carry, and, of the originals with a number, those that name a source. They are here so a run can be held
 * against that table; they are not the measures.
 */
export function asSection22(originals: readonly PostRow[]): { withNumber: number; numberInThree: number; sourced: number } {
  const sets = originals.map((p) => new Set((p.text.replace(LINKS, ' ').match(WRITTEN_NUMBER) ?? []).map((m) => m.toLowerCase())));
  const carriedBy = new Map<string, number>();
  for (const set of sets) for (const n of set) carriedBy.set(n, (carriedBy.get(n) ?? 0) + 1);
  return {
    withNumber: sets.filter((set) => set.size > 0).length,
    numberInThree: sets.filter((set) => [...set].some((n) => (carriedBy.get(n) ?? 0) >= 3)).length,
    sourced: originals.filter((p, i) => sets[i]!.size > 0 && namesSource(p)).length,
  };
}

/** M8. Originals of the window whose first three words (as `openerOf` reads them) open another original of the window. */
export function sameOpener(originals: readonly PostRow[]): number {
  const counts = new Map<string, number>();
  const openers = originals.map((p) => openerOf(p.text));
  for (const o of openers) if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  return openers.filter((o) => o && (counts.get(o) ?? 0) > 1).length;
}

/**
 * M5 without `sv_turns`: the steps of the window cut into turns at each `finish` (steps of a treasury or judge turn left
 * out), and how many of those turns hold no completed publish. A turn the runtime ended without a `finish` runs into
 * the next one, so this is an estimate: fewer turns than there were, and so a lower share than the truth.
 */
export function turnsFromSteps(steps: readonly StepRow[]): { turns: number; withoutPost: number } {
  let turns = 0;
  let withoutPost = 0;
  let open = false;
  let published = false;
  for (const step of [...steps].filter((s) => !s.role).sort((a, b) => a.at - b.at)) {
    open = true;
    if ((step.tool === 'publish_post' || step.tool === 'publish_reply') && step.status === 'completed') published = true;
    if (step.tool === 'finish' && step.status === 'completed') {
      turns += 1;
      if (!published) withoutPost += 1;
      open = false;
      published = false;
    }
  }
  if (open) {
    turns += 1;
    if (!published) withoutPost += 1;
  }
  return { turns, withoutPost };
}

function topCodes(rows: readonly { code: string; n: number }[], max = 6): string {
  const merged = new Map<string, number>();
  for (const r of rows) merged.set(r.code, (merged.get(r.code) ?? 0) + r.n);
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, max).map(([code, n]) => `${code || '(no code)'} ${n}`);
  return shown.join(', ') + (sorted.length > max ? `, and ${sorted.length - max} more` : '');
}

/** The table's lines, M1 to M10 in order, then the context lines. */
export function measure(input: CheckInput): Line[] {
  const { from, to } = input;
  const database = input.mode === 'database';
  const inWindow = (p: PostRow) => p.at >= from && p.at < to;
  const windowPosts = input.posts.filter(inWindow);
  const originals = windowPosts.filter((p) => p.kind === 'post' && wentOut(p));
  const replies = windowPosts.filter((p) => p.kind === 'reply' && wentOut(p));
  const lines: Line[] = [];

  // M1
  const repeat = repeatRate(input.posts, from, to);
  lines.push({
    id: 'M1',
    measure: 'Repeat rate',
    value: share(repeat.repeats, repeat.originals, 'originals'),
    detail: `originals carrying a fact fingerprint (number, unit, subject word) that an earlier original of the 7 days before it carried; with the subject word left out of the comparison: ${share(repeat.repeatsByNumber, repeat.originals, 'originals')}`,
  });

  // M2
  const withNumber = originals.filter((p) => factFingerprints(p.text).length > 0);
  lines.push({
    id: 'M2',
    measure: 'Claims with a source',
    value: share(withNumber.filter(namesSource).length, withNumber.length, 'originals with a number'),
    detail: `originals stating a number that name where it comes from (${database ? 'an attribution, a record, ' : ''}a link, an @, "per" or "says"); code only, the weekly audit by a model is not run here`,
  });

  // M3
  if (database) {
    const attempts = windowPosts.filter((p) => p.status === 'completed' || p.status === 'failed');
    const refused = attempts.filter((p) => p.status === 'failed');
    const codes = topCodes(refused.map((p) => ({ code: errorCode(p.error), n: 1 })));
    const sender = input.senderRejected?.length ? `; the sender's own refusals: ${topCodes(input.senderRejected.map((r) => ({ code: errorCode(r.error), n: r.n })))}` : '';
    lines.push({
      id: 'M3',
      measure: 'Posts refused by the gate',
      value: attempts.length ? `${((refused.length / attempts.length) * 100).toFixed(1)} per 100 attempts (${refused.length} of ${attempts.length})` : 'no publish attempts',
      detail: `${codes ? `by code: ${codes}` : 'no refusal'}${sender}`,
    });
  } else lines.push({ id: 'M3', measure: 'Posts refused by the gate', value: NEEDS_DATABASE, detail: 'refused publishes are in sv_actions and sender_actions only' });

  // M4
  if (input.approvals) {
    const byCreator = input.approvals.filter((a) => a.decidedBy !== 'system' && (a.status === 'approved' || a.status === 'rejected'));
    const rejected = byCreator.filter((a) => a.status === 'rejected');
    const expired = input.approvals.filter((a) => a.decidedBy === 'system').length;
    const notes = rejected.map((a) => (a.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 5);
    lines.push({
      id: 'M4',
      measure: 'Creator rejections',
      value: byCreator.length ? `${share(rejected.length, byCreator.length, 'decisions')}` : 'no decisions (review off, or nothing decided)',
      detail: `rejected of decided; an edit is not stored, so this stands in for "creator edits"${expired ? `; ${expired} expired unseen` : ''}${notes.length ? `; notes: ${notes.map((n) => `"${n}"`).join(' / ')}` : ''}`,
    });
  } else lines.push({ id: 'M4', measure: 'Creator rejections', value: NEEDS_DATABASE, detail: 'the review queue (sv_approvals) is private' });

  // M5
  const social = input.turns?.filter((t) => t.role === 'social') ?? [];
  if (database && social.length) {
    const silent = social.filter((t) => t.posted + t.replied === 0).length;
    lines.push({ id: 'M5', measure: 'Social turns without a post', value: share(silent, social.length, 'social turns'), detail: `exact, from sv_turns; ${social.filter((t) => t.outcome !== 'finished').length} of them ended without a finish` });
  } else if (database && input.steps) {
    const est = turnsFromSteps(input.steps);
    lines.push({
      id: 'M5',
      measure: 'Social turns without a post',
      value: `${share(est.withoutPost, est.turns, 'social turns')}, estimated`,
      detail: `${input.turns === null ? 'sv_turns is not there yet' : 'sv_turns has no row for this window'}: steps cut at each finish, which misses turns the runtime ended`,
    });
  } else lines.push({ id: 'M5', measure: 'Social turns without a post', value: NEEDS_DATABASE, detail: 'a turn that posts nothing leaves nothing public' });

  // M6
  if (input.fuel) {
    const { thoughts, chargedMicroUsdc } = input.fuel;
    const per = (n: number) => (n > 0 ? `${usdc(chargedMicroUsdc / n)} USDC` : 'n/a');
    lines.push({
      id: 'M6',
      measure: 'Fuel per published post',
      value: `${per(originals.length)} per original`,
      detail: `${usdc(chargedMicroUsdc)} USDC for ${thoughts} thoughts${input.fuel.label ? ` (${input.fuel.label})` : ''}; ${originals.length} originals, ${replies.length} replies; ${per(replies.length)} per reply, ${per(originals.length + replies.length)} per publish; ${originals.length ? (thoughts / originals.length).toFixed(1) : 'n/a'} thoughts per original`,
    });
  } else lines.push({ id: 'M6', measure: 'Fuel per published post', value: database ? 'no paid thought in the window' : 'not read', detail: 'the fuel read did not answer' });

  // M7
  if (input.mentions) {
    const eligible = input.mentions.filter((m) => !(m.status === 'skipped' && CLOSED_BY_CODE.includes(m.reason ?? '')));
    const latencies = eligible.filter((m) => m.sentAt !== null && m.sentAt >= m.observedAt).map((m) => m.sentAt! - m.observedAt);
    const median = percentile(latencies, 0.5);
    const p90 = percentile(latencies, 0.9);
    lines.push({
      id: 'M7',
      measure: 'Reply latency',
      value: median === null ? 'no reply to a mention of the window' : `median ${duration(median)}, 90th percentile ${duration(p90!)}`,
      detail: `${share(latencies.filter((l) => l <= ANSWER_IN_TIME_MS).length, eligible.length, 'eligible mentions')} of eligible mentions answered within 15 minutes; ${latencies.length} answered, ${input.mentions.length - eligible.length} closed by code before a turn`,
    });
  } else lines.push({ id: 'M7', measure: 'Reply latency', value: NEEDS_DATABASE, detail: 'when a mention was observed is in the sender\'s inbox only' });

  // M8
  lines.push({ id: 'M8', measure: 'Same opener', value: share(sameOpener(originals), originals.length, 'originals'), detail: 'originals whose first three words open another original of the window; read beside M1, never alone' });

  // M9
  const shapes = originals.map((p) => shapesOf(p.text));
  const count = (key: keyof Shapes) => shapes.filter((s) => s[key]).length;
  const cut = originals.filter((p) => p.cut).length;
  lines.push({
    id: 'M9',
    measure: 'Banned shapes',
    value: `${count('tradingWords')} trading words, ${count('iLike')} "I like", ${count('closingQuestion')} closing questions`,
    detail: `of ${originals.length} originals: feeling opener ${count('feelingOpener')}, "on Bootr" ${count('onBootr')}, emoji ${count('emoji')}${input.agent.platform ? `, capitals ${count('capitals')} (the platform account writes lowercase)` : ''}${cut ? `; ${cut} texts were cut by the embed, so questions and emoji at the end are under-counted` : ''}`,
  });

  // M10
  if (input.shadow) {
    const total = input.shadow.reduce((n, r) => n + r.n, 0);
    const shadowOnly = input.shadow.filter((r) => !r.enforced);
    lines.push({
      id: 'M10',
      measure: 'Would-refuse counts',
      value: total ? `${shadowOnly.reduce((n, r) => n + r.n, 0)} in shadow, ${total - shadowOnly.reduce((n, r) => n + r.n, 0)} enforced` : 'no gate fired',
      detail: total ? `by gate and code: ${topCodes(input.shadow.map((r) => ({ code: `${r.gate}:${r.code}${r.enforced ? '' : ' (shadow)'}`, n: r.n })), 8)}; read 30 by hand before a gate is enforced` : 'sv_gate_shadow has no row for this agent and window',
    });
  } else lines.push({ id: 'M10', measure: 'Would-refuse counts', value: database ? 'needs the table sv_gate_shadow' : NEEDS_DATABASE, detail: database ? 'the table is not there yet (it arrives with the gates in shadow)' : 'shadow refusals are logged in the database only' });

  // Context: what section 2.2 of the design note printed beside the measures, and what stage 1 is judged by.
  const days = new Map<string, number>();
  for (const p of originals) {
    const day = new Date(p.at).toISOString().slice(5, 10);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  lines.push({ id: '-', measure: 'Originals in the window', value: `${originals.length} (and ${replies.length} replies)`, detail: [...days.entries()].sort().map(([d, n]) => `${d}: ${n}`).join(', ') || 'none' });
  const old = asSection22(originals);
  lines.push({
    id: '-',
    measure: 'As section 2.2 counted',
    value: `${share(old.numberInThree, originals.length, 'originals')} carry a number that 3 or more originals carry`,
    detail: `any figure as written, dates and "24h" included, so it can be held against the design note's table and not against M1; ${old.sourced} of the ${old.withNumber} originals with such a number name a source`,
  });
  if (input.notes) {
    const span = Math.max(1, (Math.min(to, input.readAt) - from) / DAY_MS);
    lines.push({ id: '-', measure: 'Notes written', value: `${(input.notes.written / span).toFixed(1)} a day (${input.notes.written})`, detail: `${input.notes.rememberCompleted} remember calls stored, ${input.notes.rememberFailed} refused after they ran (a call refused for its shape before it ran is in the log only)` });
  }
  if (input.observation) lines.push({ id: '-', measure: 'First observation size', value: `median ${input.observation.medianChars} characters, largest ${input.observation.maxChars}`, detail: `over ${input.observation.thoughts} thoughts of the window (the first user message of each request)` });
  if (input.checkpoint) lines.push({ id: '-', measure: 'Checkpoint size now', value: `${input.checkpoint.memory + input.checkpoint.agenda + input.checkpoint.summary} characters`, detail: `memory ${input.checkpoint.memory}, agenda ${input.checkpoint.agenda}, summary ${input.checkpoint.summary}; it comes back in every observation` });
  return lines;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function headline(input: CheckInput): string {
  const who = [input.agent.handle ? `@${input.agent.handle}` : null, `agent ${input.agent.id}`, input.agent.symbol ? `$${input.agent.symbol}` : null, input.agent.platform ? 'the platform account' : null].filter(Boolean).join(', ');
  return `Behaviour check: ${who}; ${day(input.from)} to ${day(input.to)} (UTC, the end day not included); ${input.mode} mode; read ${new Date(input.readAt).toISOString().slice(0, 16)}Z`;
}

/** The whole output: one headline, one table, the caveats. Plain text, and a Markdown table at once. */
export function renderTable(input: CheckInput, lines: readonly Line[] = measure(input)): string {
  const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const rows = lines.map((l) => `| ${l.id} | ${cell(l.measure)} | ${cell(l.value)} | ${cell(l.detail)} |`);
  const caveats = (input.caveats ?? []).map((c) => `- ${c}`);
  return [headline(input), '', '| | Measure | Value | How it was counted |', '|---|---|---|---|', ...rows, ...(caveats.length ? ['', ...caveats] : [])].join('\n');
}
