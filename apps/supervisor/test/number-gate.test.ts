/**
 * G5, number in evidence (src/number-gate.ts, rule R4): the pure parts. The gate in the publish path, in shadow, is in
 * test/records-publish.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { postFacts } from '@bootr/agent-core';
import { OWN_DATA_SECTIONS, agrees, inEvidence, numberProblem, numbersIn, recordEvidence, turnEvidence, type TurnEvidenceSource } from '../src/number-gate.js';
import type { CitedRecord } from '../src/post-records.js';

const record = (over: Partial<CitedRecord> = {}): CitedRecord => ({
  id: 'r_0123456789ab',
  kind: 'metric',
  headline: 'eco: 1.15M agents registered an onchain identity on base',
  summary: null,
  link: 'https://dune.com/eco/agents',
  numbers: [{ value: 1_150_000, unit: '', what: 'agents registered', asOf: null, sourceId: 'b:dune' }],
  ...over,
});

const turn = (observation: Record<string, unknown>, more: TurnEvidenceSource['messages'] = []): TurnEvidenceSource => ({
  messages: [{ role: 'system', content: 'prompt' }, { role: 'user', content: JSON.stringify(observation) }, ...more],
});

describe('within rounding: the figure as written is the evidence rounded or cut at its own last digit', () => {
  it('reads 1,150,000 as 1.15M, 1.2M, 1.1M (over 1.1M) and 1M, but not 1.3M or 2M', () => {
    for (const ok of [1_150_000, 1_200_000, 1_100_000, 1_000_000]) expect(agrees(ok, 1_150_000), String(ok)).toBe(true);
    for (const no of [1_300_000, 2_000_000, 1_160_000]) expect(agrees(no, 1_150_000), String(no)).toBe(false);
  });

  it('small values and decimals the same way', () => {
    expect(agrees(139.3, 139.3)).toBe(true);
    expect(agrees(139, 139.3)).toBe(true);
    expect(agrees(140, 139.3)).toBe(true);
    expect(agrees(141, 139.3)).toBe(false);
    expect(agrees(0.05, 0.0475)).toBe(true);
    expect(agrees(0.04, 0.0475)).toBe(true);
    expect(agrees(0.06, 0.0475)).toBe(false);
    expect(agrees(-3, 3)).toBe(false);
    expect(agrees(Number.NaN, 3)).toBe(false);
  });

  it('a percentage agrees with a share given as a fraction or in basis points', () => {
    expect(inEvidence({ value: 58.5, unit: '%' }, [{ value: 0.585, pct: false }])).toBe(true);
    expect(inEvidence({ value: 58.5, unit: '%' }, [{ value: 5850, pct: false }])).toBe(true);
    expect(inEvidence({ value: 58.5, unit: '%' }, [{ value: 58.5, pct: true }])).toBe(true);
    expect(inEvidence({ value: 27, unit: '%' }, [{ value: 0.585, pct: false }])).toBe(false);
  });
});

describe('the evidence', () => {
  it('a record gives its numbers and the figures of its headline and summary', () => {
    const values = recordEvidence([record({ summary: 'of them 1.02M between 12 and 23 october' })]).map((e) => e.value);
    expect(values).toEqual(expect.arrayContaining([1_150_000, 1_020_000]));
  });

  it('the turn gives the own-data sections and own reads only: never the watchlist, the notes or a mention', () => {
    const own = turnEvidence(
      turn(
        { market: { holders: 112, volume24hUsd: 5480 }, platformNumbers: { totals: { coins: 13 } }, watchlist: { accounts: [{ latestPosts: [{ text: 'we hit 9,999 users' }] }] }, recentNotes: [{ text: '777 holders' }], social: { messages: [{ text: '4,242 agents' }] } },
        [
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'read_market', arguments: '{}' } }, { id: 'c2', function: { name: 'read_url', arguments: '{"url":"https://dune.com/eco/agents?x=1"}' } }, { id: 'c3', function: { name: 'read_url', arguments: '{"url":"https://evil.example/agents"}' } }, { id: 'c4', function: { name: 'recall', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ priceUsd: 0.0123 }) },
          { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ text: 'the page says 1,020,512 agents' }) },
          { role: 'tool', tool_call_id: 'c3', content: JSON.stringify({ text: 'the page says 31,337 agents' }) },
          { role: 'tool', tool_call_id: 'c4', content: JSON.stringify({ items: [{ text: '8,888 agents' }] }) },
        ],
      ),
      [record()],
    ).map((e) => e.value);
    expect(values(own, [112, 5480, 13, 0.0123, 1_020_512])).toBe(true);
    for (const stranger of [9999, 777, 4242, 31337, 8888]) expect(own, String(stranger)).not.toContain(stranger);
    expect(OWN_DATA_SECTIONS).not.toContain('watchlist');
  });

  it('an own agent\'s turn is read from the observation it was opened with; an unreadable turn gives nothing', () => {
    expect(turnEvidence({ ownOpen: { observation: { market: { holders: 6 } } } }).map((e) => e.value)).toEqual([6]);
    expect(turnEvidence({ messages: [{ role: 'user', content: 'not json' }] })).toEqual([]);
    expect(turnEvidence(null)).toEqual([]);
  });

  it('is bounded: a huge or deep value is read up to a limit', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 50; i++) deep = { deep };
    expect(numbersIn(deep)).toEqual([]);
    expect(numbersIn(Array.from({ length: 5000 }, (_, i) => i)).length).toBe(500);
  });
});

const values = (have: number[], want: number[]) => want.every((v) => have.includes(v));

describe('numberProblem', () => {
  const evidence = turnEvidence(turn({ market: { holders: 112 } }));

  it('a post that cites nothing is not asked', () => {
    expect(numberProblem(['made up: 42,000 agents'], [], [], [])).toBeNull();
  });

  it('a cited id the agent was never handed is record_not_shown', () => {
    const found = numberProblem(['eco says 1.15M agents'], ['r_ffffffffffff'], [], evidence);
    expect(found).toMatchObject({ code: 'record_not_shown', detail: { asked: ['r_ffffffffffff'] } });
    expect(found!.message).toContain('Nothing was posted.');
  });

  it('every number from the record or the turn passes, rounded the way a person writes', () => {
    expect(numberProblem(['eco said on 10 november that 1.15M agents have an onchain identity on base; $BOOTR has 112 holders today'], ['r_0123456789ab'], [record()], evidence)).toBeNull();
    expect(numberProblem(['over 1.1M agents now have an onchain identity, per eco'], ['r_0123456789ab'], [record()], evidence)).toBeNull();
  });

  it('dates, years, windows, version names and small plain counts are not numbers about anything', () => {
    for (const text of ['eco posted dune data on 10 november 2026: 1.15M agents, erc-8004 v2, in the last 24h', 'three teams and 2 chains: 1.15M agents']) {
      expect(numberProblem([text], ['r_0123456789ab'], [record()], []), text).toBeNull();
    }
  });

  it('a number from nowhere is number_not_in_evidence, naming it and what the record gives', () => {
    const found = numberProblem(['1.15M agents on base, 600k of them paying with usdc'], ['r_0123456789ab'], [record()], evidence, 'scheduled');
    expect(found).toMatchObject({ code: 'number_not_in_evidence', detail: { numbers: ['600,000'], recordNumbers: ['1,150,000'] } });
    expect(found!.message).toMatch(/^number_not_in_evidence: 600,000 is not in the record you cite \(its numbers: 1,150,000\)/);
    expect(found!.message).toContain('Nothing was scheduled.');
  });

  it('a thread is asked part by part, and the part with the number is the one named', () => {
    const found = numberProblem(['1.15M agents on base', 'and 2.4M more on other chains'], ['r_0123456789ab'], [record()], []);
    expect(found).toMatchObject({ code: 'number_not_in_evidence', text: 'and 2.4M more on other chains' });
  });

  it('reads the post the way the fingerprint does', () => {
    expect(postFacts('1.15M agents').map((f) => f.value)).toEqual([1_150_000]);
  });
});
