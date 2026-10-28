import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DOC_PAGES, DOC_REDIRECTS } from '@/components/docs/pages';

/** Each docs page is a static route (no `params`, so it prerenders); a page in DOC_PAGES needs its file. */
it('has a route file for every docs page and retired slug', () => {
  const dir = path.resolve(import.meta.dirname, '../../app/docs');
  for (const p of DOC_PAGES) {
    const file = path.join(dir, p.slug, 'page.tsx');
    expect(existsSync(file), file).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain(`slug="${p.slug}"`);
  }
  for (const slug of Object.keys(DOC_REDIRECTS)) expect(existsSync(path.join(dir, slug, 'page.tsx')), slug).toBe(true);
});
