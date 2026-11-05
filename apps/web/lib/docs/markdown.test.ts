import { describe, expect, it } from 'vitest';
import { DOC_CONTENT } from '@/components/docs/content';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DOC_PAGES, docMarkdownPath, docPath, type DocSlug } from '@/components/docs/pages';
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
  it('makes site links absolute, anchors page-relative and docs links Markdown', () => {
    expect(absolutize('/docs/fees', 'api')).toBe(`${SITE}/docs/fees.md`);
    expect(absolutize('/docs/fees#claiming', 'api')).toBe(`${SITE}/docs/fees.md#claiming`);
    expect(absolutize('/docs', 'api')).toBe(`${SITE}/docs.md`);
    expect(absolutize('#dormancy', 'agents')).toBe(`${SITE}/docs/agents.md#dormancy`);
    expect(absolutize('#x', '')).toBe(`${SITE}/docs.md#x`);
    expect(absolutize('/api/models', 'agents')).toBe(`${SITE}/api/models`);
    expect(absolutize('/docsy', 'agents')).toBe(`${SITE}/docsy`);
    expect(absolutize('https://basescan.org/a', 'contracts')).toBe('https://basescan.org/a');
  });

  it('keeps a heading’s id as an explicit anchor', () => {
    expect(blockToMarkdown({ t: 'h2', id: 'since-rwagmi', text: 'This release' }, '')).toBe('<a id="since-rwagmi"></a>\n\n## This release');
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

describe('generated Markdown', () => {
  const site = (href: string) => (href.startsWith(`${SITE}/`) ? href.slice(SITE.length) : null);
  const pages = DOC_PAGES.map((p) => ({ slug: p.slug, md: pageToMarkdown(p.slug) }));

  it('links only to Markdown pages and anchors that exist, and to site routes that exist', () => {
    const app = path.resolve(import.meta.dirname, '../../app');
    const anchors = new Map(pages.map((p) => [docMarkdownPath(p.slug), new Set([...p.md.matchAll(/^<a id="([\w-]+)"><\/a>$/gm)].map((m) => m[1]))]));
    let checked = 0;
    for (const { slug, md } of pages) {
      for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
        const local = site(m[1]!);
        expect(/^https?:\/\//.test(m[1]!), `${slug}: ${m[1]}`).toBe(true);
        if (!local) continue;
        checked++;
        const [route, hash] = local.split('#') as [string, string | undefined];
        if (route.startsWith('/docs')) {
          expect(anchors.has(route), `${slug}: ${m[1]}`).toBe(true);
          if (hash) expect(anchors.get(route)!.has(hash), `${slug}: ${m[1]}`).toBe(true);
        } else {
          const dir = path.join(app, route);
          const file = [path.join(dir, 'route.ts'), path.join(dir, 'page.tsx'), path.join(app, `${path.basename(route, '.xml')}.ts`)];
          expect(file.some((f) => existsSync(f)), `${slug}: ${m[1]}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('is well-formed: closed fences, even tables, no stray HTML', () => {
    for (const { slug, md } of pages) {
      // Fenced code is opaque: take it out, then look at what is left.
      const open = /^(`{3,})[\w-]*\n[\s\S]*?^\1$/gm;
      const prose = md.replace(open, '');
      expect(prose.match(/^`{3,}/gm), `${slug}: unclosed fence`).toBeNull();
      const text = prose.replace(/^<a id="[\w-]+"><\/a>$/gm, '');
      for (const line of text.split('\n')) {
        expect(line.replace(/`[^`]*`/g, ''), `${slug}: raw HTML`).not.toMatch(/<[a-z/]/i);
        expect(line.replace(/`[^`]*`/g, '').match(/\*\*/g)?.length ?? 0, `${slug}: bold: ${line}`).toSatisfy((n: number) => n % 2 === 0);
      }
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!/^\| .*(---:?) \|$/.test(line)) return;
        const cols = (s: string) => s.replace(/\\\|/g, '').split('|').length;
        expect(cols(lines[i - 1]!), `${slug}: header ${lines[i - 1]}`).toBe(cols(line));
        for (let j = i + 1; lines[j]?.startsWith('|'); j++) expect(cols(lines[j]!), `${slug}: row ${lines[j]}`).toBe(cols(line));
      });
      expect(text.match(/^# /gm), `${slug}: one title`).toHaveLength(1);
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

  it('links every docs page as Markdown and the full text with absolute bootr.fun URLs', () => {
    for (const p of DOC_PAGES) expect(txt).toContain(`- [${p.title}](${SITE}${docMarkdownPath(p.slug)}): ${p.description}`);
    expect(txt).toContain(`(${SITE}/llms-full.txt)`);
    expect(txt).not.toMatch(/\]\((?!https:\/\/)/);
    expect(txt).not.toMatch(/\/docs(\/[\w-]+)?(#[\w-]+)?\)/);
  });

  it('full text carries every page in reading order', () => {
    const full = llmsFullTxt();
    const at = DOC_PAGES.map((p) => full.indexOf(`\n# ${p.title}\n`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(full).toContain('swappers pay (1%)        $1,000');
  });
});
