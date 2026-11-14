import { describe, expect, it } from 'vitest';
import { factFingerprints, openerOf, postFacts } from './fingerprint.js';

describe('factFingerprints: what a post states, as comparable strings', () => {
  it('reads one fingerprint per number, with its unit and the nearest subject', () => {
    expect(factFingerprints('112 holders today and about $4.3k traded in 24h.')).toEqual(['holders:1.1e2', 'volume:4.3e3$']);
    expect(factFingerprints('3.05% of supply is burned so far.')).toEqual(['supply:3.0e0%']);
    expect(factFingerprints('The fee pool holds 0.0475 WETH.')).toEqual(['fee:4.8e-2weth']);
    expect(factFingerprints('1.15M agents have registered an onchain identity.')).toEqual(['agents:1.2e6']);
  });

  it('sees the same fact in different words, and a changed value as a new one', () => {
    const a = factFingerprints('We are at 112 holders now.');
    expect(factFingerprints('Still 112 holders, the floor stops proving.')).toEqual(a);
    expect(factFingerprints('112 holders. Nothing else moved.')).toEqual(a);
    expect(factFingerprints('118 holders this morning.')).not.toEqual(a);
    // two significant figures: 487 and 489 holders read as one fact, 487 and 520 do not
    expect(factFingerprints('487 holders')).toEqual(factFingerprints('489 holders'));
    expect(factFingerprints('487 holders')).not.toEqual(factFingerprints('520 holders'));
  });

  it('gives nothing for dates, times, windows, labels, links and addresses', () => {
    for (const text of ['Numbers for 14 November.', 'November 14, 2026 was quiet.', 'Back at 15:00 UTC.', 'In the last 24 hours nothing moved.', 'Day 7 of the coin.', 'Episode 2 is out.', 'Find it at 0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c.', 'See https://x.com/base/status/2121567539461333165', 'gm'])
      expect(factFingerprints(text), text).toEqual([]);
  });

  it('keeps each recipient of a split apart by its value', () => {
    expect(factFingerprints("each trade's fee goes 5% to the agent, 50% to the creator, 15% to burn, 30% to the platform.")).toEqual(['burn:1.5e1%', 'split:3.0e1%', 'split:5.0e0%', 'split:5.0e1%']);
  });
});

describe('factFingerprints: names and date ranges are not facts', () => {
  it('reads the model post of the design note as its two counts and nothing else', () => {
    // docs/design/agent-behaviour.md section 2.3: before, "ERC-8004" gave `agents:8.0e3` and the "23" of the range `agents:2.3e1`.
    expect(factFingerprints('Eco posted Dune data on 10 November: 1.15M agents have registered an onchain identity (ERC-8004) on Base, 1.02M of them between Oct 12 and 23.')).toEqual(['agents:1.0e6', 'agents:1.2e6']);
  });

  it('gives nothing for the number in the name of a standard or a model, or for either day of a range', () => {
    for (const text of ['EIP-1559 changed how fees work.', 'An ERC-20 token.', 'GPT-5 is out.', 'Open from 12-23 November.', 'Between Oct 12 and 23 it was quiet.', 'From November 3 to 9.']) expect(factFingerprints(text), text).toEqual([]);
    // A percentage or an amount after a hyphen is still a figure.
    expect(factFingerprints('A sub-1% fee.')).toEqual(['fee:1.0e0%']);
  });

  it('takes a word that only starts like a month for the noun it is', () => {
    expect(factFingerprints('3 markets opened for agents.')).toEqual(['agents:3.0e0']);
    expect(factFingerprints('12 decentralized apps and their users.')).toEqual(['users:1.2e1']);
    expect(factFingerprints('On 3 March the coin launched.')).toEqual([]);
    expect(factFingerprints('On Sept 4 it was quiet.')).toEqual([]);
  });
});

describe('postFacts: the numbers behind the fingerprints, as written', () => {
  it('keeps the value that rounding hides', () => {
    expect(postFacts('114 holders now, up from 112.')).toEqual([
      { fingerprint: 'holders:1.1e2', subject: 'holders', unit: '', value: 114 },
      { fingerprint: 'holders:1.1e2', subject: 'holders', unit: '', value: 112 },
    ]);
    expect(factFingerprints('114 holders now, up from 112.')).toEqual(['holders:1.1e2']);
  });

  it('applies the scale, keeps the unit, and lists a number said twice once', () => {
    expect(postFacts('1.15M agents, and $4.3k traded. Again: 1.15M agents.')).toEqual([
      { fingerprint: 'agents:1.2e6', subject: 'agents', unit: '', value: 1_150_000 },
      { fingerprint: 'volume:4.3e3$', subject: 'volume', unit: '$', value: 4300 },
    ]);
    expect(postFacts('Fee pool sits at $0.0475 WETH.')).toEqual([{ fingerprint: 'fee:4.8e-2$', subject: 'fee', unit: '$', value: 0.0475 }]);
    expect(postFacts('gm')).toEqual([]);
  });

  it('is what factFingerprints is built from', () => {
    for (const text of ['112 holders today and about $4.3k traded in 24h.', "each trade's fee goes 5% to the agent, 50% to the creator, 15% to burn, 30% to the platform.", 'Six holders here already collect from the fee engine'])
      expect(factFingerprints(text)).toEqual([...new Set(postFacts(text).map((f) => f.fingerprint))].sort());
  });
});

describe('openerOf', () => {
  it('is the first three words, lowercased, with numbers and handles folded', () => {
    expect(openerOf('Jesse Pollak says agents can now pay for search.')).toBe('jesse pollak says');
    expect(openerOf('112 holders today, up three.')).toBe('# holders today');
    expect(openerOf('@jessepollak said it plainly: build.')).toBe('@ said it');
    expect(openerOf('  Where $BOOTR lives, for anyone asking')).toBe('where $bootr lives');
    expect(openerOf('')).toBe('');
  });
});
