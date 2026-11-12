#!/usr/bin/env node
/* global process, console, setTimeout, fetch, URL, Buffer */
/**
 * Own agents, end to end: the launch-and-switch part (docs/design/byo-agent.md section 13.10, W3's column).
 * `own-agent-e2e.mjs` imports this file when it exists and calls `run(env)`; it can also be run on its own.
 *
 * What it does, with nothing mocked between the MCP tool and the chain:
 *   1. prepares an own-agent launch with no fuel through `bootr_launch_message` and `bootr_prepare_launch`
 *      (`runner: "own"`): the answer names `own-agent`, carries 0 USDC and has no `approve` step;
 *   2. connects this MCP server to the launch's draft before the coin exists: `bootr_agent_connect` shows a link and a
 *      code, and the creator approves with a wallet signature over `POST /api/agent/connect/approve`;
 *   3. sends the launch (one transaction) and the gas deposit to the fork; the event says `own-agent`, the treasury
 *      holds no USDC and the creator never approved any;
 *   4. waits for the agent service to register the coin as own and adopt the draft's client, then uses that client
 *      (`bootr_agent_status`): the draft's client works after registration;
 *   5. reads the coin from the indexer: its model says `own-agent`;
 *   6. switches the coin to the Bootr agent through the console route, with the creator's signature: a run call now
 *      answers `agent_runs_hosted`, and without fuel the Bootr agent sleeps;
 *   7. switches back: the run call works again, and a chat message is refused with `chat_not_available`.
 *
 * What must be running is what `own-agent-e2e.mjs` asks for (a Base fork, Postgres, the indexer, the sender on the stub
 * X, the agent service and the web app with own agents switched on). The script starts none of it, writes only to a
 * local fork, and starts its own copy of the built MCP server with its own temporary credentials file, so the client
 * the other parts connected is left alone.
 *
 * `env` (every field optional; the names the script understands are listed in `read`): the site URL, the RPC, the
 * indexer URL, the creator's test key. Run alone:
 *   SITE=http://localhost:3200 RPC=http://127.0.0.1:8555 INDEXER_URL=http://localhost:42069 node packages/mcp/test/own-agent-e2e.w3.mjs
 *
 * The creator is anvil's first account, as in every part of the script: a public test key that owns nothing real.
 */
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, parseAbi, parseEther, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';

