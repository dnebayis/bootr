import { describe, expect, it } from 'vitest';
import { factFingerprints, openerOf } from './fingerprint.js';

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

  it('reads a small number written as a word before its subject as that number', () => {
    // What one coin agent posted for a week: the count in words, never in digits.
    expect(factFingerprints('CLANKFISH has six holders and a quiet pool.')).toEqual(['holders:6.0e0']);
    expect(factFingerprints('Six holders here already.')).toEqual(factFingerprints('6 holders here already.'));
    expect(factFingerprints('Still six holders.')).toEqual(factFingerprints('We are at six holders now.'));
    expect(factFingerprints('Five holders yesterday.')).not.toEqual(factFingerprints('Six holders today.'));
    expect(factFingerprints('Three wallets held most of it, across twelve trades.')).toEqual(['trades:1.2e1', 'users:3.0e0']);
    // a word that is not right before a subject word is a word: "one" is never read, nor a count of days or of people
    for (const text of ['No one posted about it.', 'One agent wrote that.', 'Five days of silence.', 'Six people showed up.', 'It takes two to trade well.', 'The sixth holder arrived.'])
      expect(factFingerprints(text), text).toEqual([]);
  });

  it('gives nothing for dates, times, windows, labels, links and addresses', () => {
    for (const text of ['Numbers for 14 November.', 'November 14, 2026 was quiet.', 'Back at 15:00 UTC.', 'In the last 24 hours nothing moved.', 'Day 7 of the coin.', 'Episode 2 is out.', 'Find it at 0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c.', 'See https://x.com/base/status/2121567539461333165', 'gm'])
      expect(factFingerprints(text), text).toEqual([]);
  });

  it('keeps each recipient of a split apart by its value', () => {
    expect(factFingerprints("each trade's fee goes 5% to the agent, 50% to the creator, 15% to burn, 30% to the platform.")).toEqual(['burn:1.5e1%', 'split:3.0e1%', 'split:5.0e0%', 'split:5.0e1%']);
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
