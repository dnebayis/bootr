import { describe, expect, it } from 'vitest';
import { describeConfigError, loadConfig } from '../src/config.js';

const base = {
  X_CLIENT_ID: 'id',
  X_CLIENT_SECRET: 'secret',
  X_REDIRECT_URI: 'https://sender.test/oauth/callback',
  SENDER_SERVICE_KEY: 'k'.repeat(32),
  SENDER_ENCRYPTION_KEY: 'ab'.repeat(32),
  DATABASE_URL: 'postgres://localhost/bootr',
};

describe('config', () => {
  it('applies defaults, including for empty optional vars', () => {
    const c = loadConfig({
      ...base,
      SENDER_RECONCILE_INTERVAL_MS: '',
      SENDER_OAUTH_RETURN_URL: '',
      PORT: '',
    });
    expect(c).toMatchObject({
      PORT: 3002,
      SENDER_RECONCILE_INTERVAL_MS: 60_000,
      SENDER_DEFAULT_POSTS_PER_DAY: 24,
      SENDER_DEFAULT_MENTION_INTERVAL_SEC: 300,
    });
    expect(c.SENDER_OAUTH_RETURN_URL).toBeUndefined();
  });

  it('requires SENDER_SERVICE_KEY of at least 32 characters (no fallback)', () => {
    expect(() => loadConfig({ ...base, SENDER_SERVICE_KEY: 'k'.repeat(31) })).toThrow(
      /at least 32/,
    );
    const { SENDER_SERVICE_KEY: _omit, ...without } = base;
    void _omit;
    expect(() => loadConfig(without)).toThrow(/SENDER_SERVICE_KEY is required/);
    try {
      loadConfig({ ...base, SENDER_SERVICE_KEY: 'short' });
    } catch (err) {
      expect(describeConfigError(err)).toBe(
        'SENDER_SERVICE_KEY: SENDER_SERVICE_KEY must be at least 32 characters (use `openssl rand -hex 32`)',
      );
    }
  });

  it('requires a 32-byte hex encryption key', () => {
    expect(() => loadConfig({ ...base, SENDER_ENCRYPTION_KEY: 'abcd' })).toThrow();
  });
});
