import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_CONTENT, type Block } from '@/components/docs/content';

const apps = path.resolve(import.meta.dirname, '../../..');
const read = (f: string) => readFileSync(path.join(apps, f), 'utf8');
const WEB_ROUTES = ['launch', 'nonce', 'x-connect', '[kernel]/links', '[kernel]/config'].map((r) => `web/app/api/agent/${r}/route.ts`);

/** The rows of the code table under a heading, by code. */
function documented(heading: string): Set<string> {
  const { blocks } = DOC_CONTENT.api;
  const at = blocks.findIndex((b) => (b.t === 'h3' || b.t === 'h2') && b.id === heading);
  const table = blocks.slice(at).find((b): b is Extract<Block, { t: 'table' }> => b.t === 'table')!;
  return new Set(table.rows.flatMap((r) => [...r[0]!.matchAll(/`(\w+)`/g)].map((m) => m[1]!)));
}

describe('the refusal codes on /docs/api', () => {
  it('list every code the agent API routes answer with', () => {
    const codes = WEB_ROUTES.flatMap((f) => [...read(f).matchAll(/(?:fail|refuse)\(\s*\d+,\s*'(\w+)'/g)].map((m) => m[1]!));
    // `invalid(field, message)` in the launch route and the SIWE helper answer with these two.
    codes.push('invalid_request', 'siwe_rejected');
    expect(codes.length).toBeGreaterThan(15);
    const table = documented('errors-site');
    expect([...new Set(codes)].filter((c) => !table.has(c))).toEqual([]);
  });

  it('list every code the inference relay answers with', () => {
    const src = read('inference/src/app.ts');
    const codes = [...src.matchAll(/errorBody\(\s*'(\w+)'/g)].map((m) => m[1]!);
    codes.push(...[...read('inference/src/pricing.ts').matchAll(/code: '(\w+)',/g)].map((m) => m[1]!));
    expect(codes.length).toBeGreaterThan(20);
    const table = documented('errors-relay');
    expect([...new Set(codes)].filter((c) => !table.has(c))).toEqual([]);
  });

  it('names every SIWE reason', () => {
    const union = /export type SiweFailReason =([\s\S]*?);/.exec(read('web/lib/server/siwe-verify.ts'))![1]!;
    const reasons = [...union.matchAll(/'(\w+)'/g)].map((m) => m[1]!);
    expect(reasons.length).toBeGreaterThan(10);
    const row = DOC_CONTENT.api.blocks.flatMap((b) => (b.t === 'table' ? b.rows : [])).find((r) => r[0] === '`siwe_rejected`')!;
    for (const r of reasons) expect(row[2], r).toContain(`\`${r}\``);
  });
});
