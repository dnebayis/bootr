#!/usr/bin/env node
/* global process, console, setTimeout, fetch, Buffer, URL */
/**
 * Own agents, end to end (docs/design/byo-agent.md section 13.10): the built MCP server as a real stdio process, spoken
 * to with the MCP client, against a running local stack with nothing mocked between the tool call and the sender's
 * request to X, except X itself (`stub-x.mjs`).
 *
 * The W1 part, in this file: connect a client through the real routes with a wallet signature made here; `due` shows a
 * mention put into the stub; a social turn reads the thread and replies (the stub receives exactly one post, and the
 * same call again is the same action); a picture from the pictures folder goes up and is posted in the due slot; a
 * second post is refused with `post_slot_not_due`; a file outside the folder and a text file named `.png` are refused
 * before any request; the coin's tape shows the rows; after a disconnect the old credential answers
 * `credential_revoked`.
 *
 * The W2 and W3 parts live in `own-agent-e2e.w2.mjs` and `own-agent-e2e.w3.mjs`; each exports `run(env)`. They run after
 * the turns above and before the disconnect, so they find the client connected. A missing file is skipped with a line.
 *
 * What must be running (the script starts none of it, and refuses anything that is not local):
 *   Postgres; `base-anvil` forking Base; the indexer on the fork;
 *   `node packages/mcp/test/stub-x.mjs` (STUB_X_USER_ID / STUB_X_HANDLE as the seed stored them);
 *   the sender with X_API_BASE_URL pointed at the stub;
 *   the supervisor with OWN_AGENT_ENABLED=true and a 5-second tick. Its SITE_URL must not be a localhost address (leave
 *     it unset, or give any public-looking name): the links it writes into a bounty job's post go through the publish
 *     gate, which refuses a post that names localhost. For the W3 part's coin to leave setup it also needs
 *     ADMIN_PRIVATE_KEY set to a test key that owns the guardian on the fork (hand the ownership over with anvil's
 *     impersonation) and ENABLE_MODE_SELF_BUNDLE=true, so the session key is installed without a bundler;
 *   the web app in `next dev` with OWN_AGENT_ENABLED=true, NEXT_PUBLIC_USE_MOCK=0, NEXT_PUBLIC_SITE_URL=<its own address>,
 *     SUPERVISOR_URL and SUPERVISOR_SERVICE_KEY.
 * Before it: `apps/supervisor/scripts/seed-own-agent.ts`, whose one JSON line goes in E2E_SEED. Its creator must be
 * anvil's first account (the default), and it must leave an original post due and the agent's X account connected.
 *
 * Run: SITE=http://localhost:3200 RPC=http://127.0.0.1:8555 DATABASE_URL=postgres://localhost:5432/bootr \
 *      STUB=http://127.0.0.1:4010 E2E_SEED='{"agentId":"…","kernel":"0x…","token":"0x…","symbol":"…"}' \
 *      SUPERVISOR_URL=http://127.0.0.1:3004 SUPERVISOR_SERVICE_KEY=<the local stack's key> \
 *      INDEXER_URL=http://127.0.0.1:42069 SENDER_ENCRYPTION_KEY=<the local sender's key> \
 *      node packages/mcp/test/own-agent-e2e.mjs
 *
 * INDEXER_URL and SENDER_ENCRYPTION_KEY are for the W3 part: it reads its coin from the indexer, and it stores a stub
 * X account for the coin it launches (as the seed script does for the seeded coin) so that coin leaves setup.
 *
 * The seeded coin must be fresh for every run: the first part needs an original post due, no client connected and a
 * mention read the sender does not hold back. Run the seed script again before each run (it starts the coin over) and
 * empty the stub (`POST /__stub/reset`).
 *
 * SUPERVISOR_URL and SUPERVISOR_SERVICE_KEY are for one check only, the coin's tape: the seeded coin is in the
 * supervisor's database and not on the fork, so the web's public tape route (which asks the indexer who the coin is)
 * does not know it, and the tape is read from the supervisor itself. With a coin the indexer knows they can be left out.
 *
 * Afterwards, by hand: stop the supervisor and the web, start both without OWN_AGENT_ENABLED, and run this script with
 * FLAG_OFF=1: it checks that the site says `ownAgent: false`, that the MCP server lists no agent tool and that the run
 * routes answer `own_agent_disabled`; then watch the supervisor's log for a few ticks: the seeded own coin must get no
 * hosted turn and buy no thought.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = import.meta.dirname;
const BIN = path.resolve(HERE, '../dist/index.js');
const SITE = (process.env.SITE ?? 'http://localhost:3200').replace(/\/+$/, '');
const RPC = process.env.RPC ?? 'http://127.0.0.1:8555';
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const STUB = (process.env.STUB ?? 'http://127.0.0.1:4010').replace(/\/+$/, '');
const FLAG_OFF = process.env.FLAG_OFF === '1';
const SUPERVISOR_URL = (process.env.SUPERVISOR_URL ?? '').replace(/\/+$/, '');
const SUPERVISOR_SERVICE_KEY = process.env.SUPERVISOR_SERVICE_KEY ?? '';

// Anvil's first account. Its key is public and well known: it owns nothing outside a local fork, and it is the creator
// of the seeded coin in every part of this script. It appears here and nowhere else in the repository.
const CREATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const creator = privateKeyToAccount(CREATOR_KEY);
assert.equal(creator.address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');

const local = (value) => {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
};
if (!local(SITE)) throw new Error('SITE must be a local web app: this script posts as an agent.');
if (!local(RPC)) throw new Error('RPC must be a local anvil fork.');
if (!local(STUB)) throw new Error('STUB must be the local stand-in for X (packages/mcp/test/stub-x.mjs).');
if (DATABASE_URL && !local(DATABASE_URL.replace(/^postgres(ql)?:/, 'http:'))) throw new Error('DATABASE_URL must be a local database.');
if (SUPERVISOR_URL && !local(SUPERVISOR_URL)) throw new Error('SUPERVISOR_URL must be the local supervisor.');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.error(`\n== ${text}`);
const ok = (text) => console.error(`   ok  ${text}`);

async function http(method, url, { body, headers = {} } = {}) {
  const res = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: the caller sees the status */
  }
  return { status: res.status, json };
}

