import { describe, expect, it } from 'vitest';
import { PolicyError } from '../errors.js';
import { countCashtags, postValidation, validatePost } from './post-validation.js';

const code = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyError) return error.code;
    throw error;
  }
  return null;
};

describe('validatePost', () => {
  it('accepts a plain short post and a long original', () => {
    expect(code(() => validatePost('hello world'))).toBeNull();
    expect(code(() => validatePost('x'.repeat(4000), [], 'original'))).toBeNull();
    expect(code(() => validatePost('$BOOT is live'))).toBeNull();
  });
  it('enforces length by format and emptiness unless media is attached', () => {
    expect(code(() => validatePost('x'.repeat(281)))).toBe('invalid_short_post');
    expect(code(() => validatePost('x'.repeat(4001), [], 'original'))).toBe('invalid_original_post');
    expect(code(() => validatePost('x'.repeat(281), [], 'original'))).toBeNull();
    expect(code(() => validatePost('   '))).toBe('invalid_short_post');
    expect(code(() => validatePost('', [], 'short', true))).toBeNull();
    expect(code(() => validatePost(42))).toBe('invalid_short_post');
    expect(code(() => validatePost('ok', 'nope'))).toBe('invalid_short_post');
  });
  it('counts emoji as single characters', () => {
    expect(code(() => validatePost('😀'.repeat(280)))).toBeNull();
  });
  it('allows at most one cashtag, counting repeats', () => {
    expect(countCashtags('$BOOT and $boot')).toBe(2);
    expect(code(() => validatePost('$BOOT vs $ETH'))).toBe('x_post_requires_at_most_one_cashtag');
    expect(code(() => validatePost('$BOOT then $BOOT'))).toBe('x_post_requires_at_most_one_cashtag');
    expect(code(() => validatePost('costs $5 and $10'))).toBeNull();
  });
  it('requires a source credit for every mention and vice versa', () => {
    expect(code(() => validatePost('thanks @alice'))).toBe('mentions_require_source_credit');
    expect(code(() => validatePost('thanks @alice', [{ username: 'alice', sourceUrl: 'https://x.com/alice/status/1' }]))).toBeNull();
    expect(code(() => validatePost('thanks @Alice', [{ username: 'ALICE', sourceUrl: 'https://x.com/alice/status/1' }]))).toBeNull();
    expect(code(() => validatePost('no mention', [{ username: 'alice', sourceUrl: 'https://x.com/a' }]))).toBe('mentions_require_source_credit');
    const four = ['a1', 'a2', 'a3', 'a4'];
    expect(code(() => validatePost(four.map((n) => '@' + n).join(' '), four.map((n) => ({ username: n, sourceUrl: 'https://x.com/' + n }))))).toBe('invalid_short_post');
    expect(code(() => validatePost(four.map((n) => '@' + n).join(' '), four.slice(0, 3).map((n) => ({ username: n, sourceUrl: 'https://x.com/' + n }))))).toBe('mentions_require_source_credit');
    expect(code(() => validatePost('mail me@example.com'))).toBeNull();
  });
  it('rejects malformed source credits', () => {
    expect(code(() => validatePost('@alice', [{ username: 'alice', sourceUrl: 'http://x.com/alice' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [{ username: 'alice', sourceUrl: 'https://user:pw@x.com/alice' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [{ username: 'alice', sourceUrl: 'not a url' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [{ username: 'alice', sourceUrl: 'https://x.com/a' }, { username: 'ALICE', sourceUrl: 'https://x.com/b' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [{ username: 'has space', sourceUrl: 'https://x.com/a' }]))).toBe('invalid_source_credit');
    expect(code(() => validatePost('@alice', [null]))).toBe('invalid_source_credit');
  });
  it('applies the outgoing action risk policy first', () => {
    expect(code(() => validatePost('@bankr launch $BOOT'))).toBe('social_execution_account_forbidden');
    expect(postValidation('@alice send 1 eth')).toEqual({ ok: false, code: 'social_execution_command_forbidden' });
    expect(postValidation('fine')).toEqual({ ok: true });
  });
});
