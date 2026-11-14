/**
 * False statements about where a coin's fees go are refused before they reach X (owner's decision of 2026-11-15, after
 * a coin agent posted for days that 58.5% of every trade went to holders; docs/design/agent-behaviour.md section 2.3
 * and gate G3). Price talk is NOT refused here or anywhere for a coin agent: that was the same decision.
 *
 * Deterministic, per sentence, and narrow on purpose (a refusal costs the agent a thought):
 *  - `holders`: fee money said to go to holders, on a coin whose split has no holder dividends;
 *  - `of_trade`: "N% of each trade" going somewhere, with N above what a trade pays at all on this coin (the shares are
 *    shares of the fee, not of the trade);
 *  - `share`: "N% to the creator / agent / burn / platform" where N is neither that recipient's share of the fee nor
 *    its share of a trade.
 * A sentence that denies ("holders get nothing"), or asks, is left alone. The split is the coin's own (`coinFeeSplit`,
 * or a v5 coin's stored settings); with no split known nothing is refused. It holds for hosted and own agents of a
 * coin. The platform account is left out: it talks about many coins, each with its own split.
 * `FEE_CLAIM_GATE`: `enforce` (default), `shadow` (log only), `off`.
 */
import { clankerV5SplitFromSettings, coinFeeSplit, feeSplitLine, type CoinFeeSplit, type FeeRecipient } from './coin-fees.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { clankerV5CoinOf } from './launch-source.js';

export type FeeClaimKind = 'holders' | 'of_trade' | 'share';
export interface FeeClaimProblem {
  kind: FeeClaimKind;
  /** The sentence that makes the claim, for the log. */
  sentence: string;
  /** What the agent reads. */
  message: string;
}

