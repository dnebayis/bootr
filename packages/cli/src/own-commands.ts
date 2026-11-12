import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  BootrApiError,
  cleanText,
  coinLine,
  createBootr,
  CREDENTIAL_PREFIX,
  credentialsFile,
  CredentialsError,
  describeCredential,
  findCredential,
  KEY_REFUSAL,
  looksLikeKey,
  removeCredential,
  saveCredential,
  targetMatches,
  USER_CODE_RE,
  type Bootr,
  type DueView,
} from '@bootrfun/sdk';

/**
 * `bootr own …`: the commands around a coin's agent that runs in its creator's own AI client
 * (docs/design/byo-agent.md sections 2.6 and 5.4). None of them thinks or posts: they connect this machine, show what
 * the agent's server says, and `watch` starts a command of the creator's own when something is due, so any client that
 * can be started from a shell can be kept running.
 *
 * The credential of a connection is written to the credentials file (mode 0600) and read from it. It is never printed,
 * never taken as an argument and never passed to the command `watch` runs.
 */

export const OWN_USAGE = `
Your own agent (a coin's agent that thinks in your own AI client; these commands never think or post)
  bootr own connect [--coin <symbol|address>] [--label <name>]
                                       Connect this machine to a coin's agent: prints a link and a code, you
                                       approve in the browser with the wallet that launched the coin
  bootr own status [--coin <symbol|address>]
                                       Which coin, who runs its agent and what is left of today's allowances
  bootr own due [--coin <symbol|address>]
                                       What is due now, per role, and when to look again
  bootr own watch --exec "<command>" [--coin <symbol|address>] [--once]
                                       Wait until something is due, then run your command (for example your AI
                                       client in headless mode), and wait again
  bootr own disconnect [--coin <symbol|address>]
                                       End this machine's connection and forget its credential
`;

const OPTIONS = {
  site: { type: 'string' },
  coin: { type: 'string' },
  label: { type: 'string' },
  exec: { type: 'string' },
  once: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** The server asks for at least 20 seconds between two looks; a watch never looks more often, nor waits longer than this. */
const MIN_WAIT_MS = 20_000;
const MAX_WAIT_MS = 15 * 60_000;
const RETRY_WAIT_MS = 60_000;

export class OwnUsageError extends Error {}

export interface OwnIo {
  /** A line for the person, on stderr: stdout carries the JSON. */
  notice(text: string): void;
  sleep(ms: number): Promise<void>;
  /** Runs the creator's command through the shell and answers its exit code. */
  exec(command: string, env: Record<string, string | undefined>): Promise<number>;
  now(): number;
}

const defaultIo: OwnIo = {
  notice: (text) => void process.stderr.write(`${text}\n`),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exec: (command, env) =>
    new Promise((resolve) => {
      const child = spawn(command, { shell: true, stdio: 'inherit', env: env as NodeJS.ProcessEnv });
      child.on('error', () => resolve(127));
      child.on('exit', (code) => resolve(code ?? 1));
    }),
  now: () => Date.now(),
};

/** `runtime_busy` means the server is settling something for the agent: wait until it says and ask once more. */
async function patient<T>(call: () => Promise<T>, io: OwnIo): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof BootrApiError) || err.code !== 'runtime_busy') throw err;
    const wait = err.details.retryAt ? Date.parse(err.details.retryAt) - io.now() : 2000;
    if (!Number.isFinite(wait) || wait > 30_000) throw err;
    await io.sleep(Math.max(wait, 250));
    return call();
  }
}

function asApiError(err: unknown): unknown {
  return err instanceof CredentialsError ? new BootrApiError(err.message, err.code, null) : err;
}

function picturesDir(env: Record<string, string | undefined>): string {
  const named = env.BOOTR_PICTURES_DIR?.trim();
  return named ? path.resolve(named) : path.join(homedir(), 'bootr-pictures');
}

