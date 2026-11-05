import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_PAGES, DOC_REDIRECTS, docMarkdownPath, docMetadata } from '@/components/docs/pages';
import { pageToMarkdown } from './markdown';

const app = path.resolve(import.meta.dirname, '../../app');
const dir = path.join(app, 'docs');

/** Each docs page is a static route (no `params`, so it prerenders); a page in DOC_PAGES needs its file. */
it('has a route file for every docs page and retired slug', () => {
  for (const p of DOC_PAGES) {
    const file = path.join(dir, p.slug, 'page.tsx');
    expect(existsSync(file), file).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain(`slug="${p.slug}"`);
  }
  for (const slug of Object.keys(DOC_REDIRECTS)) expect(existsSync(path.join(dir, slug, 'page.tsx')), slug).toBe(true);
});

/**
 * The Markdown pages are literal routes too, so an unknown `/docs/nope.md` matches nothing and gets the site's real
 * 404, and `/docs/nope` is untouched (a dynamic segment here would catch both). `e2e/docs-markdown.spec.ts` asks a
 * running server for that 404.
 */
describe('/docs/<slug>.md', () => {
  const routeFile = (mdPath: string) => path.join(app, mdPath.slice(1), 'route.ts');

  it('answers 200 with the page as UTF-8 text/markdown, for every page', async () => {
    for (const p of DOC_PAGES) {
      const mod = (await import(/* @vite-ignore */ routeFile(docMarkdownPath(p.slug)))) as { GET: () => Response };
      const res = mod.GET();
      expect(res.status, p.slug).toBe(200);
      expect(res.headers.get('content-type'), p.slug).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('cache-control'), p.slug).toMatch(/^public, max-age=\d+/);
      expect(res.headers.get('link'), p.slug).toContain('rel="canonical"');
      expect(await res.text(), p.slug).toBe(`${pageToMarkdown(p.slug)}\n`);
    }
  });

  it('has no route for a page the docs do not list', () => {
    const known = new Set(DOC_PAGES.map((p) => docMarkdownPath(p.slug)));
    const routes = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => `/docs/${f}`);
    expect(routes.length).toBeGreaterThan(5);
    for (const r of routes) expect(known.has(r), r).toBe(true);
    expect(existsSync(routeFile('/docs/nope.md'))).toBe(false);
  });

  it('is announced by each page', () => {
    for (const p of DOC_PAGES) {
      const { alternates } = docMetadata(p.slug);
      expect(alternates.types['text/markdown']).toBe(docMarkdownPath(p.slug));
      expect(alternates.types['text/plain']).toBe('/llms.txt');
    }
  });
});

describe('the image build', () => {
  it('keeps route folders named *.md, which .dockerignore would otherwise drop (they answered 404 in production)', () => {
    const ignore = readFileSync(new URL('../../../../.dockerignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
    const excluded = ignore.indexOf('**/*.md');
    expect(excluded).toBeGreaterThanOrEqual(0);
    expect(ignore.indexOf('!apps/web/app/**/*.md')).toBeGreaterThan(excluded);
    expect(ignore.indexOf('!apps/web/app/**/*.md/**')).toBeGreaterThan(excluded);
  });
});