const NEGATION = /\b(?:no|not|never|none|nothing|nobody|zero|without|isn't|aren't|don't|doesn't|won't|cannot|can't)\b|\b0\s*%/i;
const MONEY = '(?:fees?|revenue|rewards?|yield|dividends?|proceeds|earnings|income|payouts?|weth|eth|usdc)';
const HOLDERS = '(?:holders?|co-?owners?|hodlers?|stakers?|bagholders?)';
const HOLDER_CLAIMS: readonly RegExp[] = [
  new RegExp(`\\b${HOLDERS}\\b[^.!?\\n]{0,60}\\b(?:earn|earns|earning|earned|collect|collects|collecting|collected|receive|receives|receiving|received|get paid|gets paid|are paid|is paid|share in|pocket|pockets)\\b[^.!?\\n]{0,50}\\b${MONEY}\\b`, 'i'),
  new RegExp(`\\b${MONEY}\\b[^.!?\\n]{0,60}\\b(?:to|for|into|among|between|back to)\\s+(?:the\\s+|its\\s+|our\\s+|all\\s+)?(?:${HOLDERS}|holder pool)\\b`, 'i'),
  new RegExp(`\\bholder[- ](?:pool|rewards?|dividends?|yield|payouts?|revenue)\\b`, 'i'),
  new RegExp(`\\b(?:trade|trades|swap|swaps|volume)\\b[^.!?\\n]{0,60}\\b(?:into|to)\\s+(?:the\\s+)?holder pool\\b`, 'i'),
  new RegExp(`\\b(?:equity|income|payouts?)\\b[^.!?\\n]{0,30}\\bfor\\s+(?:the\\s+)?${HOLDERS}\\b`, 'i'),
];
const OF_TRADE = /(\d+(?:\.\d+)?)\s*%\s+of\s+(?:their|the|a|an|each|every|any|your|all)\s+(?:trades?|swaps?|buys?|sells?|purchases?|volume)\b/gi;
const FLOW = /\b(?:fees?|creator|agent|burn|burned|platform|holders?|pool|goes|go|sends?|sent|pays?|paid|routes?|flows?)\b/i;
const RECIPIENT_WORDS: Record<string, FeeRecipient> = { creator: 'creator', agent: 'agent', burn: 'burn', burning: 'burn', burned: 'burn', platform: 'platform', bootr: 'platform' };
const WORDS = Object.keys(RECIPIENT_WORDS).join('|');
/** "58.5% goes to the creator", "15% to burn", "5% for the agent". */
const SHARE_TO = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%\\s+(?:of\\s+(?:the|that|each|every)\\s+fees?\\s+)?(?:goes|go|going|is sent|are sent|sent|is paid|paid|flows?|routed)?\\s*(?:straight\\s+|directly\\s+|back\\s+)?(?:to|for|into)\\s+(?:the\\s+|its\\s+|a\\s+)?(${WORDS})\\b`, 'gi');
/** "the creator gets 58.5%", "burn: 15%", "agent takes 5%". */
const SHARE_OF = new RegExp(`\\b(${WORDS})\\s*(?::|gets|get|takes|take|receives|receive|earns|earn|keeps|keep|is|share is|share of)\\s+(?:about\\s+|around\\s+|roughly\\s+)?(\\d+(?:\\.\\d+)?)\\s*%`, 'gi');

const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const near = (said: number, real: number, floor: number): boolean => Math.abs(said - real) <= Math.max(floor, real * 0.06);

/** Whether `said` is one of the true figures for `recipient`: its share of what reaches the recipients, of the whole fee, or of a buy or a sell. */
function trueShare(split: CoinFeeSplit, recipient: FeeRecipient, said: number): boolean {
  const ofFee = split.recipientsPct[recipient];
  if (typeof ofFee === 'number' && near(said, ofFee, 1)) return true;
  for (const [of, whole] of [[split.ofEachTradePct[recipient], split.traderPaysPct], [split.ofEachSellPct?.[recipient], split.sellTaxPct]] as const) {
    if (typeof of !== 'number') continue;
    if (near(said, of, 0.05)) return true;
    // ...or its share of everything the trader pays, the launcher's part included ("58.5% of the fee" on a coin whose
    // recipients share 90% of it).
    if (typeof whole === 'number' && whole > 0 && near(said, (of / whole) * 100, 1)) return true;
  }
  return false;
}

/** The first false fee claim in `text` against this coin's `split`, or null. Pure. */
export function feeClaimProblem(text: string, split: CoinFeeSplit | null): FeeClaimProblem | null {
  if (!split || typeof text !== 'string' || !text) return null;
  const line = feeSplitLine(split);
  const end = 'Say the split as it is or leave it out. Nothing was posted.';
  const payHolders = (split.recipientsPct.holderDividends ?? 0) > 0;
  // What a trade pays at most on this coin: the buy side, or the sell tax where it is higher.
  const tradePays = Math.max(split.traderPaysPct, split.sellTaxPct ?? 0);
  for (const sentence of sentences(text)) {
    if (sentence.endsWith('?') || NEGATION.test(sentence)) continue;
    if (!payHolders && HOLDER_CLAIMS.some((re) => re.test(sentence)))
      return { kind: 'holders', sentence, message: `fee_claim_false: holders receive no share of this coin's fees. ${line} ${end}` };
    if (FLOW.test(sentence)) {
      for (const m of sentence.matchAll(OF_TRADE)) {
        const said = Number(m[1]);
        if (said > tradePays + Math.max(0.05, tradePays * 0.06))
          return { kind: 'of_trade', sentence, message: `fee_claim_false: a trade on this coin pays ${tradePays}%, not ${said}%: the shares are shares of that fee, not of the trade. ${line} ${end}` };
      }
    }
    const shares: [FeeRecipient, number, string][] = [];
    for (const m of sentence.matchAll(SHARE_TO)) shares.push([RECIPIENT_WORDS[m[2]!.toLowerCase()]!, Number(m[1]), m[2]!.toLowerCase()]);
    for (const m of sentence.matchAll(SHARE_OF)) shares.push([RECIPIENT_WORDS[m[1]!.toLowerCase()]!, Number(m[2]), m[1]!.toLowerCase()]);
    for (const [recipient, said, word] of shares)
      if (!trueShare(split, recipient, said)) return { kind: 'share', sentence, message: `fee_claim_false: ${said}% is not the ${word === 'bootr' ? 'platform' : word}'s share on this coin. ${line} ${end}` };
  }
  return null;
}

type Ctx = Pick<SupervisorContext, 'config' | 'indexer' | 'log' | 'chain'>;

/**
 * The refusal for a post, a reply or the parts of a thread of a coin's agent, or null. One indexer read when a part
 * mentions a percentage or holders at all; a read that fails refuses nothing (the gate cannot show the claim is false).
 */
export async function feeClaimRefusal(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'token' | 'config' | 'source'>, parts: readonly string[]): Promise<string | null> {
  const mode = ctx.config.FEE_CLAIM_GATE ?? 'enforce';
  if (mode === 'off' || (agent.config as Record<string, unknown>).platform === true) return null;
  if (!parts.some((part) => /%|holder|co-?owner/i.test(part))) return null;
  let split: CoinFeeSplit | null = null;
  try {
    const own = clankerV5CoinOf(ctx, agent);
    split = own?.details?.settings ? clankerV5SplitFromSettings(own.details.settings, own.pairedAsset) : coinFeeSplit(await ctx.indexer.market(agent.token));
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err }, 'fee claim check skipped: the split could not be read');
    return null;
  }
  for (const part of parts) {
    const problem = feeClaimProblem(part, split);
    if (!problem) continue;
    ctx.log.info({ agentId: agent.agentId, kind: problem.kind, sentence: problem.sentence.slice(0, 200), enforced: mode === 'enforce' }, 'false fee claim');
    return mode === 'enforce' ? problem.message : null;
  }
  return null;
}