async function connect(bootr: Bootr, values: { coin?: string; label?: string }, env: Record<string, string | undefined>, io: OwnIo) {
  const file = await credentialsFile({ env });
  const held = await findCredential(bootr.siteUrl, values.coin, { env }).catch((err: unknown) => {
    if (err instanceof CredentialsError && err.code !== 'credentials_unreadable') return null;
    throw asApiError(err);
  });
  if (held) {
    const live = await bootr.ownStatus({ credential: held.credential }).then(
      () => true,
      (err: unknown) => {
        if (err instanceof BootrApiError && err.code === 'coin_not_launched') return true;
        if (err instanceof BootrApiError && ['unauthorized', 'credential_revoked', 'credential_expired'].includes(err.code)) return false;
        throw err;
      },
    );
    if (live) return { data: { connected: true, ...describeCredential(held), credentialsFile: file }, notice: `Already connected to ${coinLine(held.target)}. To connect again, run: bootr own disconnect` };
    await removeCredential(bootr.siteUrl, held, { env });
  }

  const started = await bootr.connectStart({ clientName: values.label?.trim().slice(0, 40) || 'bootr CLI', ...(values.coin ? { coin: values.coin } : {}) });
  if (!USER_CODE_RE.test(started.userCode)) throw new BootrApiError('The site answered with a malformed connection request.', 'bad_response', null);
  // The one coin the site says --coin names, when it names one: the request is then for that coin and no other.
  const bound = started.coin && typeof started.coin.kernel === 'string' && /^0x[0-9a-fA-F]{40}$/.test(started.coin.kernel) ? started.coin : null;
  // The link is built here, for the site this command talks to: one from the network is never shown.
  io.notice(
    [
      'Open this link in a browser and approve with the wallet that launched the coin:',
      `  ${bootr.siteUrl}/connect/${started.userCode}`,
      `Code: ${started.userCode}  (the page must show this same code)`,
      ...(bound ? [`Coin: ${coinLine({ kind: 'coin', coin: bound })}  (the page must show this coin and no other)`] : []),
      'Signing moves no funds. Waiting for the approval, for up to 10 minutes…',
    ].join('\n'),
  );
  const intervalMs = (Math.min(Math.max(Number(started.interval) || 5, 1), 60) + 1) * 1000;
  const until = io.now() + Math.min(Math.max(Number(started.expiresIn) || 600, 60), 900) * 1000;
  while (io.now() < until) {
    await io.sleep(intervalMs);
    let answered;
    try {
      answered = await bootr.connectToken(started.deviceCode);
    } catch (err) {
      // Asked a moment too soon, or the site was briefly away: wait and ask again. Anything else ends it.
      if (err instanceof BootrApiError && ['slow_down', 'rate_limited', 'unreachable', 'supervisor_unavailable'].includes(err.code)) continue;
      throw err;
    }
    if (answered.status !== 'approved') continue;
    // The label is words from the site: kept as they would be shown, with nothing hidden in them.
    const entry = { credential: answered.credential, clientId: answered.clientId, label: cleanText(String(answered.label ?? '')), target: answered.target, expiresAt: answered.expiresAt, savedAt: new Date(io.now()).toISOString() };
    // The approval must be for the coin --coin named. One for another coin is ended at once and never stored.
    if (!targetMatches(values.coin, entry.target, bound)) {
      await bootr.ownDisconnect({ credential: entry.credential }).catch(() => undefined);
      throw new BootrApiError(`The approval was for ${coinLine(entry.target)}, not for the coin --coin named. That connection was ended again and nothing was stored. Run the command again and approve for the coin you named, or name the other coin with --coin.`, 'wrong_coin', null);
    }
    try {
      await saveCredential(bootr.siteUrl, entry, { env });
    } catch (err) {
      // A credential that cannot be kept is ended at once, so it does not linger on the server.
      await bootr.ownDisconnect({ credential: entry.credential }).catch(() => undefined);
      throw asApiError(err);
    }
    await mkdir(picturesDir(env), { recursive: true, mode: 0o700 }).catch(() => undefined);
    return {
      data: { connected: true, ...describeCredential(entry), credentialsFile: file, picturesFolder: picturesDir(env) },
      // The symbol and the treasury address, always both: a symbol alone can belong to several coins.
      notice: `Connected to ${coinLine(entry.target)}. The credential is in the credentials file, readable by you only: it lets its holder post as your agent, so never share that file.`,
    };
  }
  throw new BootrApiError('The connection request ran out after 10 minutes without an approval. Run the command again for a new code.', 'grant_expired', null);
}

function dueRoles(view: DueView): string[] {
  return (['social', 'treasury', 'judge'] as const).filter((role) => view[role]?.on !== false && view[role]?.due === true);
}

