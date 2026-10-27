import { describe, expect, it } from 'vitest';
import {
  CDP_FACILITATOR_URL,
  loadConfig,
  resolveFacilitatorUrl,
  TESTNET_FACILITATOR_URL,
} from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/bootr',
  OPENROUTER_API_KEY: 'sk-or-test',
  INFERENCE_PAYTO_ADDRESS: '0x1111111111111111111111111111111111111111',
};

describe('config', () => {
  it('applies testnet defaults and treats empty values as unset', () => {
    const cfg = loadConfig({
      ...base,
      X402_NETWORK: '',
      INFERENCE_PORT: '',
      INFERENCE_X402_SCHEMES: '',
    });
    expect(cfg).toMatchObject({
      X402_NETWORK: 'eip155:84532',
      INFERENCE_PORT: 3003,
      INFERENCE_X402_SCHEMES: ['exact'],
    });
    expect(resolveFacilitatorUrl(cfg.X402_NETWORK, cfg.X402_FACILITATOR_URL)).toBe(
      TESTNET_FACILITATOR_URL,
    );
  });

  it('requires CDP keys for the mainnet (CDP) facilitator', () => {
    expect(() => loadConfig({ ...base, X402_NETWORK: 'eip155:8453' })).toThrow(/CDP_API_KEY_ID/);
    const cfg = loadConfig({
      ...base,
      X402_NETWORK: 'eip155:8453',
      CDP_API_KEY_ID: 'id',
      CDP_API_KEY_SECRET: 'secret',
    });
    expect(resolveFacilitatorUrl(cfg.X402_NETWORK, cfg.X402_FACILITATOR_URL)).toBe(
      CDP_FACILITATOR_URL,
    );
  });

  it('rejects a bad pay-to address, unknown schemes and a payment window shorter than the upstream timeout', () => {
    expect(() => loadConfig({ ...base, INFERENCE_PAYTO_ADDRESS: '0x123' })).toThrow();
    expect(() => loadConfig({ ...base, INFERENCE_X402_SCHEMES: 'exact,stream' })).toThrow();
    expect(
      loadConfig({ ...base, INFERENCE_X402_SCHEMES: 'upto, exact' }).INFERENCE_X402_SCHEMES,
    ).toEqual(['upto', 'exact']);
    expect(() =>
      loadConfig({
        ...base,
        INFERENCE_UPSTREAM_TIMEOUT_MS: '300000',
        INFERENCE_PAYMENT_TIMEOUT_SECONDS: '300',
      }),
    ).toThrow();
  });
});
