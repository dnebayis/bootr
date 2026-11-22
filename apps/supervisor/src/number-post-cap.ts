/**
 * G7, the cap on a coin's own numbers posts (`NUMBER_POST_GATE`: `enforce` unless set otherwise, `shadow`, `off`):
 * at most `COIN_NUMBER_POSTS_PER_DAY` (1) original posts per rolling 24 hours state the coin's own market figures.
 *
 * Why it exists beside the repeat gate (G1). G1 refuses a post whose every figure was already said, and compares the
 * values as written: 117 holders and 119 holders are two facts. A coin's holder count moves by one or two between
 * slots, so every post of the same shape has a "new" figure and passes. One coin posted "Day 16: 119 holders now, 75
 * trades, $9.7k volume" in one wording or another about every 70 minutes for days (seen on 2026-11-22). The fault is
 * not that a figure is repeated, it is that the coin says nothing else, so this gate counts the posts instead of
 * comparing the figures.
 *
 * What a numbers post is. No new parser: the figures are the ones the fingerprint reads (agent-core `postFacts`, as
 * the said-ledger, G1 and G5 do), and a figure is a market figure when its subject is one of `MARKET_SUBJECTS`:
 * holders, trades (also swaps, buys, sells), volume (also "traded"), price (also market cap, floor, liquidity) and fee
 * (also tax). Not the coin's day count ("Day 16" is a label, and `postFacts` reads none), not its treasury, supply,
 * burn or fee split: those are what the coin is, said once under G1, not the daily tape.
 *
 *   - An EARLIER numbers post: an original (a thread is one) of the last 24 hours on the said-ledger with at least
 *     one market figure. The ledger keeps a post's figures, not which coin they were about, so this side is read by
 *     the subject alone. It can count a post that gave somebody else's figure ("Coinbase cut its fee to 0.1%") as the
 *     day's numbers post; the cost of that is one numbers post fewer, which is the direction this gate is for.
 *   - THIS post: it states at least one market figure that is the coin's own. "Its own" is asked of the data, because
 *     the subject cannot tell: a post about what a watched account said may well carry a fee or a volume, and those
 *     are exactly the posts the cap is meant to make room for. A figure is the coin's own when the coin's own market
 *     data holds it, within rounding (number-gate.ts `inEvidence`): the plain fields of the market snapshot (holders,
 *     24-hour trades, volume and fees, price, market cap; its lists of trades are left out, since among a hundred
 *     trade amounts any small number finds a match by chance), as the turn was shown them and as the index gives them
 *     now, and the brief of the coin's day. When none of that can be read (no stored turn and no answer from the
 *     index), every market figure counts: a cap that a silent index switches off is no cap.
 *
 * What is left alone, on purpose: a reply (answering somebody who asks for the numbers is what a reply is for, and a
 * figure given in a reply does not use the day's post up); the platform account (its daily numbers post and digest
 * are its own, and it has other rules); a post being scheduled (asked when it is sent: the day that counts is the
 * one it goes out in); a post with no market figure; and, with the ledger off (`SAID_KEEP_DAYS` at 0), everything,
 * because nothing can be counted. A post that waits for its creator's review is asked when it is queued and is not
 * on the ledger until it is approved, so a coin in review mode can queue more than one: there the creator is the cap.
 *
 * The same count tells the `coinToday` section that the day's numbers post is made (coin-today.ts), so the model is
 * not handed its figures as something to post and then refused. No model, one indexed read of the ledger for an
 * original with a market figure, and one read of the stored turn and one of the index only for a post that would
 * otherwise be refused.
 */
import { postFacts, type PostFact } from '@bootr/agent-core';
import type { SupervisorContext } from './context.js';
import { gateMode } from './gate-shadow.js';
import { inEvidence, numbersIn, observationOf, type EvidenceNumber, type TurnEvidenceSource } from './number-gate.js';
import { originalsSince, saidKeepDays, type SaidOriginal } from './said.js';

