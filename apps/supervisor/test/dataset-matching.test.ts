/**
 * Matching step 3 and the grades (src/dataset/matching.ts, grades.ts): pure functions, held against the pairs that must
 * be one event and the pairs that must not.
 */
import { describe, expect, it } from 'vitest';
import { expiryOf, gradeOf, incidentSourced } from '../src/dataset/grades.js';
import { classifyKind, identifiersOf, kindsCompatible, matchByWords, outOfScope, overlapOf, wordSet, type WordsCandidate } from '../src/dataset/matching.js';
import type { RecordKind, RecordSource } from '../src/dataset/types.js';

const T0 = new Date('2026-11-15T10:00:00Z');
const H = 3_600_000;

/** A record with one title from one source (`from`), and more titles from other desks when `also` names them. */
function candidate(title: string, over: Partial<WordsCandidate> & { from?: string; also?: [string, string][] } = {}): WordsCandidate {
  const { from = 'b:base-blog', also = [], ...rest } = over;
  return { id: 'r_1', kind: 'launch', entities: ['coinbase', 'x402'], sightings: [{ sourceId: from, words: wordSet(title) }, ...also.map(([sourceId, t]) => ({ sourceId, words: wordSet(t) }))], firstSeenAt: T0, lastReinforcedAt: T0, ...rest };
}
const probe = (title: string, over: Partial<Parameters<typeof matchByWords>[0]> = {}) => ({ sourceId: 'b:coindesk', kind: 'launch' as RecordKind, entities: ['coinbase', 'x402'], words: wordSet(title), at: new Date(T0.getTime() + H), ...over });

