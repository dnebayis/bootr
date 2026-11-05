import { describe, expect, it, vi } from 'vitest';
import { BOOTR_OFFICIAL_HANDLE, publishAttributions } from '../src/attributions.js';

vi.mock('../src/agent-directory.js', () => ({ agentDirectory: async () => ({ byHandle: new Map() }) }));
vi.mock('../src/platform-feed.js', () => ({ cachedPlatformFeedData: async () => ({ launches: [] }) }));

describe('the official account', () => {
  it('credits @bootrfun with the site and never looks it up on X', async () => {
    const readAccount = vi.fn();
    const ctx = {
      config: { SITE_URL: 'https://bootr.fun/' },
      sender: { readAccount },
      now: () => 0,
      log: { warn: () => {} },
    } as never;
    const out = await publishAttributions(ctx, 'agent', `say hi to @${BOOTR_OFFICIAL_HANDLE}`, undefined);
    expect(out).toEqual([{ username: 'bootrfun', sourceUrl: 'https://bootr.fun/' }]);
    expect(readAccount).not.toHaveBeenCalled();
  });
});