/** The window the posts are counted over. */
export const NUMBER_POST_WINDOW_MS = 24 * 3_600_000;
/** The subjects (agent-core `postFacts`) of a coin's market figures. */
export const MARKET_SUBJECTS: readonly string[] = ['holders', 'trades', 'volume', 'price', 'fee'];

/** Numbers posts a coin may make per rolling 24 hours. A caller that holds only a part of the config (a test) gets 1. */
export function numberPostCap(ctx: { config?: { COIN_NUMBER_POSTS_PER_DAY?: unknown } | null }): number {
  const n = ctx.config?.COIN_NUMBER_POSTS_PER_DAY;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

/** The market figures `parts` state (a post's text, or every post of a thread). Pure. */
export function marketFigures(parts: readonly string[]): PostFact[] {
  return parts.flatMap((part) => postFacts(part)).filter((fact) => MARKET_SUBJECTS.includes(fact.subject));
}

/** Whether an original of the ledger gave a market figure. */
const isNumbersPost = (post: Pick<SaidOriginal, 'facts'>): boolean => post.facts.some((f) => MARKET_SUBJECTS.includes(f.s));

/** A figure as the refusal names it: "119 (holders)", "$9700 (volume)", "2.19% (price)". */
function named(fact: { s: string; u: string; v: number }): string {
  const n = String(fact.v);
  const written = fact.u === '$' ? `$${n}` : fact.u === '%' ? `${n}%` : fact.u ? `${n} ${fact.u.toUpperCase()}` : n;
  return `${written} (${fact.s})`;
}

/** The numbers of an object's own fields, however deep, with every list left out (the head of this file says why). */
function plainFields(value: unknown, out: EvidenceNumber[] = [], depth = 0): EvidenceNumber[] {
  if (depth > 6 || Array.isArray(value)) return out;
  if (value && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>).slice(0, 200)) plainFields(item, out, depth + 1);
  else numbersIn(value, out);
  return out;
}

/**
 * The coin's own market data as numbers: the plain fields of the market snapshot the turn was shown (`observation`)
 * and of the one the index gives now (`market`), and the brief of the coin's day. Empty when neither says anything. Pure.
 */
export function ownMarketFigures(observation: Record<string, unknown> | null | undefined, market: unknown = null): EvidenceNumber[] {
  const out: EvidenceNumber[] = [];
  if (observation && typeof observation === 'object') {
    plainFields(observation.market, out);
    const brief = (observation.coinToday as { digest?: unknown } | null | undefined)?.digest;
    if (typeof brief === 'string') numbersIn(brief, out);
  }
  plainFields(market, out);
  return out;
}

/** What the gate found: the head of the refusal, the refusal the agent reads, and what the shadow row keeps. */
export interface NumberPostFinding {
  code: 'number_post_cap';
  message: string;
  text: string;
  detail: Record<string, unknown>;
}

const SOMETHING_ELSE =
  'Write about something else (what an account you follow said, what your creator set you up to talk about, something you learned) or finish without a post. You may still give the figures in a reply to somebody who asks.';

/**
 * Whether an original post (`parts`) is a numbers post too many. `earlier`: the coin's numbers posts of the window
 * (`numbersPostsSince`), newest first. `own`: the coin's own market data (`ownMarketFigures`), or null or empty when
 * none could be read, and then every market figure counts. Pure.
 */