describe('wordSet', () => {
  it('drops stop words and kind words, folds endings, keeps numbers and versions as words', () => {
    expect(wordSet('Coinbase launches the x402 Bazaar for AI agents')).toEqual(['agent', 'ai', 'bazaar', 'coinbas', 'x402']);
    expect(wordSet('Coinbase launched an x402 Bazaar')).toEqual(['bazaar', 'coinbas', 'x402']);
    expect(wordSet('op-node v1.9.1 released')).toEqual(['op-node', 'v1.9.1']);
    expect(wordSet('Proposal 17: raise the fee')).toEqual(['17', 'fee', 'rais']);
    expect(identifiersOf(wordSet('op-node v1.9.1 and proposal 17'))).toEqual(['17', '1.9.1']);
  });

  it('is bounded', () => {
    expect(wordSet(Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')).length).toBe(40);
    expect(wordSet('x'.repeat(5000))).toEqual([]);
  });
});

describe('matchByWords: the same entities, a compatible kind, 48 hours, half the words', () => {
  it('two desks and the official title of one event are one event', () => {
    const c = candidate('Coinbase launches x402 Bazaar for agents');
    expect(matchByWords(probe("Coinbase's x402 Bazaar goes live, letting AI agents pay for APIs"), [c]).recordId).toBe('r_1');
    expect(matchByWords(probe('x402 Bazaar: Coinbase opens a marketplace for agents'), [c]).recordId).toBe('r_1');
  });

  it('different events about the same name stay apart', () => {
    const pairs: [string, string, RecordKind][] = [
      ['Base launches Base Pay for merchants', 'Base launches Base Build grants for builders', 'launch'],
      ['Arbitrum DAO votes on gaming fund clawback', 'Arbitrum DAO votes on treasury diversification', 'governance'],
      ['OpenAI releases GPT-5.5 for developers', 'OpenAI releases Sora 3 for developers', 'release'],
      ['SEC charges Acme Crypto with fraud', 'SEC charges Beta Exchange with fraud', 'regulation'],
      ['Coinbase reports third quarter earnings', 'Coinbase launches x402 Bazaar for agents', 'launch'],
    ];
    for (const [a, b, kind] of pairs) {
      const c = candidate(a, { kind, entities: ['x'] });
      expect(matchByWords(probe(b, { kind, entities: ['x'] }), [c]).recordId, `${a} / ${b}`).toBeNull();
    }
  });

  it('different identifiers are never one event, however alike the rest', () => {
    const c = candidate('op-node v1.9.1 fixes a derivation bug in the batcher', { kind: 'release', entities: ['optimism'] });
    expect(matchByWords(probe('op-node v1.9.2 fixes a derivation bug in the batcher', { kind: 'release', entities: ['optimism'] }), [c]).recordId).toBeNull();
    expect(matchByWords(probe('op-node 1.9.1 fixes a derivation bug in the batcher', { kind: 'release', entities: ['optimism'] }), [c]).recordId).toBe('r_1');
    const p17 = candidate('Upgrade proposal 17: proposer rotation and fee vault config', { kind: 'governance', entities: ['optimism'] });
    expect(matchByWords(probe('Upgrade proposal 18: proposer rotation and fee vault config', { kind: 'governance', entities: ['optimism'] }), [p17]).recordId).toBeNull();
  });

  it('a source does not publish one event twice: its own items join only when nearly the same', () => {
    const c = candidate('SEC charges Acme Capital founder with misleading investors', { kind: 'regulation', entities: ['sec'], from: 'b:sec' });
    expect(matchByWords(probe('SEC charges Acme Capital adviser with misleading clients', { sourceId: 'b:sec', kind: 'regulation', entities: ['sec'] }), [c]).recordId).toBeNull();
    expect(matchByWords(probe('SEC charges Acme Capital founder with misleading investors (updated)', { sourceId: 'b:sec', kind: 'regulation', entities: ['sec'] }), [c]).recordId).toBe('r_1');
    // a forum's titles share their opening words: the shorter is not swallowed by the longer
    const forum = candidate('Maintenance Upgrade Proposal: Soneium Mainnet Proposer Rotation and Fee Vault Config Update', { kind: 'governance', entities: ['optimism'], from: 'b:optimism-gov' });
    expect(matchByWords(probe('Maintenance Upgrade Proposal: Unichain Fee Vault Config Update', { sourceId: 'b:optimism-gov', kind: 'governance', entities: ['optimism'] }), [forum]).recordId).toBeNull();
  });

  it('a title is held against each title the record has, one at a time, never against them pooled', () => {
    // a short official title, and the desk that reported it at length
    const record = candidate('Introducing ChatGPT Wallet', { entities: ['openai'], from: 'b:openai', also: [['b:techcrunch', 'OpenAI introduces ChatGPT Wallet for purchases made by AI agents']] });
    // a second desk shares little with the two-word title and most of the first desk's
    expect(matchByWords(probe('OpenAI debuts ChatGPT Wallet so AI agents can make purchases', { sourceId: 'b:decrypt', entities: ['openai'] }), [record]).recordId).toBe('r_1');
    // without the first desk there is nothing but two words to go on: undecided, for step 4
    const bare = candidate('Introducing ChatGPT Wallet', { entities: ['openai'], from: 'b:openai' });
    const m = matchByWords(probe('OpenAI debuts ChatGPT Wallet so AI agents can make purchases', { sourceId: 'b:decrypt', entities: ['openai'] }), [bare]);
    expect(m.recordId).toBeNull();
    expect(m.leftover).toEqual([{ recordId: 'r_1', overlap: 1 }]);
    // the record's titles pooled share four words with a different story; no single title shares three
    const busy = candidate('Coinbase launches x402 Bazaar for agents', { also: [['b:decrypt', 'Base marketplace lets AI pay for APIs']] });
    const other = probe('Coinbase earnings: AI agent revenue helps pay down debt', { sourceId: 'b:blockworks' });
    const pooled = [...new Set(busy.sightings.flatMap((s) => s.words))];
    expect(overlapOf(other.words, pooled).shared).toBe(4);
    expect(matchByWords(other, [busy]).recordId).toBeNull();
  });

  it('needs a shared entity, a compatible kind and the window', () => {
    const c = candidate('Coinbase launches x402 Bazaar for agents');
    const title = "Coinbase's x402 Bazaar goes live for agents";
    expect(matchByWords(probe(title, { entities: ['stripe'] }), [c]).recordId).toBeNull();
    expect(matchByWords(probe(title, { entities: [] }), [c]).recordId).toBeNull();
    expect(matchByWords(probe(title, { kind: 'incident' }), [c]).recordId).toBeNull();
    expect(matchByWords(probe(title, { kind: 'statement' }), [c]).recordId).toBe('r_1');
    expect(matchByWords(probe(title, { at: new Date(T0.getTime() + 49 * H) }), [c]).recordId).toBeNull();
    expect(matchByWords(probe(title, { at: new Date(T0.getTime() - 49 * H) }), [c]).recordId).toBeNull();
    // a record reinforced for days still stops taking words a week after it began
    const old = candidate('Coinbase launches x402 Bazaar for agents', { lastReinforcedAt: new Date(T0.getTime() + 8 * 24 * H) });
    expect(matchByWords(probe(title, { at: new Date(T0.getTime() + 8 * 24 * H) }), [old]).recordId).toBeNull();
    expect(matchByWords(probe(title, { kind: 'metric' }), [c]).recordId).toBeNull();
  });

  it('hands what it cannot decide to step 4, best first, and decides nothing itself', () => {
    const c = candidate('Coinbase launches x402 Bazaar for agents');
    const m = matchByWords(probe('Coinbase opens a Bazaar marketplace'), [c]);
    expect(m.recordId).toBeNull();
    expect(m.leftover).toEqual([{ recordId: 'r_1', overlap: expect.any(Number) }]);
    expect(m.leftover[0]!.overlap).toBeGreaterThanOrEqual(0.25);
    expect(matchByWords(probe('Stripe buys a bank'), [c]).leftover).toEqual([]);
  });

  it('overlap is the shared words over the smaller set', () => {
    expect(overlapOf(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({ shared: 3, overlap: 1, jaccard: 0.5 });
    expect(overlapOf([], ['a'])).toEqual({ shared: 0, overlap: 0, jaccard: 0 });
  });
});

describe('kinds and scope', () => {
  it('a source with one kind keeps it; a desk is read by its words', () => {
    expect(classifyKind('Anything at all', 'release')).toBe('release');
    expect(classifyKind('Lending protocol hacked for $12 million', 'statement')).toBe('incident');
    expect(classifyKind('Base halted for 40 minutes', 'statement')).toBe('outage');
    expect(classifyKind('SEC sues exchange over staking', 'statement')).toBe('regulation');
    expect(classifyKind('Arbitrum DAO votes to fund audits', 'statement')).toBe('governance');
    expect(classifyKind('reth v1.9.0 released', 'statement')).toBe('release');
    expect(classifyKind('Stripe introduces stablecoin accounts', 'statement')).toBe('launch');
    expect(classifyKind('A quiet week', 'statement')).toBe('statement');
    expect(kindsCompatible('launch', 'release')).toBe('same');
    expect(kindsCompatible('incident', 'outage')).toBe('same');
    expect(kindsCompatible('statement', 'governance')).toBe('cross');
    expect(kindsCompatible('incident', 'launch')).toBe('no');
    expect(kindsCompatible('metric', 'metric')).toBe('no');
  });

  it('prices, predictions, rankings, memecoins, airdrops and macro lie outside the scope', () => {
    for (const title of ['Bitcoin slides to 3-month low of $65,000 as analyst flags fourth capitulation wave', 'ETH price prediction: could hit $10k', 'Top 5 coins to watch this week', 'Whale moves 10,000 BTC to exchange', 'Memecoin frenzy returns on Solana', 'How to qualify for the next airdrop', 'Fed signals rate cut as inflation cools', 'Election odds shift on Polymarket'])
      expect(outOfScope(title), title).toBe(true);
    for (const title of ['Delayed transaction inclusion on Base Mainnet', 'Coinbase launches x402 Bazaar for agents', 'SEC adopts final rule on custody', 'Lending protocol exploited for $12 million', 'Introducing ChatGPT Wallet', 'op-node v1.9.1']) expect(outOfScope(title), title).toBe(false);
  });
});

describe('grades: sourcing, not truth', () => {
  const src = (sourceId: string, group: string, official = false, cluster = 'news'): RecordSource => ({ sourceId, cluster, group, official, link: null, seenAt: T0.toISOString() });

  it('walks the five steps', () => {
    expect(gradeOf([src('b:coindesk', 'coindesk')], false)).toEqual({ grade: 1, groups: 1 });
    // one source alone never passes 1, cited or not
    expect(gradeOf([src('b:coindesk', 'coindesk')], true).grade).toBe(1);
    // a second source of the same group: repeated, one group
    expect(gradeOf([src('x:1', 'coinbase'), src('x:2', 'coinbase')], false)).toEqual({ grade: 2, groups: 1 });
    expect(gradeOf([src('x:1', 'coinbase'), src('x:2', 'coinbase')], true).grade).toBe(3);
    expect(gradeOf([src('b:coindesk', 'coindesk'), src('b:the-block', 'the-block')], false)).toEqual({ grade: 3, groups: 2 });
    // desks alone never reach 4, however many
    expect(gradeOf(['a', 'b', 'c', 'd', 'e'].map((g) => src(`b:${g}`, g)), true).grade).toBe(3);
    expect(gradeOf([src('b:base-status', 'coinbase', true)], false)).toEqual({ grade: 4, groups: 1 });
    expect(gradeOf([src('b:base-status', 'coinbase', true), src('b:coindesk', 'coindesk')], false).grade).toBe(4);
    // two more groups besides the official one; the official's own sibling does not count
    expect(gradeOf([src('b:base-status', 'coinbase', true), src('b:base-blog', 'coinbase'), src('b:coindesk', 'coindesk')], false).grade).toBe(4);
    expect(gradeOf([src('b:base-status', 'coinbase', true), src('b:coindesk', 'coindesk'), src('b:decrypt', 'decrypt')], false)).toEqual({ grade: 5, groups: 3 });
  });

  it('an incident needs an official source, or a security source and one more group', () => {
    expect(incidentSourced([src('b:coindesk', 'coindesk'), src('b:decrypt', 'decrypt')])).toBe(false);
    expect(incidentSourced([src('b:llama-hacks', 'defillama', false, 'security')])).toBe(false);
    expect(incidentSourced([src('b:llama-hacks', 'defillama', false, 'security'), src('b:coindesk', 'coindesk')])).toBe(true);
    expect(incidentSourced([src('b:base-status', 'coinbase', true, 'base')])).toBe(true);
  });

  it('expires by kind', () => {
    const later = new Date(T0.getTime() + 10 * H);
    const hours = (d: Date) => (d.getTime() - T0.getTime()) / H;
    expect(hours(expiryOf('metric', T0, later, null, 'day'))).toBe(48);
    expect(hours(expiryOf('incident', T0, later, null, 'unknown'))).toBe(82);
    expect(hours(expiryOf('outage', T0, later, null, 'unknown'))).toBe(82);
    expect(hours(expiryOf('release', T0, later, null, 'second'))).toBe(7 * 24);
    expect(hours(expiryOf('regulation', T0, later, null, 'day'))).toBe(14 * 24);
    expect(hours(expiryOf('statement', T0, later, null, 'unknown'))).toBe(72);
    const planned = new Date(T0.getTime() + 30 * 24 * H);
    expect(hours(expiryOf('release', T0, later, planned, 'planned'))).toBe(31 * 24);
  });
});
