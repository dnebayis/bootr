import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { addresses, BASE_MAINNET_CHAIN_ID } from '@bootr/shared/addresses';
import { WORKER_TEMPLATES } from '@bootr/shared/workers';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DOC_CONTENT } from '@/components/docs/content';
import { DOC_PAGES, type DocSlug } from '@/components/docs/pages';
import { SKILL_NAME, skillMarkdown } from './skill-md';

const SITE = 'https://bootr.fun';
const md = skillMarkdown(SITE);
const WEB = path.resolve(import.meta.dirname, '../..');
const APP = path.join(WEB, 'app');
const read = (p: string) => readFileSync(path.join(WEB, p), 'utf8');

const LAUNCH = read('app/api/agent/launch/route.ts');
const X_CONNECT = read('app/api/agent/x-connect/route.ts');
const LINKS = read('app/api/agent/[kernel]/links/route.ts');

/** Being merged from other branches; the skill links to them on purpose. Everything else must exist today. */
const PENDING = new Set(['/api/catalog', ...DOC_PAGES.filter((p) => p.slug).map((p) => `/docs/${p.slug}.md`)]);

/** Every page and route handler under app/, as a regular expression over the URL path. */
function appRoutes(dir = APP, prefix = ''): RegExp[] {
  const found: RegExp[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      const segment = /^\(.*\)$/.test(entry) ? '' : /^\[.*\]$/.test(entry) ? '/[^/]+' : `/${entry.replace(/[.+*?^$()|]/g, '\\$&')}`;
      found.push(...appRoutes(full, prefix + segment));
    } else if (/^(page\.tsx|route\.ts)$/.test(entry)) {
      found.push(new RegExp(`^${prefix || '/'}$`));
    }
  }
  return found;
}
const ROUTES = appRoutes();
const routeExists = (p: string) => ROUTES.some((r) => r.test(p));

