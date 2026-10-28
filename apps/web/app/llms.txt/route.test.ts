import { expect, it } from 'vitest';
import { GET as full } from '../llms-full.txt/route';
import { GET as index } from './route';

it('serves /llms.txt and /llms-full.txt as cached UTF-8 plain text', async () => {
  for (const [res, first] of [
    [index(), '# Bootr\n'],
    [full(), '# Bootr documentation\n'],
  ] as const) {
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=\d+/);
    const body = await res.text();
    expect(body.startsWith(first)).toBe(true);
    expect(body).toContain('https://bootr.fun/docs/fees');
  }
});