function waitUntil(at: unknown, now: number): number {
  const t = typeof at === 'string' ? Date.parse(at) : NaN;
  return Math.min(Math.max(Number.isFinite(t) ? t - now : MIN_WAIT_MS, MIN_WAIT_MS), MAX_WAIT_MS);
}

async function watch(bootr: Bootr, values: { coin?: string; exec?: string; once?: boolean }, env: Record<string, string | undefined>, io: OwnIo) {
  const command = values.exec?.trim();
  if (!command) throw new OwnUsageError('watch needs --exec "<command>": what to run when something is due.');
  // Looked up once, so a missing connection is said at the start and not after a long wait.
  const held = await findCredential(bootr.siteUrl, values.coin, { env }).catch((err: unknown) => {
    throw asApiError(err);
  });
  const coin = describeCredential(held).coin;
  io.notice(`Watching ${coin}. When something is due this runs: ${command}`);
  let runs = 0;
  for (;;) {
    let view: DueView;
    try {
      view = await bootr.ownDue({ credential: held.credential });
    } catch (err) {
      if (!(err instanceof BootrApiError) || !['rate_limited', 'runtime_busy', 'unreachable', 'supervisor_unavailable', 'bad_response'].includes(err.code)) throw err;
      io.notice(`${err.code}: looking again later.`);
      await io.sleep(err.details.retryAt ? waitUntil(err.details.retryAt, io.now()) : RETRY_WAIT_MS);
      continue;
    }
    const roles = dueRoles(view);
    if (roles.length > 0 || view.openTurn) {
      io.notice(`Due: ${roles.join(', ') || `an open ${view.openTurn?.role} turn`}. Running your command.`);
      // The command gets the roles as fixed words and nothing from the network; the credential stays in its file.
      const code = await io.exec(command, { ...env, BOOTR_DUE_ROLES: roles.join(',') });
      runs += 1;
      if (code !== 0) io.notice(`Your command ended with exit code ${code}.`);
      if (values.once) return { data: { ran: runs, exitCode: code, roles } };
      // Never straight back: a command that did nothing must not turn this into a tight loop.
      await io.sleep(MIN_WAIT_MS);
      continue;
    }
    await io.sleep(waitUntil(view.nextCheckAt, io.now()));
  }
}

/** Runs one `bootr own …` command and returns what it prints. `argv` starts after `own`. */
export async function runOwn(argv: string[], env: Record<string, string | undefined> = process.env, io: Partial<OwnIo> = {}): Promise<{ data?: unknown; text?: string; notice?: string }> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const [command, ...rest] = positionals;
  if (values.help || !command) return { text: OWN_USAGE };
  for (const value of [...positionals, values.coin, values.label, values.exec, values.site]) {
    if (looksLikeKey(value)) throw new OwnUsageError(KEY_REFUSAL);
    if (typeof value === 'string' && value.includes(CREDENTIAL_PREFIX)) throw new OwnUsageError('That looks like a Bootr client credential. No command takes one: it is read from the credentials file. Nothing was sent.');
  }
  if (rest.length > 0) throw new OwnUsageError(`own ${command} takes no further words. Quote the command of --exec.`);
  const site = values.site ?? env.BOOTR_SITE_URL;
  const bootr = createBootr({ ...(site ? { siteUrl: site } : {}), ...(env.BOOTR_CREDENTIALS_FILE ? { credentialsFile: env.BOOTR_CREDENTIALS_FILE } : {}) });
  const given: OwnIo = { ...defaultIo, ...io };
  // A line for the person can carry words from the site (a coin's name, an error): cleaned like everything printed.
  const all: OwnIo = { ...given, notice: (text) => given.notice(cleanText(text)) };
  const which = values.coin ? { coin: values.coin } : {};
  switch (command) {
    case 'connect':
      return connect(bootr, values, env, all);
    case 'status':
      return { data: await patient(() => bootr.ownStatus(which), all) };
    case 'due':
      return { data: await patient(() => bootr.ownDue(which), all) };
    case 'watch':
      return watch(bootr, values, env, all);
    case 'disconnect':
      return { data: await bootr.ownDisconnect(which), notice: 'Disconnected. The credential was removed from this machine.' };
    default:
      throw new OwnUsageError('own takes: connect, status, due, watch or disconnect.');
  }
}
