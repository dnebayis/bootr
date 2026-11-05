import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { GET } from './route';

describe('GET /skill/skill.md', () => {
  it('answers 200 as Markdown, revalidated on every read', () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="skill.md"');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('opens with the frontmatter and uses the site URL', async () => {
    const body = await GET().text();
    expect(body).toMatch(/^---\nname: launch-on-bootr\ndescription: .+\n---\n/);
    expect(body).toContain(`${env.siteUrl}/skill/skill.md`);
    expect(body).toContain(`${env.siteUrl}/api/agent/launch`);
  });
});
