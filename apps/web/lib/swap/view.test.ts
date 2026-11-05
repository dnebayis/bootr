import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { amountInput, feeFigure, formatAmount, parseAmount, parseSlippage, percent } from './view';

describe('parseAmount', () => {
  it('reads positive amounts', () => {
    expect(parseAmount('1')).toBe(parseEther('1'));
    expect(parseAmount(' 0.01 ')).toBe(parseEther('0.01'));
    expect(parseAmount('.5')).toBe(parseEther('0.5'));
    expect(parseAmount('2.')).toBe(parseEther('2'));
  });

  it('refuses what is not one', () => {
    for (const bad of ['', '0', '0.0', '.', '-1', '1e5', 'abc', '1,5', '1.2.3', `0.${'1'.repeat(19)}`, '999999999999999999999999999999']) {
      expect(parseAmount(bad), bad).toBeNull();
    }
  });
});

describe('formatAmount', () => {
  it('reads at a glance', () => {
    expect(formatAmount(0n)).toBe('0');
    expect(formatAmount(parseEther('28652851.55'))).toBe('28.65M');
    expect(formatAmount(parseEther('1234.56789'))).toBe('1,234.5679');
    expect(formatAmount(parseEther('0.00714790534'))).toBe('0.0071479');
  });

  it('gives inputs the whole number', () => {
    expect(amountInput(parseEther('21493472.301738285044273115'))).toBe('21493472.301738285044273115');
  });
});

describe('parseSlippage', () => {
  it('takes a percent as basis points, within bounds', () => {
    expect(parseSlippage('1')).toBe(100);
    expect(parseSlippage('0.5')).toBe(50);
    expect(parseSlippage('20')).toBe(2000);
    for (const bad of ['', '0', '20.1', '-1', 'x']) expect(parseSlippage(bad), bad).toBeNull();
  });
});

describe('feeFigure', () => {
  it('shows the normal fee when the measured one is close', () => {
    expect(feeFigure(1.1977, 1.2)).toEqual({ pct: 1.2, raised: false });
    expect(feeFigure(2.3897, 2.4)).toEqual({ pct: 2.4, raised: false });
    expect(feeFigure(null, 1)).toEqual({ pct: 1, raised: false });
  });

  it('shows the measured fee when Clanker\'s launch fee is running', () => {
    expect(feeFigure(30.38, 1.2)).toEqual({ pct: 30.38, raised: true });
  });
});

describe('percent', () => {
  it('rounds to two places and keeps tiny figures honest', () => {
    expect(percent(1.2000000000000002)).toBe('1.20%');
    expect(percent(0)).toBe('0.00%');
    expect(percent(0.004)).toBe('<0.01%');
  });
});