export function numberPostProblem(parts: readonly string[], earlier: readonly Pick<SaidOriginal, 'facts' | 'postedAt' | 'postId'>[], cap: number, own: readonly EvidenceNumber[] | null, done: 'posted' | 'scheduled' = 'posted'): NumberPostFinding | null {
  if (earlier.length < cap) return null;
  const stated = marketFigures(parts);
  const mine = own && own.length ? stated.filter((fact) => inEvidence(fact, own)) : stated;
  if (!mine.length) return null;
  const these = [...new Set(mine.map((f) => named({ s: f.subject, u: f.unit, v: f.value })))].slice(0, 4);
  const nothing = `Nothing was ${done}.`;
  const last = earlier[0];
  const before = last ? [...new Set(last.facts.filter((f) => MARKET_SUBJECTS.includes(f.s)).map(named))].slice(0, 4) : [];
  const message = last
    ? `number_post_cap: you already posted your coin's numbers in the last 24 hours (${before.join(', ')} on ${new Date(last.postedAt).toISOString().slice(0, 10)}), and this post gives them again (${these.join(', ')}). ` +
      `At most ${cap === 1 ? 'one post' : `${cap} posts`} a day may state your coin's own figures, whether or not they moved. ${SOMETHING_ELSE} ${nothing}`
    : `number_post_cap: this post states your coin's own figures (${these.join(', ')}), and here they are not posted as a post of their own. ${SOMETHING_ELSE} ${nothing}`;
  return { code: 'number_post_cap', message, text: parts.join('\n'), detail: { figures: these, cap, earlier: earlier.slice(0, 4).map((o) => ({ postId: o.postId, saidAt: new Date(o.postedAt).toISOString() })), ownData: !!(own && own.length) } };
}

/** The coin's numbers posts since `since` (epoch ms), newest first: one indexed read of the said-ledger; none with the ledger off. */
export async function numbersPostsSince(ctx: Pick<SupervisorContext, 'db'> & { config?: { SAID_KEEP_DAYS?: unknown } | null }, agentId: string, since: number, exceptActionId?: string | null): Promise<SaidOriginal[]> {
  if (saidKeepDays(ctx) <= 0) return [];
  return (await originalsSince(ctx, agentId, since, exceptActionId)).filter(isNumbersPost);
}

/** The coin's own market data for the gate: what the stored turn was shown and what the index says now. A read that fails gives nothing, never an error. */
export async function ownMarketFiguresNow(ctx: Partial<Pick<SupervisorContext, 'indexer'>>, token: string | null | undefined, turn: TurnEvidenceSource | null | undefined): Promise<EvidenceNumber[]> {
  const market = token && ctx.indexer ? await ctx.indexer.market(token).catch(() => null) : null;
  return ownMarketFigures(observationOf(turn), market);
}

/** What the `coinToday` section is told about the day's numbers post. */
export interface NumbersPostQuota {
  /** Numbers posts of the last 24 hours, and how many a day may be made. */
  made: number;
  perDay: number;
  /** When the oldest of them leaves the window and a numbers post may be made again (ISO); null when the cap is 0. */
  nextAt: string | null;
}

/**
 * Whether the day's numbers posts are used up, for the section that hands the coin its figures: null while one may
 * still be made, while the gate does not refuse (`shadow`, `off`: a gate that changes nothing must not change what
 * the model is told either), with the ledger off, and when the count cannot be read. Never throws.
 */
export async function numbersPostQuota(ctx: Partial<Pick<SupervisorContext, 'db' | 'log'>> & Pick<SupervisorContext, 'now'> & { config?: Record<string, unknown> | null }, agentId: string | null | undefined): Promise<NumbersPostQuota | null> {
  try {
    if (!agentId || !ctx.db || gateMode(ctx, 'G7') !== 'enforce') return null;
    const perDay = numberPostCap(ctx);
    const now = ctx.now();
    const made = await numbersPostsSince({ db: ctx.db, config: ctx.config ?? null }, agentId, now - NUMBER_POST_WINDOW_MS);
    if (made.length < perDay) return null;
    // The post whose leaving the window makes room: the perDay-th newest (newest first).
    const frees = perDay > 0 ? made[perDay - 1] : undefined;
    return { made: made.length, perDay, nextAt: frees ? new Date(frees.postedAt + NUMBER_POST_WINDOW_MS).toISOString() : null };
  } catch (err) {
    ctx.log?.warn({ agentId, err: err instanceof Error ? err.message : String(err) }, 'numbers post quota: the count could not be read; the section says nothing about it');
    return null;
  }
}
