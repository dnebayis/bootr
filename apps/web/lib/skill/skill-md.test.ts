import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { addresses, BASE_MAINNET_CHAIN_ID } from '@bootr/shared/addresses';
import { WORKER_TEMPLATES } from '@bootr/shared/workers';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DOC_CONTENT } from '@/components/docs/content';
import { DOC_PAGES, type DocSlug } from '@/components/docs/pages';
import { SKILL_NAME, skillMarkdown } from './skill-md';
import {
  creatorPoolBps,
  DEFAULT_DEV_BUY_SLIPPAGE_PCT,
  DEFAULT_TAX_PCT,
  defaultTokenSettings,
  FALLBACK_V5_BOUNDS,
  MAX_DEV_BUY_SLIPPAGE_PCT,
  MIN_DIVIDEND_HOLDING,
  pairedAssetsFor,
  V5_STRING_CAPS,
  viewPins,
  type TokenSettingsInput,
} from '@/lib/token-settings';
import { clankerLauncherV5Abi } from '@/lib/abi/clankerLauncherV5.abi';

const SITE = 'https://bootr.fun';
const md = skillMarkdown(SITE);
const WEB = path.resolve(import.meta.dirname, '../..');
const APP = path.join(WEB, 'app');
const read = (p: string) => readFileSync(path.join(WEB, p), 'utf8');

const LAUNCH = read('app/api/agent/launch/route.ts');
const X_CONNECT = read('app/api/agent/x-connect/route.ts');
const LINKS = read('app/api/agent/[kernel]/links/route.ts');
const CLAIM = read('app/api/agent/claim/[id]/route.ts');

/**
 * The swap route's own refusals (the Trade panel's `lib/swap/errors.ts` codes it passes on, and the ones of
 * `lib/swap/prepare.ts`, which arrives with the route from another branch). The skill's error table lists them; the
 * test below checks each against the source that answers it, as far as that source is here yet.
 */
const SWAP_PANEL_CODES = ['no_balance', 'no_liquidity', 'no_pool', 'launch_window'];
const SWAP_ROUTE_CODES = ['not_available', 'not_tradable', 'trading_not_open', 'fee_too_high', 'no_quote'];

