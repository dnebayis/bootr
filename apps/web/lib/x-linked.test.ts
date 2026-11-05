import { describe, expect, it } from 'vitest';
import { provenXHandle } from './x-linked';

describe('provenXHandle', () => {
  it('gives the handle the sender holds for a real agent id', () => {
    expect(provenXHandle('1153600', { handle: 'AgentBootr' })).toBe('AgentBootr');
  });

  it('claims nothing while the account is unknown', () => {
    expect(provenXHandle('1153600', null)).toBeNull();
    expect(provenXHandle('1153600', undefined)).toBeNull();
  });

  it('claims nothing for a revoked or missing account', () => {
    expect(provenXHandle('1153600', { handle: null })).toBeNull();
  });

  it('claims nothing for a launch draft, which needs no wallet to connect', () => {
    expect(provenXHandle('6f1d3c2a-8f43-4b7e-9a11-0c6d2e5f7a10', { handle: 'someone' })).toBeNull();
  });

  it('claims nothing without an agent, as for a coin launched without one', () => {
    expect(provenXHandle(null, { handle: 'someone' })).toBeNull();
    expect(provenXHandle(undefined, { handle: 'someone' })).toBeNull();
    expect(provenXHandle('', { handle: 'someone' })).toBeNull();
    expect(provenXHandle('0', { handle: 'someone' })).toBeNull();
  });

  it('refuses something that is not an X handle', () => {
    expect(provenXHandle('12', { handle: 'not a handle' })).toBeNull();
    expect(provenXHandle('12', { handle: 'much_too_long_for_x_handles' })).toBeNull();
    expect(provenXHandle('12', { handle: '' })).toBeNull();
  });
});
