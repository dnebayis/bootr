import { describe, expect, it } from 'vitest';
import { outgoingDisclosureRisk } from './disclosure-policy.js';
import { postValidation } from './post-validation.js';

const TOKEN = '0x' + 'a1'.repeat(20);
const KERNEL = '0x' + 'b2'.repeat(20);
const OTHER = '0x' + 'c3'.repeat(20);

describe('outgoingDisclosureRisk', () => {
  it('lets ordinary posts through', () => {
    for (const text of [
      'Three new holders joined this week. What brought you here?',
      'Fees from the pool bought back about $12 of $BTEST and burned it. Small, but it is the loop working.',
      'Quick explainer: every coin on Bootr gets an agent with its own X account and a locked fee split.',
      'Checking in from the market: roughly $23k liquidity, quiet day, no drama.',
      `Treasury lives here if you want to watch it: ${KERNEL}`,
      'What should the agent talk about next? Reply with ideas.',
    ]) {
      expect(outgoingDisclosureRisk(text, { publicAddresses: [TOKEN, KERNEL] })).toBeNull();
    }
  });

  it('rejects secret material', () => {
    expect(outgoingDisclosureRisk(`key: 0x${'f9'.repeat(32)}`)).toBe('social_secret_material_forbidden');
    expect(outgoingDisclosureRisk(`${'82e1'.repeat(16)} is the service key`)).toBe('social_secret_material_forbidden');
    expect(outgoingDisclosureRisk('token sk-or-v1-notarealkey-notarealkey-notarealkey')).toBe('social_secret_material_forbidden');
    expect(outgoingDisclosureRisk('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc')).toBe('social_secret_material_forbidden');
    expect(outgoingDisclosureRisk('add railway-verify=c8e42d39 to your DNS')).toBe('social_secret_material_forbidden');
    expect(outgoingDisclosureRisk('-----BEGIN PRIVATE KEY-----')).toBe('social_secret_material_forbidden');
  });

  it('rejects internal infrastructure references', () => {
    expect(outgoingDisclosureRisk('the api is at http://localhost:3002')).toBe('social_internal_reference_forbidden');
    expect(outgoingDisclosureRisk('inference.railway.internal:3003 is up')).toBe('social_internal_reference_forbidden');
    expect(outgoingDisclosureRisk('see web-production-cf4e5.up.railway.app')).toBe('social_internal_reference_forbidden');
    expect(outgoingDisclosureRisk('set SENDER_SERVICE_KEY first')).toBe('social_internal_reference_forbidden');
    expect(outgoingDisclosureRisk('OPENROUTER_API_KEY rotated')).toBe('social_internal_reference_forbidden');
    expect(outgoingDisclosureRisk('POST /internal/publish')).toBe('social_internal_reference_forbidden');
  });

  it('rejects runtime jargon that reads like a log line', () => {
    const log =
      'BTEST2 checkpoint 2026-10-27T19:46Z: market snapshot shows $2.317e-7 USD per token, $23.1k mcap, 3 holders. Treasury holds $9.72 USDC (spender allowance). Observation only—no predictions, no calls.';
    expect(outgoingDisclosureRisk(log)).toBe('social_runtime_jargon_forbidden');
    for (const text of [
      'Woken at 13:21 UTC. No new mentions received.',
      'My session key rotates tomorrow.',
      'The paymaster covered gas again.',
      'Inference cost today: $0.04.',
      'Tool result pending, will retry.',
      'Runtime status: waiting.',
      'BTEST2 operational at 19:54Z.',
      'Spender allowance refilled to 20 USDC.',
      'Paid via x402.',
    ]) {
      expect(outgoingDisclosureRisk(text), text).toBe('social_runtime_jargon_forbidden');
    }
  });

  it('does not trip on near-words', () => {
    for (const text of ['the ticker is $BTEST', 'tickets for the meetup', 'an entry-level question', 'I woke up to three new holders']) {
      expect(outgoingDisclosureRisk(text), text).toBeNull();
    }
  });

  it('rejects scientific notation, not ordinary numbers', () => {
    expect(outgoingDisclosureRisk('10 billion tokens moved at $2.3e-7 per token')).toBe('social_unreadable_number_forbidden');
    expect(outgoingDisclosureRisk('price 2.317e-7 USD')).toBe('social_unreadable_number_forbidden');
    expect(outgoingDisclosureRisk('supply 1e18')).toBe('social_unreadable_number_forbidden');
    for (const text of ['about $23k and 3 holders', 'up 2.5% today', 'see you at 7e, the cafe', 'version 2e released', '0.00000023 USD each']) {
      expect(outgoingDisclosureRisk(text), text).toBeNull();
    }
  });

  it('rejects addresses outside the public set, and skips the check without a set', () => {
    expect(outgoingDisclosureRisk(`send questions, not funds: ${OTHER}`, { publicAddresses: [TOKEN, KERNEL] })).toBe('social_private_address_forbidden');
    expect(outgoingDisclosureRisk(`token ${TOKEN} treasury ${KERNEL}`, { publicAddresses: [TOKEN, KERNEL] })).toBeNull();
    expect(outgoingDisclosureRisk(`token ${TOKEN.toUpperCase().replace('0X', '0x')}`, { publicAddresses: [TOKEN] })).toBeNull();
    expect(outgoingDisclosureRisk(`contract ${OTHER}`)).toBeNull();
  });

  it('is enforced by validatePost for posts and replies', () => {
    expect(postValidation('Checkpoint done, next wake in 2h.', [], 'original')).toEqual({ ok: false, code: 'social_runtime_jargon_forbidden' });
    expect(postValidation('thanks! the treasury is public, have a look', [], 'short', false, { reply: true })).toEqual({ ok: true });
    expect(postValidation(`our treasury: ${OTHER}`, [], 'short', false, { publicAddresses: [KERNEL] })).toEqual({ ok: false, code: 'social_private_address_forbidden' });
  });
});
