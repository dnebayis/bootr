/**
 * Three publish gates of docs/design/agent-behaviour.md section 6.3, each with its own setting (`off`, `shadow`,
 * `enforce`; `shadow` unless set otherwise): in shadow a gate writes what it would refuse to `sv_gate_shadow`
 * (gate-shadow.ts) and the post goes out untouched; enforced, the post is refused and the refusal names the rule and
 * what to change, as the question quota does. None of them calls a model, none throws into the publish path, and
 * together they cost two indexed reads of the said-ledger at most (none for a reply), plus one insert for a post a
 * gate finds.
 *
 * G1, repeat (`REPEAT_GATE`, rules R1 and R2), original posts only:
 *   - `repeat_fact`: the post states figures, and none of them is new. A figure is new when the agent's last
 *     `REPEAT_WINDOW_ORIGINALS` original posts never gave one for the same subject and unit, or when the last of them
 *     that did gave another value. The values are compared as written, not by their fingerprint: 112 and 114 holders
 *     round to one fingerprint and are two facts. One new figure is enough for the whole post: a follow-up that adds a
 *     number to one already given, or says a count moved from one value to another, is not a repeat.
 *   - `repeat_opener`: the post opens with the same three words (numbers and handles folded) as one of those posts.
 *   What is NOT a repeat, on purpose: a reply (answering somebody with a figure the agent already posted is what a
 *   reply is for, and a figure given in a reply does not use it up for a later post); the platform account's daily
 *   numbers post and its weekly digest (the same subjects every day is what they are); a figure with no subject the
 *   fingerprint knows; the posts of one thread against each other.
 *
 * G4, cross-agent (`CROSS_AGENT_GATE`, rule R3, the part that needs no records): an original post at least
 * `CROSS_AGENT_OVERLAP_PCT` of whose own words are those of an original post ANOTHER Bootr agent made in the last
 * `CROSS_AGENT_WINDOW_MS`. X's developer policy forbids substantially similar content across accounts, and every
 * Bootr agent posts through one X app. What is NOT compared, on purpose:
 *   - a reply, on either side. A reply answers a person, and two coins asked the same thing ("what is your split?")
 *     answer with the same facts; a rule that let the first answer block the second would punish the honest one;
 *   - the words code hands every coin agent, and every figure (handed-words.ts `ownWords`): the fee split line, the
 *     brief of the coin's day, the dates and amounts written out, the names of its labels. They are Bootr's words, the
 *     same on every coin with the same facts, so they say nothing about who copied whom, and whoever posted them
 *     first would otherwise make every other coin's plain statement of its own facts "similar";
 *   - a short post: under `SIMILAR_MIN_WORDS` words of its own, where two posts agree by chance;
 *   - the very post a comment is about (taking up somebody's words to answer them is not copying them).
 * The window is a time. One read brings at most `SAID_OTHERS_MAX_ROWS` posts of it (said.ts): past that the oldest
 * are not compared, which can only let a copy through, and a warning says so.
 *
 * G6, units (`UNITS_GATE`, rule R12): a currency sign on an amount of a token ("$0.0475 WETH"). Every agent, posts
 * and replies. Left alone: a dollar amount of a dollar stablecoin ("$5 USDC" says five dollars), a dollar figure
 * about a token ("$500 ETH volume"), and a figure of a thousand or more or with a k / m / b on it, which next to ETH
 * or BTC is a price or a size in dollars ("$3,400 ETH", "$100k BTC", "$1.2M ETH volume"), not an amount of the token.
 */
import { postFacts, openerOf } from '@bootr/agent-core';
import { storedTurn } from './comment-posts.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { gateMode, logGateHit, type GateId } from './gate-shadow.js';
import { ownWords } from './handed-words.js';
import { lastOriginals, saidByOthers, saidKeepDays, wordOverlap, wordSet, type SaidByOther, type SaidOriginal } from './said.js';

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'log' | 'config'>;

