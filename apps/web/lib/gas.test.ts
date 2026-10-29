import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { formatGas, GAS_EMPTY_WEI, GAS_OK_WEI, gasStatus, gasTotal, validTopUp } from './gas';

describe('agent gas', () => {
  it('mirrors the supervisor thresholds: ok at 0.0002 ETH, empty at 0.00004 ETH', () => {
    expect(gasStatus(GAS_OK_WEI)).toBe('ok');
    expect(gasStatus(parseEther('1'))).toBe('ok');
    expect(gasStatus(GAS_OK_WEI - 1n)).toBe('low');
    expect(gasStatus(GAS_EMPTY_WEI + 1n)).toBe('low');
    expect(gasStatus(GAS_EMPTY_WEI)).toBe('empty');
    expect(gasStatus(0n)).toBe('empty');
  });

  it('counts the EntryPoint deposit and the kernel ETH balance together', () => {
    expect(gasTotal({ deposit: parseEther('0.0001'), balance: parseEther('0.00015') })).toBe(parseEther('0.00025'));
    expect(gasStatus(gasTotal({ deposit: parseEther('0.0001'), balance: parseEther('0.00015') }))).toBe('ok');
  });

  it('formats ETH with at most 5 significant decimals', () => {
    expect(formatGas(parseEther('0.00123456'))).toBe('0.0012346');
    expect(formatGas(parseEther('0.00004'))).toBe('0.00004');
    expect(formatGas(parseEther('1.5'))).toBe('1.5');
    expect(formatGas(0n)).toBe('0');
    expect(formatGas(null)).toBe('—');
  });

  it('accepts top-ups of at least 0.0001 ETH', () => {
    expect(validTopUp('0.001')).toBe(true);
    expect(validTopUp('0.0001')).toBe(true);
    expect(validTopUp('0.00009')).toBe(false);
    expect(validTopUp('0')).toBe(false);
    expect(validTopUp('abc')).toBe(false);
    expect(validTopUp('')).toBe(false);
  });
});
