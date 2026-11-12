import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { listCredentials, saveCredential } from '@bootrfun/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { COIN, SECOND_COIN, startFakeSite, type FakeSite } from '../../mcp/test/fake-supervisor.mjs';
import { run } from './commands.js';
import { OWN_USAGE, runOwn, type OwnIo } from './own-commands.js';

/**
 * `bootr own …` against the fake public API of the contract: in-process with a clock and a shell that the test holds,
 * and as the built command a user runs. No command thinks or posts; `watch` only starts the creator's own command.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const BIN = path.resolve(import.meta.dirname, '../dist/cli.js');
const exec = promisify(execFile);

let site: FakeSite;
let dir: string;
let env: Record<string, string | undefined>;
let notices: string[];
let sleeps: number[];
let ran: { command: string; env: Record<string, string | undefined> }[];
let clock: number;
let onSleep: (n: number) => void;
let exitCode: number;

const io = (): OwnIo => ({
  notice: (text) => void notices.push(text),
  sleep: async (ms) => {
    sleeps.push(ms);
    clock += ms;
    onSleep(sleeps.length);
  },
  exec: async (command, childEnv) => {
    ran.push({ command, env: childEnv });
    return exitCode;
  },
  now: () => clock,
});
const own = (...argv: string[]) => runOwn(argv, env, io());
const stored = () => listCredentials(site.url, { file: env.BOOTR_CREDENTIALS_FILE! });
const approveAll = () => {
  for (const grant of site.backend.grants.values()) {
    if (grant.status === 'pending') site.backend.connectApprove({ userCode: grant.userCode, creator: site.backend.creator, target: { kind: 'coin', kernel: COIN.kernel, agentId: COIN.agentId } });
  }
};

beforeAll(async () => {
  site = await startFakeSite();
});
afterAll(() => site.close());

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bootr-cli-'));
  env = { BOOTR_SITE_URL: site.url, BOOTR_CREDENTIALS_FILE: path.join(dir, 'cfg', 'credentials.json'), BOOTR_PICTURES_DIR: path.join(dir, 'pictures') };
  notices = [];
  sleeps = [];
  ran = [];
  clock = Date.now();
  exitCode = 0;
  onSleep = () => {};
  site.seen.length = 0;
  site.backend.grants.clear();
  site.backend.clients.clear();
  Object.assign(site.backend, { turn: null, runner: 'own', due: { social: true, treasury: false, judge: false } });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function connected(coin = COIN, label = 'Test') {
  const credential = site.backend.issueCredential(coin, label);
  await saveCredential(site.url, { credential, clientId: `cli_${label.toLowerCase().padEnd(16, '0')}`, label, target: { kind: 'coin', coin }, expiresAt: '2027-01-01T00:00:00.000Z' }, { file: env.BOOTR_CREDENTIALS_FILE! });
  return credential;
}

describe('bootr own connect', () => {
  it('prints the link and the code, waits for the approval and keeps the credential in its file only', async () => {
    onSleep = (n) => {
      if (n === 2) approveAll();
    };
    const out = await own('connect', '--coin', 'OWL', '--label', 'My laptop');
    const [grant] = [...site.backend.grants.values()];
    expect(grant).toMatchObject({ clientName: 'My laptop', coinHint: 'OWL' });
    expect(notices[0]).toContain(`${site.url}/connect/${grant!.userCode}`);
    expect(notices[0]).toContain(`Code: ${grant!.userCode}`);
    expect(notices[0]).toContain('the page must show this same code');
    // It polls a little slower than the site asks for.
    expect(sleeps).toEqual([6000, 6000]);
    expect(out.data).toEqual({
      connected: true,
      coin: '$OWL',
      kernel: COIN.kernel,
      draftId: null,
      label: 'My laptop',
      clientId: expect.stringMatching(/^cli_[0-9a-f]{16}$/),
      expiresAt: expect.any(String),
      credentialsFile: env.BOOTR_CREDENTIALS_FILE,
      picturesFolder: env.BOOTR_PICTURES_DIR,
    });
    const held = await stored();
    expect(held).toHaveLength(1);
    const printed = JSON.stringify([out, notices]);
    expect(printed).not.toContain(held[0]!.credential);
    expect(printed).not.toContain('bootr_agt_');
    expect(printed).not.toContain('deviceCode');
    if (process.platform !== 'win32') expect((await stat(env.BOOTR_CREDENTIALS_FILE!)).mode & 0o777).toBe(0o600);
    expect((await stat(env.BOOTR_PICTURES_DIR!)).isDirectory()).toBe(true);
    // The site saw the device code in the poll's body, never in a URL.
    for (const s of site.seen) expect(s.path).toMatch(/^\/api\/(catalog|agent\/connect\/(start|token)|agent\/run\/status)$/);
  });

  it('says so when this machine is already connected, and starts over when the connection was ended elsewhere', async () => {
    await connected();
    const already = await own('connect');
    expect(already).toMatchObject({ data: { connected: true, coin: '$OWL' }, notice: expect.stringContaining('Already connected') });
    expect(site.backend.grants.size).toBe(0);
    site.backend.revokeClients(COIN.agentId, { all: true });
    onSleep = () => approveAll();
    const again = await own('connect');
    expect(again.data).toMatchObject({ connected: true, coin: '$OWL', label: 'bootr CLI' });
    expect(site.backend.grants.size).toBe(1);
    expect(await stored()).toHaveLength(1);
  });

  it('gives up when nobody approves in time, and saves nothing', async () => {
    await expect(own('connect')).rejects.toMatchObject({ code: 'grant_expired' });
    expect(sleeps.length).toBe(100);
    expect(await stored()).toEqual([]);
  });

  it('ends a connection it cannot keep: an approval that arrives when the file cannot be written leaves no live client', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const locked = path.join(dir, 'locked');
    await mkdir(locked, { mode: 0o500 });
    env.BOOTR_CREDENTIALS_FILE = path.join(locked, 'credentials.json');
    onSleep = () => approveAll();
    await expect(own('connect')).rejects.toMatchObject({ code: 'EACCES' });
    await chmod(locked, 0o700);
    expect([...site.backend.clients.values()].map((c) => c.revokedAt !== null)).toEqual([true]);
    expect(JSON.stringify(notices)).not.toContain('bootr_agt_');
  });

  it('keeps waiting when it asked a moment too soon', async () => {
    onSleep = (n) => {
      if (n === 1) site.backend.failNext('slow_down', { retryAt: new Date().toISOString() });
      if (n === 2) approveAll();
    };
    expect((await own('connect')).data).toMatchObject({ connected: true });
    // One poll was told to slow down, the next one was answered.
    expect(sleeps).toHaveLength(2);
    expect(site.seen.filter((s) => s.path === '/api/agent/connect/token')).toHaveLength(2);
  });
});

describe('bootr own status and due', () => {
  it('print what the server says', async () => {
    await connected();
    expect((await own('status')).data).toMatchObject({ coin: COIN, runner: 'own', postsLeftToday: 21 });
    expect((await own('due')).data).toMatchObject({ social: { due: true }, treasury: { due: false } });
    expect(site.seen.filter((s) => s.path.startsWith('/api/agent/run/')).every((s) => /^Bearer bootr_agt_/.test(String(s.headers.authorization)))).toBe(true);
  });

  it('ask for the coin when this machine holds two, and take it by symbol or address', async () => {
    await connected();
    await connected(SECOND_COIN, 'Other');
    await expect(own('status')).rejects.toMatchObject({ code: 'coin_required' });
    expect((await own('status', '--coin', '$fox')).data).toMatchObject({ coin: SECOND_COIN });
    expect((await own('due', '--coin', COIN.kernel)).data).toMatchObject({ coin: COIN });
    await expect(own('status', '--coin', 'CAT')).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('wait for an agent that is busy and ask once more', async () => {
    await connected();
    site.backend.failNext('runtime_busy', { retryAt: new Date(clock + 1500).toISOString() });
    expect((await own('status')).data).toMatchObject({ coin: COIN });
    expect(sleeps).toEqual([1500]);
    site.backend.failNext('runtime_busy', { retryAt: new Date(clock + 500).toISOString() });
    site.backend.failNext('runtime_busy', { retryAt: new Date(clock + 500).toISOString() });
    await expect(own('due')).rejects.toMatchObject({ code: 'runtime_busy' });
  });

  it('say not_connected on a machine that never connected', async () => {
    await expect(own('due')).rejects.toMatchObject({ code: 'not_connected', status: null });
    expect(site.seen.filter((s) => s.path.startsWith('/api/agent/run/'))).toHaveLength(0);
  });
});

describe('bootr own watch', () => {
  it('runs the creator’s command when something is due, with the roles and without the credential', async () => {
    const credential = await connected();
    site.backend.due.treasury = true;
    const out = await own('watch', '--exec', 'claude -p "/bootr-turn" --allowedTools "mcp__bootr__*"', '--once');
    expect(out.data).toEqual({ ran: 1, exitCode: 0, roles: ['social', 'treasury'] });
    expect(ran).toHaveLength(1);
    // The command is the creator's own words, passed through untouched.
    expect(ran[0]!.command).toBe('claude -p "/bootr-turn" --allowedTools "mcp__bootr__*"');
    expect(ran[0]!.env.BOOTR_DUE_ROLES).toBe('social,treasury');
    expect(JSON.stringify(ran[0]!.env)).not.toContain(credential);
    expect(JSON.stringify([out, notices])).not.toContain('bootr_agt_');
    expect(notices[0]).toContain('Watching $OWL');
  });

  it('waits until the server’s next check while nothing is due, never less than 20 seconds', async () => {
    await connected();
    site.backend.due.social = false;
    onSleep = (n) => {
      if (n === 3) site.backend.due.social = true;
    };
    await own('watch', '--exec', 'true', '--once');
    // The fake says "look again in 20 seconds"; three waits, then the run.
    expect(sleeps).toHaveLength(3);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(20_000);
    expect(ran).toHaveLength(1);
    expect(site.seen.filter((s) => s.path === '/api/agent/run/due')).toHaveLength(4);
  });

  it('keeps going after a command that failed, and after a busy answer, without a tight loop', async () => {
    await connected();
    exitCode = 3;
    let calls = 0;
    onSleep = () => {
      calls += 1;
      if (calls === 1) site.backend.failNext('rate_limited', { retryAt: new Date(clock + 45_000).toISOString() });
      if (calls === 3) throw new Error('stop the watch');
    };
    await expect(own('watch', '--exec', './run-agent.sh')).rejects.toThrow('stop the watch');
    // Run, wait 20 seconds, be told to wait 45 more, run again.
    expect(ran).toHaveLength(2);
    expect(notices.join('\n')).toContain('exit code 3');
    expect(notices.join('\n')).toContain('rate_limited: looking again later.');
    expect(sleeps[0]).toBe(20_000);
    expect(sleeps[1]).toBe(45_000);
  });

  it('takes up an open turn, needs a command and a connection', async () => {
    await expect(own('watch', '--exec', 'true')).rejects.toMatchObject({ code: 'not_connected' });
    await connected();
    await expect(own('watch')).rejects.toThrow('watch needs --exec');
    await expect(own('watch', '--exec', '  ')).rejects.toThrow('watch needs --exec');
    site.backend.due.social = false;
    site.backend.turn = { turnId: `otn_${'1'.repeat(32)}`, role: 'social', clientId: 'x', reasons: [], stepsUsed: 2, stepBudget: 8, expiresAt: Date.now() + 600_000 };
    const out = await own('watch', '--exec', 'true', '--once');
    expect(out.data).toMatchObject({ ran: 1, roles: [] });
    expect(notices.join('\n')).toContain('an open social turn');
  });

  it('stops on a connection the creator ended', async () => {
    await connected();
    site.backend.revokeClients(COIN.agentId, { all: true });
    await expect(own('watch', '--exec', 'true')).rejects.toMatchObject({ code: 'credential_revoked' });
    expect(ran).toHaveLength(0);
  });
});

describe('bootr own disconnect', () => {
  it('ends the connection and forgets the credential', async () => {
    const credential = await connected();
    expect(await own('disconnect')).toMatchObject({ data: { ok: true } });
    expect(await stored()).toEqual([]);
    expect(await readFile(env.BOOTR_CREDENTIALS_FILE!, 'utf8')).not.toContain('bootr_agt_');
    expect(() => site.backend.runAs('status', credential)).toThrow('credential_revoked');
    await expect(own('disconnect')).rejects.toMatchObject({ code: 'not_connected' });
  });
});

describe('the words it takes', () => {
  it('prints its usage, and is listed in the command’s help', async () => {
    expect((await own()).text).toBe(OWN_USAGE);
    expect((await own('--help')).text).toBe(OWN_USAGE);
    const help = (await run(['--help'], env)).text!;
    for (const line of ['bootr own connect', 'bootr own status', 'bootr own due', 'bootr own watch --exec "<command>"', 'bootr own disconnect', 'bootr prepare claim', 'It never asks for a private key']) expect(help, line).toContain(line);
  });

  it('is reached through the command, before or after a --site', async () => {
    await connected();
    expect((await run(['own', 'status'], env)).data).toMatchObject({ coin: COIN });
    expect((await run(['own', 'status', '--site', site.url], { ...env, BOOTR_SITE_URL: undefined })).data).toMatchObject({ coin: COIN });
    expect((await run(['--site', site.url, 'own', 'status'], { ...env, BOOTR_SITE_URL: 'http://127.0.0.1:9' })).data).toMatchObject({ coin: COIN });
    // The older commands read `own` as a word like any other.
    await expect(run(['coin', 'own'], { ...env, BOOTR_SITE_URL: 'http://127.0.0.1:9' })).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('never takes a credential or a key, and no flag it does not know', async () => {
    const credential = await connected();
    site.seen.length = 0;
    await expect(own('status', '--coin', credential)).rejects.toThrow('No command takes one');
    await expect(own('watch', '--exec', `curl -H "Authorization: Bearer ${credential}" https://x`)).rejects.toThrow('No command takes one');
    await expect(own('status', '--coin', `0x${'ab'.repeat(32)}`)).rejects.toThrow('private key');
    await expect(own('status', '--credential', 'x')).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
    await expect(own('status', '--token', 'x')).rejects.toMatchObject({ code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
    await expect(own('fly')).rejects.toThrow('own takes: connect, status, due, watch or disconnect.');
    await expect(own('watch', 'claude', '-p')).rejects.toThrow();
    expect(site.seen).toHaveLength(0);
  });
});

describe('as the built command', () => {
  const cli = (args: string[], extra: Record<string, string> = {}) => exec(process.execPath, [BIN, ...args], { env: { ...process.env, ...(env as Record<string, string>), ...extra } });

  it('prints JSON on stdout, refusals on stderr with exit code 1, and never a credential', async () => {
    const refused = await cli(['own', 'status']).catch((e: { code: number; stderr: string; stdout: string }) => e);
    expect(refused).toMatchObject({ code: 1, stdout: '' });
    expect((refused as { stderr: string }).stderr).toMatch(/^not_connected: This client is not connected to a coin on /);
    const credential = await connected();
    const status = await cli(['own', 'status']);
    expect(JSON.parse(status.stdout)).toMatchObject({ coin: COIN, runner: 'own' });
    const due = await cli(['--site', site.url, 'own', 'due'], { BOOTR_SITE_URL: 'http://127.0.0.1:9' });
    expect(JSON.parse(due.stdout)).toMatchObject({ social: { due: true } });
    const watched = await cli(['own', 'watch', '--once', '--exec', `"${process.execPath}" -e "process.stdout.write('ROLES=' + process.env.BOOTR_DUE_ROLES)"`]);
    expect(watched.stdout).toContain('ROLES=social');
    expect(watched.stdout).toContain('"ran": 1');
    const gone = await cli(['own', 'disconnect']);
    expect(JSON.parse(gone.stdout)).toEqual({ ok: true });
    for (const out of [status, due, watched, gone]) expect(out.stdout + out.stderr).not.toContain(credential);
    const usage = await cli(['own', 'watch']).catch((e: { code: number; stderr: string }) => e);
    expect(usage).toMatchObject({ code: 2, stderr: expect.stringContaining('watch needs --exec') });
  });
});
