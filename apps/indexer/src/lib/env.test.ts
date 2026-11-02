import { afterEach, describe, expect, it, vi } from 'vitest';

import { isLauncher, parseLaunchers, resolveLaunchers } from './env';

const OLD = '0xD3CE024ddC37465510E6c9a1D7942f003338B1F3';
const NEW = '0x7ddaf2A1FC0861B288c7b0BDfA8314621C47c3a5';

describe('parseLaunchers (BOOTR_LAUNCHERS)', () => {
  it('parses a comma-separated address@startBlock list, checksumming addresses', () => {
    expect(parseLaunchers(`${OLD.toLowerCase()}@53219209, ${NEW}@53500000`)).toEqual([
      { address: OLD, startBlock: 53_219_209 },
      { address: NEW, startBlock: 53_500_000 },
    ]);
  });
  it('is empty for an unset or blank value', () => {
    expect(parseLaunchers(undefined)).toEqual([]);
    expect(parseLaunchers('')).toEqual([]);
    expect(parseLaunchers(' , ')).toEqual([]);
  });
  it('merges a duplicated address, keeping the lowest start block', () => {
    expect(parseLaunchers(`${OLD}@53300000,${OLD.toLowerCase()}@53219209`)).toEqual([{ address: OLD, startBlock: 53_219_209 }]);
  });
  it('rejects malformed entries instead of dropping them', () => {
    expect(() => parseLaunchers(OLD)).toThrow(/not <address>@<startBlock>/);
    expect(() => parseLaunchers(`${OLD}@`)).toThrow();
    expect(() => parseLaunchers(`${OLD}@abc`)).toThrow();
    expect(() => parseLaunchers(`${OLD}@53219209@1`)).toThrow();
    expect(() => parseLaunchers('0x1234@53219209')).toThrow();
    expect(() => parseLaunchers(`${OLD}@53219209,garbage`)).toThrow(/garbage/);
    expect(() => parseLaunchers(`${OLD}@99999999999999999999`)).toThrow(/out of range/);
  });
});

describe('resolveLaunchers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefers BOOTR_LAUNCHERS and starts every source at the earliest block', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = resolveLaunchers({ BOOTR_LAUNCHERS: `${NEW}@53500000,${OLD}@53219209`, BOOTR_LAUNCHER_ADDRESS: OLD, BOOTR_START_BLOCK: '1' }, 8453, null);
    expect(r.launchers.map((l) => l.address)).toEqual([NEW, OLD]);
    expect(r.startBlock).toBe(53_219_209);
    // The single address is in the list (the production layout): no warning.
    expect(console.warn).not.toHaveBeenCalled();
    resolveLaunchers({ BOOTR_LAUNCHERS: `${NEW}@53500000`, BOOTR_LAUNCHER_ADDRESS: OLD }, 8453, null);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('does not contain BOOTR_LAUNCHER_ADDRESS'));
  });
  it('falls back to BOOTR_LAUNCHER_ADDRESS + BOOTR_START_BLOCK (the current single-launcher deployment)', () => {
    expect(resolveLaunchers({ BOOTR_LAUNCHER_ADDRESS: OLD.toLowerCase(), BOOTR_START_BLOCK: '53219209' }, 8453, null)).toEqual({
      launchers: [{ address: OLD, startBlock: 53_219_209 }],
      startBlock: 53_219_209,
    });
    // LAUNCHER_START_BLOCK (the supervisor's name) is accepted when BOOTR_START_BLOCK is empty.
    expect(resolveLaunchers({ BOOTR_LAUNCHER_ADDRESS: OLD, BOOTR_START_BLOCK: '', LAUNCHER_START_BLOCK: '53219209' }, 8453, null).startBlock).toBe(53_219_209);
    // An invalid single address is ignored with a warning (unchanged behaviour), leaving the address book.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveLaunchers({ BOOTR_LAUNCHER_ADDRESS: 'nope' }, 8453, NEW).launchers).toEqual([{ address: NEW, startBlock: 0 }]);
  });
  it('uses the address book when no env address is set, and latest when no block is known', () => {
    expect(resolveLaunchers({}, 8453, NEW)).toEqual({ launchers: [{ address: NEW, startBlock: 0 }], startBlock: 'latest' });
    expect(resolveLaunchers({}, 8453, null)).toEqual({ launchers: [], startBlock: 'latest' });
    // Base Sepolia has a recorded deploy block.
    expect(resolveLaunchers({}, 84532, NEW).startBlock).toBe(49_367_726);
  });
});

describe('isLauncher', () => {
  it('matches any listed launcher regardless of case', () => {
    const env = { launchers: parseLaunchers(`${OLD}@1,${NEW}@2`) };
    expect(isLauncher(env, OLD.toLowerCase())).toBe(true);
    expect(isLauncher(env, NEW)).toBe(true);
    expect(isLauncher(env, '0x0000000000000000000000000000000000000000')).toBe(false);
  });
});