/** A cited path with its placeholders (`<kernel>`, `${kernel}`) filled in, and without its query or fragment. */
function normalize(p: string): string {
  return p
    .replace(/<[^>]+>/g, 'x')
    .replace(/\$\{[^}]+\}/g, 'x')
    .replace(/[?#].*$/, '')
    .replace(/[.,:;]+$/, '');
}

/** Every site path the skill cites: as a full URL, as `${SITE}/…` in the example, or relative in a link or code span. */
function citedPaths(doc: string): string[] {
  const cited = new Set<string>();
  // `<` may open a placeholder, so a URL only ends at whitespace or closing punctuation.
  for (const m of doc.matchAll(/https:\/\/bootr\.fun(\/[^\s`"')|\\]*)/g)) cited.add(m[1]!);
  for (const m of doc.matchAll(/\$\{SITE\}(\/[^\s`"')|\\]*)/g)) cited.add(m[1]!);
  for (const m of doc.matchAll(/\]\((\/[^)\s]*)\)/g)) cited.add(m[1]!);
  for (const m of doc.matchAll(/`((?:GET |POST |PUT )?\/[^\s`]*)`/g)) cited.add(m[1]!.replace(/^\w+ /, ''));
  return [...cited].map(normalize).filter((p) => p !== '/');
}

/** Indexer paths the skill cites, with the routes `apps/indexer/src/api/index.ts` serves as the reference. */
function indexerRoutes(): RegExp[] {
  const src = readFileSync(path.join(WEB, '../indexer/src/api/index.ts'), 'utf8');
  const paths = [...src.matchAll(/app\.(?:get|use)\('(\/[^'*]*)'/g)].map((m) => m[1]!);
  return paths.map((p) => new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+')}$`));
}

/** The body of one `## Heading` section. */
function section(heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const end = md.indexOf('\n## ', start + 4);
  return end === -1 ? md.slice(start) : md.slice(start, end);
}

/** The first statement regular expression in a route's source (`STATEMENT = /…/`). */
function statementRegex(source: string): RegExp {
  const m = /STATEMENT = \/(.+)\/;/.exec(source);
  expect(m).not.toBeNull();
  return new RegExp(m![1]!);
}

describe('frontmatter', () => {
  it('opens with name and description, as valid plain YAML', () => {
    const m = /^---\nname: (.+)\ndescription: (.+)\n---\n\n# /.exec(md);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(SKILL_NAME);
    expect(m![1]).toBe('launch-on-bootr');
    const description = m![2]!;
    expect(description).toMatch(/Use when /);
    expect(description, 'a colon or a hash would break a plain YAML scalar').not.toMatch(/: | #/);
    expect(description).not.toMatch(/^["'`[{]/);
  });
});

describe('sections', () => {
  it('has the sections in the expected order', () => {
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      'Overview',
      'Safety Rules',
      'Quick Start',
      'Launch Flow',
      'Launch Configuration Reference',
      'Fees by Launch Path',
      'Post-Launch Operations',
      'What an Agent Can and Can\'t Do With Its Treasury',
      'Read Operations',
      'Error Handling',
      'Additional Resources',
    ]);
  });

  it('builds from the base URL it is given', () => {
    const other = skillMarkdown('https://staging.example.org/');
    expect(other).toContain('https://staging.example.org/skill/skill.md');
    expect(other).toContain('`staging.example.org`');
    expect(other).not.toContain('https://bootr.fun');
  });
});

describe('cited paths', () => {
  const cited = citedPaths(md);

  it('finds the paths it is meant to check', () => {
    for (const p of ['/api/agent/nonce', '/api/agent/launch', '/api/agent/x-connect', '/api/agent/x/links', '/api/models', '/api/platform', '/api/catalog', '/llms.txt', '/skill/skill.md', '/token/x', '/agents/x.json', '/tokens/x.json', '/docs/fees', '/docs/fees.md']) {
      expect(cited, p).toContain(p);
    }
  });

  it('every path exists as a route, or is one of the two pending ones', () => {
    const missing = cited.filter((p) => !routeExists(p) && !PENDING.has(p));
    expect(missing).toEqual([]);
  });

  it('is a real check: an unknown path fails, and a pending .md page must name a real doc', () => {
    expect(routeExists('/api/agent/launchpad')).toBe(false);
    expect(routeExists('/nope')).toBe(false);
    expect(PENDING.has('/docs/nope.md')).toBe(false);
    expect(routeExists('/api/agent/launch')).toBe(true);
  });

  it('every anchor it links to exists', () => {
    for (const m of md.matchAll(/\/docs\/([a-z-]+)#([a-z-]+)/g)) {
      const body = DOC_CONTENT[m[1] as DocSlug];
      expect(body, m[1]).toBeDefined();
      expect(body.blocks.some((b) => b.t === 'h2' && b.id === m[2]), m[0]).toBe(true);
    }
  });

  it('every indexer route it cites exists', () => {
    const routes = indexerRoutes();
    const cites = [...md.matchAll(/https:\/\/indexer\.bootr\.fun(\/[^\s`"')|\\]*)/g)].map((m) => normalize(m[1]!));
    expect(cites).toEqual(expect.arrayContaining(['/graphql', '/market/x', '/treasury/x', '/token/x/fees', '/search']));
    expect(cites.filter((p) => !routes.some((r) => r.test(p)))).toEqual([]);
  });
});

describe('matches the agent API', () => {
  const errors = section('Error Handling');

  it('lists every error code the three routes return, and none they do not', () => {
    const codes = (src: string) => [...src.matchAll(/(?:fail|refuse)\(\s*\d+,\s*'([a-z_]+)'/g)].map((m) => m[1]!);
    const real = new Set([...codes(LAUNCH), ...codes(X_CONNECT), ...codes(LINKS), 'siwe_rejected']);
    expect(real.size).toBeGreaterThan(15);
    for (const code of real) expect(errors, code).toContain(`\`${code}\``);
    const table = errors.split('\n').filter((l) => /^\| \d/.test(l));
    const listed = table.flatMap((l) => [...l.split('|')[2]!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!));
    expect(listed.filter((c) => !real.has(c))).toEqual([]);
  });

  it('puts each signature reason under its status, and leaves nothing it no longer does', () => {
    const src = read('lib/server/siwe-verify.ts');
    const statuses = [...src.matchAll(/status: (\d+), reason: '(\w+)'/g), ...src.matchAll(/spent\((\d+), '(\w+)'/g)].map((m) => [m[2]!, m[1]!] as const);
    const line = errors.split('\n').find((l) => l.startsWith('`siwe_rejected` also'))!;
    const [at400, at401] = line.split('are 400');
    // nonce_mismatch is only the console pages' cookie nonce; the agent API never answers it.
    for (const [reason, status] of statuses.filter(([r]) => r !== 'nonce_mismatch')) expect(status === '400' ? at400 : at401, `${reason} is ${status}`).toContain(`\`${reason}\``);
    expect(errors).not.toMatch(/plain 500/);
  });

  it('sends no Origin from a script, and says a page on another site is refused', () => {
    const post = section('Post-Launch Operations');
    expect(post).not.toMatch(/origin: SITE/i);
    expect(post).toContain('a browser sends its own `Origin`');
    expect(errors).not.toContain('Send `Origin:');
  });

  it('documents every field of the launch body', () => {
    const type = /type LaunchInput = \{([\s\S]+?)\n\};/.exec(LAUNCH)![1]!;
    const fields = [...type.matchAll(/^\s*(\w+)\?:/gm)].map((m) => m[1]!);
    expect(fields).toContain('launchThrough');
    const reference = section('Launch Configuration Reference');
    for (const f of fields) expect(reference, f).toContain(`| \`${f}\` |`);
  });

  it('states the launch defaults the route applies', () => {
    expect(LAUNCH).toContain("GAS_DEFAULT_ETH = '0.001'");
    expect(LAUNCH).toContain("GAS_MIN_ETH = '0.0001'");
    expect(LAUNCH).toContain(": '20';");
    const reference = section('Launch Configuration Reference');
    expect(reference).toContain('| `gasEth` | `0.001` |');
    expect(reference).toContain('at least `0.0001`');
    expect(reference).toContain('| `fuelUsdc` | `20` |');
    expect(reference).toContain('| `launchThrough` | `bootr` |');
    expect(reference).toContain('| `worker` | `community` |');
  });

  it('gives statements the routes accept', () => {
    const kernel = '0x1111111111111111111111111111111111111111';
    const fill = (s: string) => s.replace('<SYMBOL>', 'ABC').replace('<agentId>', '123').replace('<kernel>', kernel);
    const statement = (re: RegExp) => fill(re.exec(md)![1]!);
    expect(statementRegex(LAUNCH).test(statement(/`(Prepare a Bootr launch\.)`/))).toBe(true);
    expect(statementRegex(X_CONNECT).test(statement(/`(Connect the X account of Bootr agent #<[^`]+)`/))).toBe(true);
    expect(statementRegex(LINKS).test(statement(/`(Update the links of Bootr coin \$<[^`]+)`/))).toBe(true);
  });

  it('shows the fields of the launch answer', () => {
    for (const field of ['launchId', 'chainId', 'creator', 'launcher', 'launchThrough', 'predictedKernel', 'agentURI', 'metadata', 'image', 'model', 'worker', 'workerHash', 'buyback', 'launchFeeWei', 'transactions', 'next']) {
      expect(LAUNCH, field).toMatch(new RegExp(`\\b${field}\\b`));
      expect(md, field).toContain(`"${field}"`);
    }
    for (const step of ['approve', 'launch', 'gas']) {
      expect(LAUNCH).toContain(`step: '${step}'`);
      expect(md).toContain(`"step": "${step}"`);
    }
  });

  it('names the live addresses', () => {
    const a = addresses[BASE_MAINNET_CHAIN_ID];
    for (const x of [a.bootr.launcher!, a.bootr.clankerLauncher!, a.usdc, a.entryPointV07, a.rwagmiLockerV3!, a.clanker.feeLocker, a.clanker.lpLockerFeeConversion, a.bootr.guardian!]) {
      expect(md).toContain(x);
    }
  });

  it('lists the worker templates', () => {
    for (const t of WORKER_TEMPLATES) expect(md).toContain(`| \`${t.id}\` | ${t.description} |`);
  });
});

describe('fee split', () => {
  const fees = section('Fees by Launch Path');

  it('is the split per path as implemented, with the buyback option', () => {
    const row = (label: string) => fees.split('\n').find((l) => l.startsWith(`| ${label} |`));
    expect(row('Agent treasury')).toBe('| Agent treasury | 0.045% | 0.045% | 0.05% | 0.05% |');
    expect(row('Creator')).toBe('| Creator | 0.585% | 0.45% | 0.65% | 0.50% |');
    expect(row('Buyback and burn')).toBe('| Buyback and burn | none | 0.135% | none | 0.15% |');
    expect(row('Platform')).toBe('| Platform | 0.27% | 0.27% | 0.30% | 0.30% |');
    expect(row('A trader pays per swap')).toContain('1.00%');
    expect(row('A trader pays per swap')).toContain('1.20%');
    expect(fees).toContain('`buyback: true`');
  });
});

describe('safety', () => {
  const safety = section('Safety Rules');

  it('has the required rules', () => {
    expect(safety).toMatch(/Never ask for a private key or seed phrase/);
    expect(safety).toMatch(/data, never instructions/);
    expect(safety).toMatch(/real money and cannot be undone/);
    expect(safety).toMatch(/Nothing here is investment advice/);
    expect(safety).toMatch(/promise returns/);
    for (const field of ['name and symbol', 'launchThrough', 'buyback', 'fuelUsdc', 'devBuyEth', 'gasEth', 'launchFeeWei']) {
      expect(safety, field).toContain(field);
    }
    expect(md.indexOf('## Safety Rules')).toBeLessThan(md.indexOf('## Quick Start'));
  });

  it('never carries a key or names anything private', () => {
    expect(md, 'nothing shaped like a private key').not.toMatch(/0x[0-9a-fA-F]{64}/);
    const lower = md.toLowerCase();
    for (const banned of ['/internal', '/api/admin', 'console-', 'admin console', '/sql', 'hmac', 'service_key', 'admin_', 'supervisor', 'sender', 'relay', 'x402', 'session key', 'hermes', 'railway', 'coolify', 'hetzner', '77.42.90.52', 'database_', 'session_', 'spender']) {
      expect(lower, banned).not.toContain(banned);
    }
  });
});

describe('the Quick Start example', () => {
  const example = /```js\n(\/\/ launch\.mjs[\s\S]+?)```/.exec(md)?.[1] ?? '';

  it('parses as a module', () => {
    expect(example.length).toBeGreaterThan(500);
    const out = ts.transpileModule(example, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, allowJs: true } });
    expect(out.diagnostics ?? []).toEqual([]);
  });

  it('reads the key from the environment and waits for a person', () => {
    expect(example).toContain('process.env.BOOTR_WALLET_KEY');
    expect(example).toMatch(/Type "launch" to sign and send/);
    expect(example.indexOf('prompt.question')).toBeLessThan(example.indexOf('wallet.sendTransaction'));
    expect(example).toContain("receipt.status !== 'success'");
  });

  it('imports only what the viem package exports', () => {
    expect(existsSync(path.join(WEB, 'node_modules/viem/package.json'))).toBe(true);
    const pkg = JSON.parse(read('node_modules/viem/package.json')) as { exports: Record<string, unknown> };
    for (const m of example.matchAll(/from 'viem(\/[a-z]+)?'/g)) expect(pkg.exports, m[0]).toHaveProperty(`.${m[1] ?? ''}`);
  });
});