/** The coin's tape: from the supervisor when its address and key were given (the header says why), else from the site. */
async function tape(seed) {
  if (SUPERVISOR_URL && SUPERVISOR_SERVICE_KEY) {
    const route = `/internal/agents/${seed.agentId}/activity?limit=20`;
    const ts = String(Math.floor(Date.now() / 1000));
    const emptyBody = createHash('sha256').update('').digest('hex');
    const signature = createHmac('sha256', SUPERVISOR_SERVICE_KEY).update(`${ts}\nGET\n${route}\n${emptyBody}`).digest('hex');
    return http('GET', `${SUPERVISOR_URL}${route}`, { headers: { authorization: `HMAC ${ts}:${signature}` } });
  }
  return http('GET', `${SITE}/api/agent/${seed.kernel}/activity?limit=20`);
}

const stub = {
  received: async () => (await http('GET', `${STUB}/__stub/received`)).json,
  mention: async (text) => (await http('POST', `${STUB}/__stub/mention`, { body: { text } })).json,
};

/** The MCP server as a client starts it, with its own credentials file and pictures folder. */
async function startMcp(env) {
  const client = new Client({ name: 'bootr-own-agent-e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env, BOOTR_SITE_URL: SITE, BOOTR_CREDENTIALS_FILE: env.credentialsFile, BOOTR_PICTURES_DIR: env.picturesDir }, stderr: 'inherit' }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const texts = result.content.filter((c) => c.type === 'text').map((c) => c.text);
    // No result of any tool may ever carry a credential.
    assert.ok(!JSON.stringify(result).includes('bootr_agt_'), `${name} returned a credential`);
    return { result, isError: result.isError === true, text: texts[0] ?? '', json: () => JSON.parse(texts.at(-1)) };
  };
  return { client, call };
}

/** The wallet's approval, as the page at /connect/<code> sends it: a nonce, a SIWE message, the signature. */
async function approve(statement, userCode) {
  const nonce = await http('POST', `${SITE}/api/agent/nonce`);
  assert.equal(nonce.status, 200, 'POST /api/agent/nonce');
  const url = new URL(SITE);
  const message = createSiweMessage({ domain: url.host, uri: SITE, version: '1', chainId: 8453, address: creator.address, nonce: nonce.json.nonce, statement, issuedAt: new Date() });
  const signature = await creator.signMessage({ message });
  return http('POST', `${SITE}/api/agent/connect/approve`, { body: { userCode, message, signature, label: 'e2e client' }, headers: { origin: SITE } });
}

async function flagOff(env) {
  step('With the flag off');
  const platform = await http('GET', `${SITE}/api/platform`);
  assert.equal(platform.json.ownAgent, false, 'GET /api/platform must say ownAgent: false');
  ok('the site says ownAgent: false');
  const { client } = await startMcp(env);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  for (const gone of ['bootr_agent_due', 'bootr_agent_turn', 'bootr_agent_connect', 'bootr_agent_publish_post']) assert.ok(!names.includes(gone), `${gone} must not be listed`);
  assert.equal(names.length, 13, 'the 13 read and prepare tools are all that is listed');
  ok('the MCP server lists no agent tool');
  for (const route of ['run/status', 'run/due', 'run/turn', 'connect/start']) {
    const res = await http('POST', `${SITE}/api/agent/${route}`, { body: {}, headers: { authorization: `Bearer bootr_agt_${'a'.repeat(43)}` } });
    assert.equal(res.json?.error, 'own_agent_disabled', `POST /api/agent/${route}`);
  }
  ok('the run and connect routes answer own_agent_disabled');
  console.error('\nNow watch the supervisor for a few ticks: the seeded own coin must get no hosted turn and buy no thought.');
}

async function w1(env, mcp) {
  const { seed } = env;
  const { call } = mcp;

  step('The tools are listed and the client is not connected');
  const names = (await mcp.client.listTools()).tools.map((t) => t.name);
  for (const needed of ['bootr_agent_connect', 'bootr_agent_due', 'bootr_agent_turn', 'bootr_agent_publish_reply', 'bootr_agent_upload_picture', 'bootr_agent_finish']) assert.ok(names.includes(needed), `${needed} is listed`);
  const before = await call('bootr_agent_due');
  assert.ok(before.isError && before.text.startsWith('not_connected:'), before.text);
  ok(`${names.length} tools; due answers not_connected`);

  step('Connect through the real routes, with a signature made here');
  const first = (await call('bootr_agent_connect', { coin: seed.symbol })).json();
  assert.equal(first.connected, false);
  assert.equal(first.link, `${SITE}/connect/${first.userCode}`);
  const grant = await http('GET', `${SITE}/api/agent/connect/grant?code=${first.userCode}`);
  assert.equal(grant.json.status, 'pending');
  assert.equal(grant.json.clientName, 'bootr-own-agent-e2e');
  const coins = await http('GET', `${SITE}/api/agent/connect/coins?creator=${creator.address}`);
  const coin = coins.json.coins.find((c) => c.kernel.toLowerCase() === seed.kernel.toLowerCase());
  assert.ok(coin, 'the seeded coin is among the creator’s coins');
  // A signature for another code approves nothing.
  const wrong = await approve(`Let an AI client run the agent of Bootr coin $${coin.symbol} (#${coin.agentId}, ${coin.kernel}). Code BCDF-GHJK.`, first.userCode);
  assert.equal(wrong.json.error, 'siwe_rejected');
  const approved = await approve(`Let an AI client run the agent of Bootr coin $${coin.symbol} (#${coin.agentId}, ${coin.kernel}). Code ${first.userCode}.`, first.userCode);
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  assert.equal(approved.json.target.coin.agentId, seed.agentId);
  const second = (await call('bootr_agent_connect', { coin: seed.symbol })).json();
  assert.equal(second.connected, true, JSON.stringify(second));
  assert.equal(second.coin.kernel.toLowerCase(), seed.kernel.toLowerCase());
  const file = JSON.parse(await readFile(env.credentialsFile, 'utf8'));
  const credential = Object.values(Object.values(file.sites)[0])[0].credential;
  assert.match(credential, /^bootr_agt_[A-Za-z0-9_-]{43}$/);
  ok(`connected to $${coin.symbol}; the credential is in ${env.credentialsFile} only`);

  step('Status, and a mention from the stub shows up as due');
  const status = (await call('bootr_agent_status')).json();
  assert.equal(status.runner, 'own');
  await stub.mention('what does this coin do?');
  let due;
  for (let i = 0; i < 6; i += 1) {
    const answered = await call('bootr_agent_due');
    if (answered.isError) assert.ok(answered.text.startsWith('rate_limited:'), answered.text);
    else {
      due = answered.json();
      if (due.social.reasons.includes('pending_mention')) break;
    }
    await sleep(21_000);
  }
  assert.ok(due?.social.due && due.social.reasons.includes('pending_mention'), `due must show the mention: ${JSON.stringify(due?.social)}`);
  assert.ok(due.social.reasons.includes('original_post_due'), 'the seed must leave an original post due, so a post in its slot can be tested');
  ok(`social is due: ${due.social.reasons.join(', ')}`);

  step('A social turn: read the thread, reply once, repeat the call, upload a picture, post in the slot');
  const opened = await call('bootr_agent_turn', { role: 'social' });
  assert.ok(!opened.isError, opened.text);
  const turn = opened.json();
  assert.equal(opened.result.content.length, 3, 'a turn is three blocks');
  assert.ok(turn.tools.includes('bootr_agent_publish_reply'));
  const posts0 = (await stub.received()).posts.length;
  const mention = (await stub.received()).mentions[0];
  const thread = (await call('bootr_agent_read_x_thread', { turnId: turn.turnId, postId: mention.id })).json();
  assert.equal(thread.status, 'completed', JSON.stringify(thread));
  const reply = { turnId: turn.turnId, postId: mention.id, text: 'It comes with an agent that works in public. Ask it anything about the coin.' };
  const replied = (await call('bootr_agent_publish_reply', reply)).json();
  assert.equal(replied.status, 'completed', JSON.stringify(replied));
  const again = (await call('bootr_agent_publish_reply', reply)).json();
  assert.equal(again.actionId, replied.actionId, 'the same call is the same action');
  let received = await stub.received();
  assert.equal(received.posts.length, posts0 + 1, 'the stub received exactly one post');
  assert.equal(received.posts[0].in_reply_to_tweet_id, mention.id);
  ok('one reply reached X; the repeated call sent nothing');

  // A real picture, a text file with a picture's name, and a picture outside the folder.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path.join(env.picturesDir, 'owl.png'), png);
  await writeFile(path.join(env.picturesDir, 'notes.png'), 'not a picture');
  await writeFile(path.join(env.outsideDir, 'secret.png'), png);
  const media0 = received.media.length;
  const outside = (await call('bootr_agent_upload_picture', { turnId: turn.turnId, path: path.join(env.outsideDir, 'secret.png'), alt: 'x', description: 'x' })).json();
  assert.equal(outside.error, `picture_outside_folder: only files inside ${env.picturesDir} can be uploaded. Nothing was sent.`);
  const text = (await call('bootr_agent_upload_picture', { turnId: turn.turnId, path: 'notes.png', alt: 'x', description: 'x' })).json();
  assert.equal(text.error, 'picture_not_an_image: that file is not a PNG, JPEG or WebP picture. Nothing was sent.');
  assert.equal((await call('bootr_agent_status')).json().picturesLeftToday, status.picturesLeftToday, 'a refused file used no picture of the day');
  const uploaded = (await call('bootr_agent_upload_picture', { turnId: turn.turnId, path: 'owl.png', alt: 'A single dot', description: 'A plain one-pixel test picture.' })).json();
  assert.equal(uploaded.status, 'completed', JSON.stringify(uploaded));
  const posted = (await call('bootr_agent_publish_post', { turnId: turn.turnId, text: 'A first note from this coin’s own agent: it is awake.', imageId: uploaded.result.imageId })).json();
  assert.equal(posted.status, 'completed', JSON.stringify(posted));
  received = await stub.received();
  assert.equal(received.posts.length, posts0 + 2, 'the post reached X');
  assert.equal(received.media.length, media0 + 1, 'its picture was uploaded to X once');
  assert.equal(received.posts[0].media_ids.length, 1, 'and attached');
  ok('a picture from the folder went out with the post; the two bad files were refused here');

  const extra = (await call('bootr_agent_publish_post', { turnId: turn.turnId, text: 'A second post right after the first.' })).json();
  assert.equal(extra.status, 'failed');
  assert.ok(extra.error.startsWith('post_slot_not_due:'), extra.error);
  assert.equal((await stub.received()).posts.length, posts0 + 2, 'nothing more reached X');
  ok('a post outside its slot is refused: post_slot_not_due');

  const finished = (await call('bootr_agent_finish', { turnId: turn.turnId, memory: 'Answered one mention and posted the first note.', agenda: 'Watch for replies.', summary: 'One reply, one post with a picture.', nextAt: new Date(Date.now() + 3_600_000).toISOString() })).json();
  assert.equal(finished.turnEnded, true, JSON.stringify(finished));
  const late = await call('bootr_agent_publish_post', { turnId: turn.turnId, text: 'after the end' });
  assert.ok(late.isError && /^turn_(closed|not_found)/.test(late.text), late.text);
  ok('the turn is finished and closed');

  step('The coin’s tape shows what the own agent did');
  const read = await tape(seed);
  assert.equal(read.status, 200, read.json?.error === 'unknown_coin' ? 'the indexer does not know the seeded coin: pass SUPERVISOR_URL and SUPERVISOR_SERVICE_KEY so the tape is read from the supervisor' : `the tape answered ${read.status}`);
  const rows = JSON.stringify(read.json.items);
  assert.ok(rows.includes('own agent'), 'rows are marked "· own agent"');
  assert.ok(!rows.includes('bootr_agt_'), 'no credential on the tape');
  ok(`${read.json.items.length} rows on the tape`);

  return { credential };
}

async function disconnect(env, mcp, credential) {
  step('Disconnect: the old credential is refused');
  const gone = (await mcp.call('bootr_agent_disconnect')).json();
  assert.deepEqual(gone, { ok: true });
  assert.ok(!(await readFile(env.credentialsFile, 'utf8')).includes('bootr_agt_'), 'the credential left the file');
  const direct = await http('POST', `${SITE}/api/agent/run/status`, { body: {}, headers: { authorization: `Bearer ${credential}` } });
  assert.equal(direct.status, 401);
  assert.equal(direct.json.error, 'credential_revoked');
  // And a web page is never served, whatever it sends.
  const page = await http('POST', `${SITE}/api/agent/run/status`, { body: {}, headers: { authorization: `Bearer ${credential}`, origin: SITE } });
  assert.equal(page.json.error, 'unauthorized');
  ok('credential_revoked for the old credential; a request with an Origin is refused');
}

const dir = await mkdtemp(path.join(tmpdir(), 'bootr-own-e2e-'));
// What every part is handed (section 13.10): the site, the RPC, the database, the stub, the seed, a credentials file
// that holds the connected client while the W2 and W3 parts run, and a pictures folder. The contract does not name
// the keys, so the plain names have a short alias each.
const env = {
  siteUrl: SITE,
  site: SITE,
  rpcUrl: RPC,
  rpc: RPC,
  databaseUrl: DATABASE_URL,
  stubUrl: STUB,
  stub: STUB,
  seed: null,
  credentialsFile: path.join(dir, 'credentials.json'),
  picturesDir: path.join(dir, 'bootr-pictures'),
  // Not in the contract's list: a folder that is not the pictures folder, and the creator's test account.
  outsideDir: path.join(dir, 'elsewhere'),
  creator,
};
await mkdir(env.picturesDir, { recursive: true });
await mkdir(env.outsideDir, { recursive: true });

try {
  if (!existsSync(BIN)) throw new Error('Build the MCP server first: pnpm --filter @bootrfun/mcp build');
  if (FLAG_OFF) {
    await flagOff(env);
  } else {
    env.seed = JSON.parse(process.env.E2E_SEED ?? 'null');
    for (const key of ['agentId', 'kernel', 'token', 'symbol']) assert.ok(typeof env.seed?.[key] === 'string', `E2E_SEED must be the seed script’s JSON line (missing ${key})`);
    const platform = await http('GET', `${SITE}/api/platform`);
    assert.equal(platform.json?.ownAgent, true, `${SITE} must run with OWN_AGENT_ENABLED=true`);
    assert.ok((await http('GET', `${STUB}/__stub/received`)).status === 200, `${STUB} must be stub-x.mjs`);
    const mcp = await startMcp(env);
    try {
      const { credential } = await w1(env, mcp);
      for (const part of ['w2', 'w3']) {
        const file = path.join(HERE, `own-agent-e2e.${part}.mjs`);
        if (!existsSync(file)) {
          console.error(`\n== ${part.toUpperCase()} part: own-agent-e2e.${part}.mjs is not here, skipped.`);
          continue;
        }
        step(`${part.toUpperCase()} part`);
        const mod = await import(new URL(`file://${file}`).href);
        assert.equal(typeof mod.run, 'function', `own-agent-e2e.${part}.mjs must export run(env)`);
        await mod.run(env);
      }
      await disconnect(env, mcp, credential);
    } finally {
      await mcp.client.close();
    }
    console.error('\nAll parts passed. Last step, by hand: restart the supervisor and the web without OWN_AGENT_ENABLED and run this script with FLAG_OFF=1.');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
