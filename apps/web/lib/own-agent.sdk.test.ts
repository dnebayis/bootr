import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `@bootrfun/sdk` is published on its own and cannot import the private `@bootr/shared`, so it carries a copy of the
 * own-agent wire types (docs/design/byo-agent.md section 13.3). The copy must be the same bytes: this fails when one
 * of the two files changes without the other, and the fix is to copy the shared file over the SDK's.
 */
const REPO = path.resolve(import.meta.dirname, '../../..');
const SHARED = path.join(REPO, 'packages/shared/src/own-agent.ts');
const SDK = path.join(REPO, 'packages/sdk/src/own-agent.ts');

describe('the SDK’s copy of the own-agent types', () => {
  it('is the shared file, byte for byte', () => {
    const shared = readFileSync(SHARED);
    const sdk = readFileSync(SDK);
    expect(sdk.equals(shared), 'copy packages/shared/src/own-agent.ts over packages/sdk/src/own-agent.ts').toBe(true);
  });

  it('imports nothing, so every package can take it', () => {
    expect(readFileSync(SHARED, 'utf8')).not.toMatch(/^\s*import\s/m);
  });

  it('is exported by the shared package under ./own-agent', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'packages/shared/package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./own-agent']).toBe('./src/own-agent.ts');
  });
});