const BIN = path.resolve(import.meta.dirname, '../dist/index.js');
/** anvil's first default account (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266): a published test key. */
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OWN_AGENT_MODEL_ID = 'own-agent';
const USER_CODE = /[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}/;
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const launchedAbi = parseAbi([
  'event AgentLaunched(address indexed token, address indexed kernel, address indexed creator, address burner, uint256 agentId, (uint24 lpFeeBps, uint16 agentBps, uint16 creatorBps, uint16 burnBps, uint16 platformBps, address platformRecipient, uint256 minFuelUsdc, uint32 dormancyPeriod) defaults, bytes32 workerHash, string model, string agentURI, address supervisorSessionKey)',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first of `names` that `env` or the process environment carries. */
function read(env, ...names) {
  for (const name of names) {
    const value = env?.[name] ?? process.env[name];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return undefined;
}

async function until(label, fn, { timeoutMs = 120_000, everyMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
    await sleep(everyMs);
  }
}

export async function run(env = {}) {
  const SITE = (read(env, 'site', 'siteUrl', 'SITE', 'SITE_URL', 'BOOTR_SITE_URL') ?? 'http://localhost:3200').replace(/\/$/, '');
  const RPC = read(env, 'rpc', 'rpcUrl', 'RPC', 'RPC_URL') ?? 'http://127.0.0.1:8555';
  const INDEXER = (read(env, 'indexer', 'indexerUrl', 'INDEXER', 'INDEXER_URL', 'NEXT_PUBLIC_INDEXER_URL') ?? 'http://localhost:42069').replace(/\/$/, '');
  const DATABASE_URL = read(env, 'databaseUrl', 'DATABASE_URL');
  const SENDER_ENCRYPTION_KEY = read(env, 'senderEncryptionKey', 'SENDER_ENCRYPTION_KEY');
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(RPC)) throw new Error('RPC must be a local anvil fork: this script sends transactions.');
  if (DATABASE_URL && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')).hostname)) throw new Error('DATABASE_URL must be a local database: this script stores a stub X account in it.');
  if (!/^http:\/\/(127\.0\.0\.1|localhost|[\w.-]+\.localhost)(:\d+)?$/.test(SITE)) throw new Error('SITE must be a local copy of the web app: this script approves a client and switches an agent.');

  const results = [];
  const ok = (label, detail = '') => {
    results.push(label);
    console.log(`ok  [w3] ${label}${detail ? `: ${detail}` : ''}`);
  };
  const note = (text) => console.log(`--  [w3] ${text}`);

  const chain = createPublicClient({ chain: base, transport: http(RPC), pollingInterval: 500 });
  const test = createTestClient({ chain: base, mode: 'anvil', transport: http(RPC) });
  const creator = privateKeyToAccount(read(env, 'creatorKey', 'CREATOR_KEY') ?? ANVIL_KEY_0);
  const wallet = createWalletClient({ account: creator, chain: base, transport: http(RPC), pollingInterval: 500 });
  assert.equal(await chain.getChainId(), 8453, 'the fork must be a Base mainnet fork');
  if ((await chain.getBalance({ address: creator.address })) < parseEther('0.1')) await test.setBalance({ address: creator.address, value: parseEther('10') });

  const origin = new URL(SITE).origin;
  const api = async (method, pathname, body, headers = {}) => {
    const res = await fetch(`${SITE}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };
  /** A SIWE message with `statement`, signed by the creator, for a route that proves the wallet. */
  const signed = async (statement) => {
    const nonce = await api('POST', '/api/agent/nonce');
    assert.equal(nonce.status, 200, `nonce: ${nonce.text}`);
    const message = createSiweMessage({ domain: new URL(SITE).host, uri: origin, version: '1', chainId: 8453, address: creator.address, nonce: nonce.json.nonce, statement });
    return { message, signature: await creator.signMessage({ message }) };
  };

  const platform = await api('GET', '/api/platform');
  assert.equal(platform.json?.ownAgent, true, 'own agents must be switched on (OWN_AGENT_ENABLED=true for the agent service and the web app)');

  // ---------------- this part's own MCP server, with its own credentials file ----------------
  const home = mkdtempSync(path.join(tmpdir(), 'bootr-own-e2e-w3-'));
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...process.env, BOOTR_SITE_URL: SITE, BOOTR_CREDENTIALS_FILE: path.join(home, 'credentials.json'), BOOTR_PICTURES_DIR: path.join(home, 'pictures') },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (c) => stderr.push(String(c)));
  const client = new Client({ name: 'bootr-own-e2e-w3', version: '1.0.0' });
  await client.connect(transport);
  /** One tool call. An answer is the notice (block 0) and the JSON (block 1); a refusal is `<error>: <message>`. */
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const texts = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
    if (r.isError) return { error: /^(\w+):/.exec(texts[0] ?? '')?.[1] ?? 'error', text: texts.join('\n') };
    let data = null;
    for (const t of texts.slice(1)) {
      try {
        data = JSON.parse(t);
        break;
      } catch {
        /* a text block that is not JSON (the brief of a turn) */
      }
    }
    return { data, text: texts.join('\n') };
  };

  /**
   * `bootr_agent_due`. The site answers it once per 20 seconds per credential (section 3.3), so a `rate_limited`
   * answer is waited out until the time it names; every other answer, a refusal included, is returned as it came.
   */
  const dueNow = async () => {
    for (let i = 0; i < 4; i += 1) {
      const r = await call('bootr_agent_due', {});
      if (r.error !== 'rate_limited') return r;
      const at = Date.parse(/retryAt: ([^)\s]+)/.exec(r.text)?.[1] ?? '');
      await sleep(Math.min(30_000, Math.max(1_000, (Number.isFinite(at) ? at - Date.now() : 20_000) + 500)));
    }
    throw new Error('bootr_agent_due stayed rate_limited');
  };

  /** The local database, when its address was given: it holds the stub X account of this part's coin (step 4). */
  let db = null;
  /** True once this part's coin has left setup. */
  let active = false;

  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ['bootr_prepare_launch', 'bootr_agent_connect', 'bootr_agent_status', 'bootr_agent_due']) assert.ok(names.includes(name), `the MCP server lists ${name}`);
    assert.ok(tools.find((t) => t.name === 'bootr_prepare_launch').inputSchema.properties.launch.properties.runner, 'the launch schema read from the catalog has runner');
    ok('the MCP server lists the own-agent tools and the launch schema carries runner');

    // ---------------- 1. an own-agent launch with no fuel, prepared by the MCP tools ----------------
    const symbol = `OWN${Math.floor(Math.random() * 46_655).toString(36).toUpperCase().padStart(3, '0')}`;
    const message = (await call('bootr_launch_message', { address: creator.address })).data;
    const prepared = await call('bootr_prepare_launch', {
      message: message.message,
      signature: await creator.signMessage({ message: message.message }),
      launch: { name: `Own Agent ${symbol}`, symbol, identity: 'An agent that thinks in its creator’s own AI client. Short, plain, no hype.', image: { dataUrl: `data:image/png;base64,${PNG}` }, runner: 'own', gasEth: '0.001' },
    });
    assert.ok(prepared.data, `bootr_prepare_launch: ${prepared.text}`);
    const launch = prepared.data;
    assert.equal(launch.runner, 'own');
    assert.equal(launch.model, OWN_AGENT_MODEL_ID);
    assert.deepEqual(launch.transactions.map((t) => t.step), ['launch', 'gas'], 'no fuel: no approve step');
    assert.equal(launch.mock, undefined, 'the web app must not run in mock mode');
    ok('bootr_prepare_launch prepares an own-agent launch', `${symbol}, model ${launch.model}, steps ${launch.transactions.map((t) => t.step).join(' + ')}`);

    // ---------------- 2. connect this client to the launch draft, approved by the creator's wallet ----------------
    const started = await call('bootr_agent_connect', {});
    const userCode = USER_CODE.exec(started.text)?.[0];
    assert.ok(userCode, `bootr_agent_connect shows a code: ${started.text}`);
    assert.ok(!/bootr_agt_/.test(started.text), 'the tool never shows a credential');
    const approval = await signed(`Let an AI client run the agent of my next Bootr launch (draft ${launch.launchId}). Code ${userCode}.`);
    const approved = await api('POST', '/api/agent/connect/approve', { userCode, ...approval, label: 'own-agent-e2e w3' }, { origin });
    assert.equal(approved.status, 200, `approve: ${approved.text}`);
    assert.deepEqual(approved.json.target, { kind: 'draft', draftId: launch.launchId });
    const draft = await until('the draft to show its client', async () => {
      const r = await api('GET', `/api/agent/connect/draft?draft=${launch.launchId}`);
      return r.json?.connected ? r.json : null;
    }, { timeoutMs: 30_000 });
    assert.equal(draft.clients[0].label, 'own-agent-e2e w3');
    ok('a client is connected to the launch draft before the coin exists', `code ${userCode}`);

    // ---------------- 3. the launch: one transaction, no approval, then the gas ----------------
    const allowanceBefore = await chain.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [creator.address, launch.launcher] });
    let token;
    let kernel;
    let agentId;
    for (const tx of launch.transactions) {
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
      const receipt = await chain.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success', `${tx.step} reverted: ${hash}`);
      if (tx.step === 'launch') {
        const [ev] = parseEventLogs({ abi: launchedAbi, eventName: 'AgentLaunched', logs: receipt.logs });
        assert.ok(ev, 'the launch emitted AgentLaunched');
        ({ token, kernel, agentId } = ev.args);
        assert.equal(ev.args.model, OWN_AGENT_MODEL_ID, 'the event says own-agent');
      }
    }
    assert.equal(kernel.toLowerCase(), launch.predictedKernel.toLowerCase());
    assert.equal(await chain.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [kernel] }), 0n, 'the treasury holds no fuel');
    assert.equal(await chain.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [creator.address, launch.launcher] }), allowanceBefore, 'no USDC approval was made');
    ok('an own-agent coin launches with no fuel in one transaction', `token ${token}, treasury ${kernel}, agent #${agentId}`);

    // ---------------- 4. registration: the coin is own and the draft's client is its client ----------------
    const config = await until('the agent service to register the coin as own', async () => {
      const r = await api('GET', `/api/agent/${kernel.toLowerCase()}/config`);
      return r.status === 200 && r.json.runner === 'own' && r.json.own?.clients >= 1 ? r.json : null;
    }, { timeoutMs: 180_000 });
    assert.equal(config.agentId, String(agentId));
    assert.notEqual(config.model, OWN_AGENT_MODEL_ID, 'a model is kept for a switch to the Bootr agent');
    const status = await until('the draft’s client to answer for the coin', async () => {
      const r = await call('bootr_agent_status', {});
      return r.data?.runner === 'own' ? r.data : null;
    }, { timeoutMs: 60_000 });
    assert.equal(status.coin.token.toLowerCase(), token.toLowerCase());
    assert.equal(status.client.label, 'own-agent-e2e w3');
    ok('the draft’s client works after registration', `runner ${status.runner}, ${config.own.clients} client(s)`);
    // A coin with no X account stays in setup, and a run call says so before it says anything else (section 13.6:
    // `agent_onboarding` comes before `agent_runs_hosted`).
    const early = await dueNow();
    assert.equal(early.error, 'agent_onboarding', `bootr_agent_due before the X account is connected: ${early.text}`);

    // The X account, stored the way the seed script stores the seeded coin's (apps/supervisor/scripts/seed-own-agent.ts):
    // a row at the sender whose tokens open nothing but the stub X. The real connection is X's OAuth, which the stub
    // does not play. With it, and the session key the agent service installs on the fork (ADMIN_PRIVATE_KEY the
    // guardian's owner there, ENABLE_MODE_SELF_BUNDLE=true), the coin leaves setup, so the switch below is tried on
    // an active coin. Without a database address or the sender's key the coin stays in setup and the part says so.
    if (DATABASE_URL && /^[0-9a-fA-F]{64}$/.test(SENDER_ENCRYPTION_KEY ?? '')) {
      const pg = createRequire(path.resolve(import.meta.dirname, '../../../apps/supervisor/package.json'))('pg');
      db = new pg.Client({ connectionString: DATABASE_URL });
      await db.connect();
      const key = Buffer.from(SENDER_ENCRYPTION_KEY, 'hex');
      const seal = (plaintext, aad) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(aad, 'utf8'));
        const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
      };
      await db.query(
        `insert into sender_accounts (agent_id, x_user_id, x_handle, encrypted_access_token, encrypted_refresh_token, scopes, expires_at, revoked_at, connected_at, updated_at, verified_type, verified_checked_at)
         values ($1, $2, $3, $4, $5, 'tweet.read tweet.write users.read offline.access media.write', now() + interval '3650 days', null, now(), now(), 'blue', now())`,
        [String(agentId), `77${agentId}`, `own_${symbol.toLowerCase()}`, seal('stub-x-access-token', `access:${agentId}`), seal('stub-x-refresh-token', `refresh:${agentId}`)],
      );
      await until('the agent service to finish setting the coin up (session key on the fork, X account)', async () => (await db.query("select 1 from sv_agents where agent_id = $1 and status = 'active'", [String(agentId)])).rowCount === 1, { timeoutMs: 120_000 });
      const due = await until('bootr_agent_due to answer for the active coin', async () => {
        const r = await dueNow();
        return r.data ? r : null;
      }, { timeoutMs: 60_000 });
      assert.equal(typeof due.data.social?.due, 'boolean', `bootr_agent_due: ${due.text}`);
      active = true;
      ok('the coin leaves setup and bootr_agent_due answers what is due', `social due: ${due.data.social.due}`);
    } else note('no DATABASE_URL and SENDER_ENCRYPTION_KEY: the coin has no X account and stays in setup, so the switch is tried on a coin that answers agent_onboarding');

    // ---------------- 5. the indexer's coin says own-agent ----------------
    const indexed = await until('the indexer to show the coin', async () => {
      const res = await fetch(`${INDEXER}/search?q=${token}`);
      const rows = res.ok ? await res.json() : [];
      return (Array.isArray(rows) ? rows : []).find((r) => String(r.id).toLowerCase() === token.toLowerCase()) ?? null;
    }, { timeoutMs: 120_000 });
    assert.equal(indexed.model, OWN_AGENT_MODEL_ID);
    ok('the indexer’s token answer shows own-agent');

    // ---------------- 6. switch to the Bootr agent ----------------
    const consoleSession = await signed(`Open the console of Bootr coin $${symbol} (#${agentId}, ${kernel}).`);
    const toHosted = await api('POST', `/api/agent/${kernel.toLowerCase()}/runner`, { ...consoleSession, runner: 'hosted' }, { origin });
    assert.equal(toHosted.status, 200, `switch to the Bootr agent: ${toHosted.text}`);
    assert.equal(toHosted.json.runner, 'hosted');
    assert.match(toHosted.json.notes.join(' '), /The Bootr agent pays for its thinking from fuel/);
    const sessionToken = toHosted.json.token;
    assert.equal((await api('POST', `/api/agent/${kernel.toLowerCase()}/runner`, { token: sessionToken, runner: 'hosted' }, { origin })).json.error, 'runner_unchanged');
    const refused = await dueNow();
    assert.equal(refused.error, active ? 'agent_runs_hosted' : 'agent_onboarding', `a run call on a Bootr-agent coin: ${refused.text}`);
    const hostedStatus = await call('bootr_agent_status', {});
    assert.equal(hostedStatus.data?.runner, 'hosted', 'the status route still answers, and says who runs the agent');
    ok(`switched to the Bootr agent: the status says hosted and a run call answers ${refused.error}`);
    if (active) {
      // Without fuel the Bootr agent sleeps: the tick puts it to sleep and buys no thought for it.
      const asleep = await until('the Bootr agent to sleep without fuel', async () => (await db.query("select 1 from sv_runtimes where agent_id = $1 and status = 'sleeping'", [String(agentId)])).rowCount === 1, { timeoutMs: 60_000 });
      assert.ok(asleep);
      assert.equal((await db.query('select count(*)::int as n from sv_inference where agent_id = $1', [String(agentId)])).rows[0].n, 0, 'a thought was bought for a coin with no fuel');
      const treasury = await fetch(`${INDEXER}/treasury/${kernel}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      ok('the Bootr agent sleeps without fuel and buys no thought', `the indexer's status: ${treasury?.status ?? 'unknown'}`);
    } else note('the Bootr agent\'s sleep was not observed: the coin has no X account, so it is not active');

    // ---------------- 7. switch back to my own agent ----------------
    const toOwn = await api('POST', `/api/agent/${kernel.toLowerCase()}/runner`, { token: sessionToken, runner: 'own' }, { origin });
    assert.equal(toOwn.status, 200, `switch to my own agent: ${toOwn.text}`);
    assert.equal(toOwn.json.runner, 'own');
    const again = await until('the client to act for the coin again', async () => {
      const r = await dueNow();
      return r.data || r.error === 'agent_onboarding' ? r : null;
    }, { timeoutMs: 60_000 });
    if (active) assert.ok(again.data, `bootr_agent_due after the switch back: ${again.text}`);
    else assert.equal(again.error, 'agent_onboarding');
    if (active) assert.equal((await db.query('select count(*)::int as n from sv_inference where agent_id = $1', [String(agentId)])).rows[0].n, 0, 'a thought was bought for this coin');
    const chat = await api('POST', `/api/agent/${kernel.toLowerCase()}/chat/send`, { token: toOwn.json.token ?? sessionToken, text: 'What did you do today?' }, { origin });
    assert.equal(chat.status, 409, `chat: ${chat.text}`);
    assert.equal(chat.json.error, 'chat_not_available');
    ok('switched back to my own agent: the run call works and a chat message is refused');

    return { ok: true, results, coin: { token, kernel, agentId: String(agentId), symbol } };
  } catch (err) {
    if (stderr.length) console.error(`[w3] MCP server stderr:\n${stderr.join('')}`);
    throw err;
  } finally {
    await db?.end().catch(() => undefined);
    await client.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((r) => console.log(`\n[w3] ${r.results.length} checks passed`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
