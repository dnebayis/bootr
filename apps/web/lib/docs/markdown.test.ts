import { describe, expect, it } from 'vitest';
import { DOC_CONTENT } from '@/components/docs/content';
import { DOC_PAGES, docPath, type DocSlug } from '@/components/docs/pages';
import { inlineText, mapLinks, parseInline } from './inline';
import { absolutize, blockToMarkdown, llmsFullTxt, llmsTxt, pageToMarkdown } from './markdown';

const SITE = 'https://bootr.fun';

describe('inline markup', () => {
  it('parses code, bold and links (with markup inside link text)', () => {
    expect(parseInline('a `x` **b** [see `y`](/docs) z')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'code', text: 'x' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'link', href: '/docs', children: [{ kind: 'text', text: 'see ' }, { kind: 'code', text: 'y' }] },
      { kind: 'text', text: ' z' },
    ]);
  });

  it('strips markup for plain text and rewrites only link targets', () => {
    expect(inlineText('**Fee** [`claim`](/docs/fees#claiming)')).toBe('Fee claim');
    expect(mapLinks('[a](/x) `[b](/y)` and [c](https://e.com)', (h) => `!${h}`)).toBe('[a](!/x) `[b](!/y)` and [c](!https://e.com)');
  });
});

describe('markdown rendering', () => {
  it('makes site links absolute and anchors page-relative', () => {
    expect(absolutize('/docs/fees', 'api')).toBe(`${SITE}/docs/fees`);
    expect(absolutize('#dormancy', 'agents')).toBe(`${SITE}/docs/agents#dormancy`);
    expect(absolutize('#x', '')).toBe(`${SITE}/docs#x`);
    expect(absolutize('https://basescan.org/a', 'contracts')).toBe('https://basescan.org/a');
  });

  it('renders tables with aligned numeric columns and escaped pipes', () => {
    const md = blockToMarkdown({ t: 'table', head: ['k', 'n'], rows: [['a | b', '1']], numeric: [1] }, '');
    expect(md).toBe('| k | n |\n| --- | ---: |\n| a \\| b | 1 |');
  });

  it('fences code with a longer fence when the code contains one', () => {
    expect(blockToMarkdown({ t: 'code', code: 'x', lang: 'sh', label: 'try it' }, '')).toBe('try it:\n\n```sh\nx\n```');
    expect(blockToMarkdown({ t: 'code', code: 'a\n```\nb' }, '')).toBe('````\na\n```\nb\n````');
  });

  it('renders every page with its title, source and no relative links', () => {
    for (const p of DOC_PAGES) {
      const md = pageToMarkdown(p.slug);
      expect(md.startsWith(`# ${p.title}\n\nSource: ${SITE}${docPath(p.slug)}`)).toBe(true);
      expect(md).not.toMatch(/\]\((?!https?:\/\/)/);
    }
  });
});

describe('docs content', () => {
  const ids = new Map<string, Set<string>>(
    DOC_PAGES.map((p) => [p.slug, new Set(DOC_CONTENT[p.slug].blocks.flatMap((b) => (b.t === 'h2' || b.t === 'h3' ? [b.id] : [])))]),
  );
  const strings = (slug: DocSlug) =>
    [DOC_CONTENT[slug].lead, ...DOC_CONTENT[slug].blocks.flatMap((b) => ('text' in b ? [b.text] : 'items' in b ? b.items : b.t === 'table' ? b.rows.flat() : []))];

  it('has unique heading ids per page', () => {
    for (const p of DOC_PAGES) {
      const all = DOC_CONTENT[p.slug].blocks.flatMap((b) => (b.t === 'h2' || b.t === 'h3' ? [b.id] : []));
      expect(new Set(all).size, p.slug).toBe(all.length);
    }
  });

  it('only links to docs pages and anchors that exist', () => {
    for (const p of DOC_PAGES) {
      for (const s of strings(p.slug)) {
        for (const m of s.matchAll(/\]\(([^)\s]+)\)/g)) {
          const href = m[1]!;
          if (href.startsWith('#')) expect(ids.get(p.slug)!.has(href.slice(1)), `${p.slug}: ${href}`).toBe(true);
          const d = /^\/docs(?:\/([\w-]+))?(?:#([\w-]+))?$/.exec(href);
          if (href.startsWith('/docs')) {
            expect(d, href).not.toBeNull();
            const target = ids.get(d![1] ?? '');
            expect(target, href).toBeDefined();
            if (d![2]) expect(target!.has(d![2]), href).toBe(true);
          }
        }
      }
    }
  });

  it('gives every table row as many cells as the header', () => {
    for (const p of DOC_PAGES)
      for (const b of DOC_CONTENT[p.slug].blocks) if (b.t === 'table') for (const r of b.rows) expect(r.length, `${p.slug}: ${r[0]}`).toBe(b.head.length);
  });

  it('documents nothing private', () => {
    const full = llmsFullTxt();
    for (const banned of ['/internal', 'console', 'HMAC', 'SERVICE_KEY', 'ADMIN_', '/api/admin', '/sql', 'railway']) {
      expect(full.toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
  });

  it('keeps the RWAGMI fee facts', () => {
    const fees = pageToMarkdown('fees');
    for (const s of ['0.045%', '0.585%', '0.27%', '0.10%', '0.135%', '5,850', '4,500', '1,350', '2,700', '1,000', 'settleAndClaim', 'claimQuote', 'pendingQuote', 'claimableQuote']) {
      expect(fees).toContain(s);
    }
  });
});

describe('llms.txt', () => {
  const txt = llmsTxt();

  it('follows the llmstxt.org layout: H1, blockquote, then H2 sections of links', () => {
    const lines = txt.split('\n');
    expect(lines[0]).toBe('# Bootr');
    expect(lines[2]!.startsWith('> ')).toBe(true);
    expect(txt.match(/^# /gm)).toHaveLength(1);
    const sections = txt.split(/^## /m).slice(1);
    expect(sections.length).toBeGreaterThanOrEqual(4);
    for (const s of sections) {
      const items = s.split('\n').slice(1).filter(Boolean);
      expect(items.length).toBeGreaterThan(0);
      for (const it of items) expect(it).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)\s]+\)(: .+)?$/);
    }
  });

  it('links every docs page and the full text with absolute bootr.fun URLs', () => {
    for (const p of DOC_PAGES) expect(txt).toContain(`- [${p.title}](${SITE}${docPath(p.slug)}): ${p.description}`);
    expect(txt).toContain(`(${SITE}/llms-full.txt)`);
    expect(txt).not.toMatch(/\]\((?!https:\/\/)/);
  });

  it('full text carries every page in reading order', () => {
    const full = llmsFullTxt();
    const at = DOC_PAGES.map((p) => full.indexOf(`\n# ${p.title}\n`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(full).toContain('swappers pay (1%)        $1,000');
  });
});