/** Being merged from other branches; the skill links to them on purpose. Everything else must exist today. */
const PENDING = new Set(['/api/catalog', '/api/agent/swap', ...DOC_PAGES.filter((p) => p.slug).map((p) => `/docs/${p.slug}.md`)]);

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
      'Developer Tools',
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

  it('lists every error code the four routes return, and none they do not', () => {
    const codes = (src: string) => [...src.matchAll(/(?:fail|refuse)\(\s*\d+,\s*'([a-z_]+)'/g)].map((m) => m[1]!);
    const real = new Set([...codes(LAUNCH), ...codes(X_CONNECT), ...codes(LINKS), ...codes(CLAIM), 'siwe_rejected', ...SWAP_PANEL_CODES, ...SWAP_ROUTE_CODES]);
    expect(real.size).toBeGreaterThan(15);
    for (const code of real) expect(errors, code).toContain(`\`${code}\``);
    const table = errors.split('\n').filter((l) => /^\| \d/.test(l));
    const listed = table.flatMap((l) => [...l.split('|')[2]!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!));
    expect(listed.filter((c) => !real.has(c))).toEqual([]);
  });

  it('names only swap refusals the swap route answers', () => {
    const panel = read('lib/swap/errors.ts');
    for (const code of SWAP_PANEL_CODES) expect(panel, code).toContain(`'${code}'`);
    // The route's own file arrives with the route; until then its codes are the build contract's.
    const prepare = path.join(WEB, 'lib/swap/prepare.ts');
    if (existsSync(prepare)) for (const code of SWAP_ROUTE_CODES) expect(readFileSync(prepare, 'utf8'), code).toContain(`error: '${code}'`);
    const swap = section('Post-Launch Operations');
    for (const code of [...SWAP_PANEL_CODES, ...SWAP_ROUTE_CODES]) expect(swap, code).toContain(`\`${code}\``);
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

  it('documents every Clanker v5 token setting with the bounds the API checks', () => {
    const reference = section('Launch Configuration Reference');
    const fields = Object.keys(defaultTokenSettings('0x1111111111111111111111111111111111111111')) as (keyof TokenSettingsInput)[];
    for (const f of fields) expect(reference, f).toMatch(new RegExp(`\\| [^|]*\`${f}\`[^|]*\\|`));
    const b = FALLBACK_V5_BOUNDS;
    expect(reference).toContain(`${b.minTaxBps / 10_000} to ${b.maxTaxBps / 10_000}, each side on its own`);
    expect(reference).toContain(`| \`buyTaxPct\`, \`sellTaxPct\` | \`${DEFAULT_TAX_PCT}\` |`);
    expect(reference).toContain(`The agent keeps ${b.agentShareBps / 100}% and the platform ${b.platformShareBps / 100}%, locked`);
    expect(reference).toContain(`together take at most ${creatorPoolBps(b) / 100}%`);
    expect(reference).toContain(`1 to ${b.maxRewardRows} rows`);
    expect(reference).toContain(`up to ${b.maxRewardRows - 1} more`);
    expect(reference).toContain(`| \`minDividendHolding\` | \`${MIN_DIVIDEND_HOLDING}\` |`);
    for (const a of pairedAssetsFor('agent')) expect(reference).toContain(`\`${a.symbol}\``);
    // The route parses `token` with the same module and refuses it off v5.
    expect(LAUNCH).toContain('parseTokenSettings(l.token, creator, terms.bounds)');
    expect(LAUNCH).toContain("return invalid('token', `token settings apply to Clanker v5 launches only");
  });

  it('documents the v5 pins, the byte caps and the dev buy’s minimum from the code', () => {
    const reference = section('Launch Configuration Reference');
    // every pin the settings builder fills, by its struct name
    for (const pin of Object.keys(viewPins())) expect(reference, pin).toContain(`\`${pin}\``);
    const launch = clankerLauncherV5Abi.find((e) => e.type === 'function' && e.name === 'launch')!;
    const struct = (launch.inputs[1] as { components: readonly { name: string }[] }).components.map((c) => c.name);
    expect(struct.slice(-5)).toEqual(Object.keys(viewPins()));
    // the caps, in bytes, as the contract and lib/token-settings.ts have them
    for (const [k, v] of Object.entries(V5_STRING_CAPS)) expect(reference, k).toContain(`${v.toLocaleString('en-US')}`);
    expect(reference).toContain(`| \`devBuySlippagePct\` | \`${DEFAULT_DEV_BUY_SLIPPAGE_PCT}\` |`);
    expect(reference).toContain(`0.1 to ${MAX_DEV_BUY_SLIPPAGE_PCT}`);
    // the route applies them: default slippage, the quote, the caps
    expect(LAUNCH).toContain('DEFAULT_DEV_BUY_SLIPPAGE_PCT');
    expect(LAUNCH).toContain('minDevBuyOutFrom(quotedOut, slippagePct)');
    expect(LAUNCH).toContain('launchStringProblems(');
    // every launcher revert the skill names exists in the ABI (StaleConfig is Clanker's, through the launcher)
    const errorNames = new Set<string>(clankerLauncherV5Abi.filter((e) => e.type === 'error').map((e) => e.name));
    for (const name of ['LaunchFeeAboveMax', 'LockedSharesChanged', 'MinDevBuyOutRequired', 'StringTooLong', 'InsufficientValue', 'InsufficientFuel', 'EmptyNameOrSymbol']) {
      expect(errorNames.has(name), name).toBe(true);
      expect(md, name).toContain(`\`${name}`);
    }
    expect(md).toContain('`StaleConfig`');
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
    expect(LAUNCH).toContain("l.fuelUsdc === undefined ? '20'");
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

  it('warns of the anti-sniper fee on a new Clanker pool, and points at the dev buy', () => {
    expect(fees).toMatch(/anti-sniper fee/);
    expect(fees).toMatch(/about 63 to 71%/);
    expect(fees).toMatch(/about the first half second/);
    expect(fees).toMatch(/about 16 seconds/);
    expect(fees).toMatch(/`devBuyEth` runs inside the launch transaction/);
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

  it('offers both wallets, tells an agent with none to make its own on its machine, and shows only the address', () => {
    expect(safety).toMatch(/has no wallet, make one there/);
    expect(safety).toMatch(/the address is the only thing you show/);
    const quick = section('Quick Start');
    const choice = quick.slice(quick.indexOf('### Which wallet launches'), quick.indexOf('### If you have no wallet yet'));
    expect(choice).toMatch(/Never answer "go to the launch page" and stop/);
    expect(choice).toContain(`${SITE}/launch`);
    expect(choice).toMatch(/\*\*The user's own wallet\.\*\*/);
    expect(choice).toMatch(/\*\*A wallet of your own\.\*\*/);
    expect(choice).toMatch(/ask which they want/);
    const noWallet = quick.slice(quick.indexOf('### If you have no wallet yet'), quick.indexOf('```js'));
    expect(noWallet).toContain('cast wallet new');
    expect(noWallet).toContain('generatePrivateKey');
    expect(noWallet).toContain('BOOTR_WALLET_KEY=0x…');
    expect(noWallet).toContain('chmod 600 .env');
    expect(noWallet).toContain('.gitignore');
    expect(noWallet).toMatch(/Tell the user the address, nothing more/);
    expect(md).toContain('node --env-file=.env launch.mjs');
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

  it('enforces the checks of step 4 before anyone is asked to sign', () => {
    const a = addresses[BASE_MAINNET_CHAIN_ID];
    const checks = example.slice(example.indexOf('// Step 4'), example.indexOf('prompt.question'));
    expect(checks).toContain('prepared.mock');
    expect(checks).toContain('prepared.chainId !== base.id');
    expect(checks).toContain('same(prepared.creator, account.address)');
    expect(checks).toContain('same(prepared.launcher, launcher)');
    expect(checks).toContain('same(tx.to, contractOf[tx.step])');
    for (const x of [a.bootr.launcher!, a.bootr.clankerLauncher!, a.usdc, a.entryPointV07]) expect(checks).toContain(x);
    // A step this list does not name is refused, not sent.
    for (const step of LAUNCH.matchAll(/step: '(\w+)'/g)) expect(checks).toContain(`${step[1]}: `);
  });

  it('imports only what the viem package exports', () => {
    expect(existsSync(path.join(WEB, 'node_modules/viem/package.json'))).toBe(true);
    const pkg = JSON.parse(read('node_modules/viem/package.json')) as { exports: Record<string, unknown> };
    for (const m of example.matchAll(/from 'viem(\/[a-z]+)?'/g)) expect(pkg.exports, m[0]).toHaveProperty(`.${m[1] ?? ''}`);
  });
});