/** What a gate found in one post: the head of the refusal, the refusal the agent reads, and what the shadow row keeps. */
export interface GateProblem {
  code: string;
  message: string;
  /** The text the problem is in: the part of a thread, or the post. */
  text: string;
  detail: Record<string, unknown>;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const nothing = (done: 'posted' | 'scheduled'): string => `Nothing was ${done}.`;

// ---------------------------------------------------------------------------
// G6: units
// ---------------------------------------------------------------------------

/** Tokens whose amounts are not money amounts. Dollar stablecoins are left out: "$5 USDC" says five dollars. */
const TOKEN = '(?:weth|eth|cbeth|steth|wsteth|btc|wbtc|cbbtc)';
/** A dollar figure about a token, not an amount of it: "$500 ETH volume". */
const ABOUT_TOKEN = '(?!\\s+(?:price|prices|volume|liquidity|market|markets|pair|pairs|options|futures|etf|etfs)\\b)';
const SIGN_ON_TOKEN = new RegExp(`([$€£¥])\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s?\\$?(${TOKEN})\\b${ABOUT_TOKEN}`, 'gi');
/** From here up a figure beside ETH or BTC reads as a price or a dollar size, not as an amount of the token. */
const TOKEN_AMOUNT_BELOW = 1000;

/** The first currency sign on a token amount in `text`, or null. Pure. */
export function unitProblem(text: string, done: 'posted' | 'scheduled' = 'posted'): GateProblem | null {
  if (typeof text !== 'string' || !text) return null;
  const m = [...text.replace(/https?:\/\/\S+/g, ' ').matchAll(SIGN_ON_TOKEN)].find((found) => Number(found[2]!.replace(/,/g, '')) < TOKEN_AMOUNT_BELOW);
  if (!m) return null;
  const found = m[0].trim();
  const amount = m[2]!;
  const token = m[3]!.toUpperCase();
  return {
    code: 'unit_on_token_amount',
    message: `unit_on_token_amount: "${found}" puts a currency sign on an amount of ${token}. Write the amount of ${token} without the sign ("${amount} ${token}"), or give a dollar value as dollars; never both on one number. ${nothing(done)}`,
    text,
    detail: { found, token },
  };
}

// ---------------------------------------------------------------------------
// G1: repeat
// ---------------------------------------------------------------------------

/** A figure as the refusal names it: "112 (holders)", "$0.0475 (fee)", "58.5% (trades)", "0.05 WETH (fee)". */
function figure(fact: { s: string; u: string; v: number }): string {
  const n = String(fact.v);
  const written = fact.u === '$' ? `$${n}` : fact.u === '%' ? `${n}%` : fact.u ? `${n} ${fact.u.toUpperCase()}` : n;
  return `${written} (${fact.s})`;
}

const sameValue = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** An opener says something about the phrasing only when it has its three words. */
const fullOpener = (opener: string): boolean => opener.split(' ').filter(Boolean).length >= 3;

/**
 * Whether an original post (`parts`: its text, or every post of a thread) repeats what the agent's last original
 * posts said (`history`, newest first, as `lastOriginals` returns them). Pure. See the head of this file for the rule.
 */
export function repeatProblem(parts: readonly string[], history: readonly SaidOriginal[], done: 'posted' | 'scheduled' = 'posted'): GateProblem | null {
  if (!parts.length || !history.length) return null;
  // What the post states, by subject and unit; a figure without a subject is not compared.
  const stated = new Map<string, { s: string; u: string; values: number[] }>();
  for (const part of parts) {
    for (const fact of postFacts(part)) {
      if (fact.subject === 'none') continue;
      const key = `${fact.subject}|${fact.unit}`;
      const group = stated.get(key) ?? { s: fact.subject, u: fact.unit, values: [] };
      if (!group.values.some((v) => sameValue(v, fact.value))) group.values.push(fact.value);
      stated.set(key, group);
    }
  }
  if (stated.size > 0) {
    const repeated: { fact: { s: string; u: string; v: number }; at: number; postId: string | null }[] = [];
    let anythingNew = false;
    for (const group of stated.values()) {
      // The last original that gave a figure for this subject and unit: what the agent last told its readers about it.
      const last = history.find((o) => o.facts.some((f) => f.s === group.s && f.u === group.u));
      const before = last ? last.facts.filter((f) => f.s === group.s && f.u === group.u).map((f) => f.v) : [];
      if (!last || group.values.some((v) => !before.some((b) => sameValue(b, v)))) {
        anythingNew = true;
        break;
      }
      for (const v of group.values) repeated.push({ fact: { s: group.s, u: group.u, v }, at: last.postedAt, postId: last.postId });
    }
    if (!anythingNew && repeated.length) {
      const named = repeated.slice(0, 4).map((r) => `${figure(r.fact)} on ${day(r.at)}`);
      return {
        code: 'repeat_fact',
        message: `repeat_fact: every figure in this post is one you already posted, and none has changed since: ${named.join(', ')}${repeated.length > named.length ? ', and more' : ''}. A fact is said once. Post a figure again only when it changed, and leave the ones you already gave out of a post about something else. ${nothing(done)}`,
        text: parts.join('\n'),
        detail: { repeated: repeated.slice(0, 8).map((r) => ({ figure: figure(r.fact), saidAt: new Date(r.at).toISOString(), postId: r.postId })) },
      };
    }
  }
  const opener = openerOf(parts[0] ?? '');
  if (fullOpener(opener)) {
    const same = history.find((o) => o.opener === opener);
    if (same) {
      return {
        code: 'repeat_opener',
        message: `repeat_opener: this post opens with the same three words as your post of ${day(same.postedAt)} ("${opener}"; a number reads as #, a handle as @). Open it differently: lead with what is new in it. ${nothing(done)}`,
        text: parts[0]!,
        detail: { opener, saidAt: new Date(same.postedAt).toISOString(), postId: same.postId },
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// G4: cross-agent
// ---------------------------------------------------------------------------

/** Words of its own (`ownWords`) a post needs before it is compared: under this two posts agree by chance. */
export const SIMILAR_MIN_WORDS = 6;

/**
 * Whether one of `parts` is in substantially the words of a post of another agent (`others`, the posts `saidByOthers`
 * returns). Both sides are read without the words code hands every agent and without figures. `exceptPostIds`: the
 * post a comment is about. Pure.
 */
export function similarProblem(parts: readonly string[], others: readonly SaidByOther[], minPct: number, opts: { exceptPostIds?: readonly (string | null | undefined)[]; done?: 'posted' | 'scheduled' } = {}): GateProblem | null {
  const except = new Set((opts.exceptPostIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0));
  let best: { part: string; other: SaidByOther; overlap: number } | null = null;
  const theirs = others.filter((other) => !(other.postId && except.has(other.postId))).map((other) => ({ other, words: ownWords(other.words) })).filter((o) => o.words.length >= SIMILAR_MIN_WORDS);
  for (const part of parts) {
    const words = ownWords(wordSet(part));
    if (words.length < SIMILAR_MIN_WORDS) continue;
    for (const { other, words: otherWords } of theirs) {
      const overlap = wordOverlap(words, otherWords);
      if (overlap * 100 >= minPct && (!best || overlap > best.overlap)) best = { part, other, overlap };
    }
  }
  if (!best) return null;
  const pct = Math.round(best.overlap * 100);
  return {
    code: 'similar_post',
    message: `similar_post: ${pct}% of the words of this post are the words of a post another Bootr agent made on ${day(best.other.postedAt)} (figures and the standard lines about a coin's fees and day are not counted). X does not allow substantially similar posts across accounts. Say it in your own words and about your own subject, or leave it out. ${nothing(opts.done ?? 'posted')}`,
    text: best.part,
    detail: { otherAgentId: best.other.agentId, otherPostId: best.other.postId, otherPostedAt: new Date(best.other.postedAt).toISOString(), overlapPct: pct },
  };
}

// ---------------------------------------------------------------------------
// The call every publish path makes
// ---------------------------------------------------------------------------

export interface GatedPost {
  /** The `sv_actions` row of the publish being decided; for a scheduled post at its send, the id of the scheduled row. */
  actionId: string;
  /** The texts that go to X: one for a post or a reply, every post of a thread. */
  parts: readonly string[];
  kind: 'original' | 'reply';
  /** The post a comment is about (for a reply, the post it answers): not "another agent's post" to the cross-agent gate. */
  aboutPostId?: string | null;
  /**
   * An original a turn sends or queues now (the broker's `publish_post`, the review queue): the platform account's
   * turn may carry its numbers post or its digest, which the repeat gate leaves alone. Absent for a scheduled post.
   */
  ofTurn?: boolean;
  done?: 'posted' | 'scheduled';
}

/**
 * The refusal of the first ENFORCED gate that finds something in the post, or null. A gate in shadow writes its row
 * and the next one is asked; a gate that fails (a read that does not answer) is a warning and refuses nothing.
 */
export async function postGateRefusal(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'config'>, post: GatedPost): Promise<string | null> {
  const done = post.done ?? 'posted';
  const hit = async (gate: GateId, problem: GateProblem): Promise<string | null> => {
    const enforced = gateMode(ctx, gate) === 'enforce';
    await logGateHit(ctx, { agentId: agent.agentId, gate, code: problem.code, actionId: post.actionId, text: problem.text, detail: { ...problem.detail, kind: post.kind, ...(post.parts.length > 1 ? { parts: post.parts.length } : {}), ...(done === 'scheduled' ? { scheduled: true } : {}) }, enforced });
    ctx.log.info({ agentId: agent.agentId, gate, code: problem.code, actionId: post.actionId, enforced }, enforced ? 'publish gate: refused' : 'publish gate: would refuse (shadow)');
    return enforced ? problem.message : null;
  };
  const guarded = async (gate: GateId, check: () => Promise<GateProblem | null> | GateProblem | null): Promise<string | null> => {
    if (gateMode(ctx, gate) === 'off') return null;
    try {
      const problem = await check();
      return problem ? await hit(gate, problem) : null;
    } catch (err) {
      ctx.log.warn({ agentId: agent.agentId, gate, err: err instanceof Error ? err.message : String(err) }, 'publish gate skipped: its check failed');
      return null;
    }
  };

  // G6 first: it reads nothing.
  const units = await guarded('G6', () => {
    for (const part of post.parts) {
      const problem = unitProblem(part, done);
      if (problem) return problem;
    }
    return null;
  });
  if (units) return units;

  const ledger = saidKeepDays(ctx) > 0;
  const repeat = await guarded('G1', async () => {
    if (!ledger || post.kind !== 'original') return null;
    // A post with no figure and no three-word opener has nothing to compare: no read.
    const figures = post.parts.some((part) => postFacts(part).some((f) => f.subject !== 'none'));
    if (!figures && !fullOpener(openerOf(post.parts[0] ?? ''))) return null;
    const problem = repeatProblem(post.parts, await lastOriginals(ctx, agent.agentId, ctx.config.REPEAT_WINDOW_ORIGINALS, post.actionId), done);
    // The platform account's numbers post and digest say the same subjects every time: that is what they are. The
    // turn is read only for a post that would otherwise be found, so a post that passes costs the one read above.
    if (problem && post.ofTurn && agent.config.platform === true) {
      const turn = await storedTurn(ctx, agent.agentId);
      if (turn?.numbersDay || turn?.digestWeek) return null;
    }
    return problem;
  });
  if (repeat) return repeat;

  return guarded('G4', async () => {
    const window = ctx.config.CROSS_AGENT_WINDOW_MS;
    // Replies are not compared (the head of this file says why), and a post with too few words of its own costs no read.
    if (!ledger || post.kind !== 'original' || !(window > 0) || !post.parts.some((part) => ownWords(wordSet(part)).length >= SIMILAR_MIN_WORDS)) return null;
    const others = await saidByOthers(ctx, agent.agentId, ctx.now() - window);
    if (others.truncated) ctx.log.warn({ agentId: agent.agentId, compared: others.posts.length }, 'cross-agent gate: more posts in its window than one check reads; the oldest were not compared');
    return similarProblem(post.parts, others.posts, ctx.config.CROSS_AGENT_OVERLAP_PCT, { exceptPostIds: [post.aboutPostId], done });
  });
}
