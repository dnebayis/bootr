import { describe, expect, it } from 'vitest';
import { REGISTRATION_TYPE, agentCardUrl, buildRegistration, isLaunchId, pendingRegistration, type CardToken } from './agent-card';

const DRAFT = '3b241101-e2bb-4255-8caf-4136c566a962';
const TEXT = 'A patient onchain analyst for small Base coins.\nShort, plain, no hype.';

const token: CardToken = {
  id: '0x3000000000000000000000000000000000000003',
  chainId: 84532,
  name: 'Test Coin',
  symbol: 'TEST',
  image: 'https://gateway.pinata.cloud/ipfs/bafy',
  kernel: '0x2000000000000000000000000000000000000002',
  agentId: '7',
  xHandle: 'test_agent',
};

describe('agent card identity', () => {
  it('names the card by the launch id', () => {
    expect(isLaunchId(DRAFT)).toBe(true);
    expect(agentCardUrl(DRAFT)).toMatch(new RegExp(`/agents/${DRAFT}\\.json$`));
  });

  it('puts the creator text first in the description and in bootr.identity for an indexed launch', () => {
    const doc = buildRegistration(token, TEXT);
    expect(doc.type).toBe(REGISTRATION_TYPE);
    expect(doc.description.startsWith(`${TEXT}\n\nThe agent of Test Coin ($TEST)`)).toBe(true);
    expect(doc.bootr).toEqual({ identity: TEXT });
    expect(doc.services).toContainEqual({ name: 'X', endpoint: 'https://x.com/test_agent' });
    expect(doc.registrations).toHaveLength(1);
  });

  it('carries the creator text in the pending card too (the supervisor reads it before indexing)', () => {
    const doc = pendingRegistration(TEXT);
    expect(doc.registrations).toEqual([]);
    expect(doc.bootr).toEqual({ identity: TEXT });
    expect(doc.description.startsWith(TEXT)).toBe(true);
  });

  it('is unchanged without a creator text', () => {
    for (const none of [undefined, null, '', '   ']) {
      const full = buildRegistration(token, none);
      expect(full.bootr).toBeUndefined();
      expect(full.description.startsWith('The agent of Test Coin ($TEST)')).toBe(true);
      expect(pendingRegistration(none).bootr).toBeUndefined();
    }
    expect(buildRegistration(token)).toEqual(buildRegistration(token, null));
  });
});
