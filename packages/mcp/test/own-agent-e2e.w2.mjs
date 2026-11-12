#!/usr/bin/env node
/* global process, console, setTimeout, fetch, URL */
/**
 * Own agents, end to end: the second workstream's part (docs/design/byo-agent.md section 13.10).
 *
 * `own-agent-e2e.mjs` imports this file when it exists and calls `run(env)`; it can also be run on its own (see the
 * last lines). Everything goes through the built MCP server as a real stdio process, the web app's public routes and
 * the supervisor behind them, with the seeded own-agent coin of `apps/supervisor/scripts/seed-own-agent.ts`:
 *
 *   1. paid services with no fuel: a social turn the creator asked for calls `bootr_agent_x402_fetch` and is refused
 *      with `services_insufficient_fuel` before any request (no service-call row is started, so nothing is signed);
 *   2. a treasury turn: `due` says why, the turn holds no X tool and its observation no mention, it reads the treasury
 *      and prepares one operation (USDC to the agent's own spender; nothing is executed);
 *   3. a creator request filed the way the hosted chat files it is shown to that turn and closed by
 *      `bootr_agent_answer_request`, `done` only after an action of the turn;
 *   4. a bounty job from post to proposal: `bootr_agent_bounty_post` in the treasury turn, then the judge turn rules
 *      through `bootr_agent_judge_entry` and `bootr_agent_judge`, and the winner lands in the creator's queue with the
 *      payee from the entry record. No thought is bought at any point.
 *
 * What this part does by hand, in the local database, and why:
 *   - it turns the coin's Bounties and Paid services powers on for the run and puts the config back afterwards (the
 *     console's signed session is not this part's);
 *   - it writes the creator request as the hosted chat's code writes it (a `sv_memories` row, source `creator-chat`):
 *     filing one for real needs a hosted thought, and the switch between runners is the third workstream's part;
 *   - it moves the posted job to "window closed, entries collected" with one page entry pinned on its row: a job stays
 *     open for at least an hour, and planting a reply on the stub X is the stub's own interface. So the sweep's reading
 *     of replies is not exercised here (test/own-w2-judge.test.ts in the supervisor does that against a fake sender).
 *
 * Step 1 contacts nobody: an own coin with no fuel is refused before the host is looked up, so the address is only a
 * name (`env.x402Url` or E2E_X402_URL, else a reserved example name).
 *
 * Only a local database and a local anvil fork are ever written to; the script refuses anything else.
 *
 * Run alone: SITE=http://localhost:3200 RPC=http://127.0.0.1:8555 DATABASE_URL=postgres://localhost/bootr \
 *   E2E_SEED='{"agentId":"…","kernel":"0x…","token":"0x…","symbol":"…"}' BOOTR_CREDENTIALS_FILE=/tmp/…/credentials.json \
 *   node packages/mcp/test/own-agent-e2e.w2.mjs
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createTestClient, createWalletClient, erc20Abi, http, parseEther, publicActions } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const BIN = path.resolve(import.meta.dirname, '../dist/index.js');
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_WHALE = '0xd0b53D9277642d899DF5C87A3966A349A798F224'; // the WETH/USDC 0.05% pool
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;
const NO_FUEL = 'services_insufficient_fuel: your spendable fuel is below the price of this call';
const USER_CODE = /[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}/;
/** Tools that read or write X: a treasury turn never holds one. */
const X_TOOLS = ['read_mentions', 'read_x_thread', 'read_x_account', 'publish_post', 'publish_reply', 'resolve_mention', 'resolve_mentions', 'recall_conversation'];
/** Money tools: a social turn never holds one while the treasury turn is on. */
const MONEY_TOOLS = ['treasury_prepare', 'treasury_execute', 'bounty_post', 'bounty_cancel'];
/** An address nobody holds the key of: the payee of the planted entry. */
const PAYEE = '0x00000000000000000000000000000000b0077e57';
const EXCERPT = 'How Base fees are set: the base fee moves with demand in the previous block, and a priority fee goes to the sequencer. Sources: the Base docs and the OP Stack specs.';

const pick = (env, names) => names.map((n) => env?.[n]).find((v) => v !== undefined && v !== null && v !== '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The parts of one MCP tool result (section 13.7): the notice, the JSON of the response, an image when there is one. */
function parse(name, result) {
  const texts = (result.content ?? []).filter((b) => b.type === 'text').map((b) => b.text);
  if (result.isError) {
    const line = texts.find((t) => /^[a-z_]+: /.test(t)) ?? texts.join(' ');
    return { name, error: /^([a-z_]+): /.exec(line)?.[1] ?? 'error', text: line, json: {}, texts, image: null };
  }
  let json = {};
  for (const t of texts) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) json = { ...json, ...v };
    } catch {
      /* the notice and the brief are plain text */
    }
  }
  return { name, error: null, text: texts.join('\n'), json, texts, image: (result.content ?? []).find((b) => b.type === 'image') ?? null };
}

export async function run(env = {}) {
  const site = String(pick(env, ['siteUrl', 'site', 'SITE']) ?? process.env.SITE ?? process.env.BOOTR_SITE_URL ?? 'http://localhost:3200').replace(/\/$/, '');
  const rpc = String(pick(env, ['rpcUrl', 'rpc', 'RPC']) ?? process.env.RPC ?? 'http://127.0.0.1:8555');
  const databaseUrl = pick(env, ['databaseUrl', 'database', 'dbUrl', 'DATABASE_URL']) ?? process.env.DATABASE_URL;
  const seedRaw = pick(env, ['seed', 'E2E_SEED']) ?? process.env.E2E_SEED;
  const seed = typeof seedRaw === 'string' ? JSON.parse(seedRaw) : seedRaw;
  const credentialsFile = pick(env, ['credentialsFile', 'credentials', 'BOOTR_CREDENTIALS_FILE']) ?? process.env.BOOTR_CREDENTIALS_FILE;
  const picturesDir = pick(env, ['picturesDir', 'pictures', 'BOOTR_PICTURES_DIR']) ?? process.env.BOOTR_PICTURES_DIR;
  const x402Url = pick(env, ['x402Url', 'E2E_X402_URL']) ?? process.env.E2E_X402_URL;

  assert.ok(seed?.agentId && seed?.kernel && seed?.symbol, 'the seed is missing: pass the one JSON line of seed-own-agent.ts as E2E_SEED');
  assert.ok(databaseUrl, 'the database URL is missing');
  assert.ok(LOCAL.test(new URL(rpc).hostname), 'RPC must be a local anvil fork: this part sends a transaction to fund the test treasury.');
  assert.ok(LOCAL.test(new URL(databaseUrl).hostname), 'the database must be a local one: this part writes test rows.');
  assert.ok(LOCAL.test(new URL(site).hostname), 'the site must be the local web app.');

  const done = [];
  const ok = (label, detail = '') => {
    done.push(label);
    console.log(`ok  w2: ${label}${detail ? `: ${detail}` : ''}`);
  };

  // ---------------- the local database ----------------
  const pg = createRequire(path.resolve(import.meta.dirname, '../../../apps/supervisor/package.json'))('pg');
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0] ?? null;
  const startedAt = new Date();

  // ---------------- MCP over stdio ----------------
  let client = env.client ?? null;
  let transport = null;
  if (!client) {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { ...process.env, BOOTR_SITE_URL: site, ...(credentialsFile ? { BOOTR_CREDENTIALS_FILE: credentialsFile } : {}), ...(picturesDir ? { BOOTR_PICTURES_DIR: picturesDir } : {}) },
      stderr: 'pipe',
    });
    client = new Client({ name: 'bootr-own-e2e-w2', version: '1.0.0' });
    await client.connect(transport);
  }
  const call = async (name, args = {}) => parse(name, await client.callTool({ name: `bootr_agent_${name}`, arguments: args }));
  /** A call that must be taken (no `OwnErrorBody`): returns the parsed response. */
  const must = async (name, args = {}) => {
    const r = await call(name, args);
    assert.equal(r.error, null, `bootr_agent_${name} was refused: ${r.text}`);
    return r;
  };
  const act = async (tool, turnId, input = {}) => (await must(tool, { turnId, ...input })).json;
  const finish = (turnId, summary) => must('finish', { turnId, memory: 'e2e: nothing to keep', agenda: 'e2e: nothing planned', summary, nextAt: new Date(Date.now() + 3_600_000).toISOString() });
  /**
   * What is due. The site answers `due` once per 20 seconds per credential (section 3.3) and the first part has just
   * asked, so a `rate_limited` answer is waited out until the time it names; any other refusal fails the part.
   */
  const dueNow = async () => {
    for (let i = 0; i < 4; i++) {
      const r = await call('due');
      if (r.error !== 'rate_limited') {
        assert.equal(r.error, null, `bootr_agent_due was refused: ${r.text}`);
        return r.json;
      }
      const at = Date.parse(/retryAt: ([^)\s]+)/.exec(r.text)?.[1] ?? '');
      await sleep(Math.min(30_000, Math.max(1_000, (Number.isFinite(at) ? at - Date.now() : 20_000) + 500)));
    }
    throw new Error('bootr_agent_due stayed rate_limited');
  };

  let original = null;
  try {
    // ---------------- 0. the coin: own, with Bounties and Paid services on for this run ----------------
    const agent = await one('select agent_id, kernel, creator, spender, config from sv_agents where agent_id = $1', [String(seed.agentId)]);
    assert.ok(agent, `no agent ${seed.agentId} in the database: run seed-own-agent.ts first`);
    assert.equal(agent.config.runner, 'own', 'the seeded coin must be an own-agent coin');
    original = agent.config;
    const config = { ...agent.config, capabilities: { ...agent.config.capabilities, treasury: true, memory: true, bounties: true, services: true }, bounties: { ...agent.config.bounties, review: false }, revision: Number(agent.config.revision ?? 1) + 1 };
    await db.query('update sv_agents set config = $2, updated_at = now() where agent_id = $1', [agent.agent_id, JSON.stringify(config)]);
    // The treasury clock starts over, so the turn is due by its interval whatever an earlier run left.
    await db.query("update sv_runtimes set state = state - 'treasuryNextAt' - 'lastTreasuryTurnAt' - 'lastTreasuryNoteSeenAt' where agent_id = $1", [agent.agent_id]);

    // A client that is not connected yet (this part run alone, or after the first part disconnected) connects the way
    // a creator does: the tool shows a code, the creator's wallet signs for it on the site, the server collects the credential.
    if ((await call('status')).error) {
      const creator = mnemonicToAccount('test test test test test test test test test test test junk');
      assert.equal(creator.address.toLowerCase(), String(agent.creator).toLowerCase(), 'the seeded coin was not launched by the first anvil account: connect the client before this part runs');
      const shown = await call('connect', { coin: seed.symbol });
      const userCode = USER_CODE.exec(shown.text)?.[0];
      assert.ok(userCode, `bootr_agent_connect showed no code: ${shown.text.slice(0, 200)}`);
      const { nonce } = await (await fetch(`${site}/api/agent/nonce`, { method: 'POST' })).json();
      const statement = `Let an AI client run the agent of Bootr coin $${seed.symbol} (#${seed.agentId}, ${seed.kernel}). Code ${userCode}.`;
      const message = [`${new URL(site).host} wants you to sign in with your Ethereum account:`, creator.address, '', statement, '', `URI: ${site}`, 'Version: 1', 'Chain ID: 8453', `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`].join('\n');
      const approved = await fetch(`${site}/api/agent/connect/approve`, { method: 'POST', headers: { 'content-type': 'application/json', origin: site }, body: JSON.stringify({ userCode, message, signature: await creator.signMessage({ message }), label: 'e2e w2' }) });
      assert.equal(approved.status, 200, `the approval was refused: ${await approved.text()}`);
      for (let i = 0; i < 20 && (await call('status')).error; i++) await sleep(1_000);
      ok('connected a client of its own', userCode);
    }
    const status = (await must('status')).json;
    assert.equal(status.runner, 'own');
    assert.equal(status.powers?.bounties, true, 'the Bounties power did not reach the status');
    assert.equal(status.powers?.services, true, 'the Paid services power did not reach the status');

    // A turn left open by an earlier part would answer `turn_open`: say so plainly instead of failing later.
    const before = (await dueNow());
    assert.equal(before.openTurn ?? null, null, `a turn is still open (${before.openTurn?.role}): finish it before this part runs`);

    // ---------------- 1. paid services with no fuel ----------------
    const social = (await must('turn', { role: 'social', reason: 'creator_asked' })).json;
    for (const tool of MONEY_TOOLS) assert.ok(!social.tools.includes(`bootr_agent_${tool}`), `a social turn holds ${tool} while the treasury turn is on`);
    assert.ok(social.tools.includes('bootr_agent_x402_fetch'), 'the social turn does not hold x402_fetch although the power is on');
    // An own coin with too little fuel sends nothing at all (section 7.1): not the unpaid request that asks for the
    // price, not the host lookup, and no service-call row is started. So any public https address will do here, and
    // none is ever contacted; the default is a reserved example name.
    const paidUrl = x402Url ?? 'https://paid.example.com/price';
    const callsBefore = (await one('select count(*)::int as n from sv_service_calls where agent_id = $1', [agent.agent_id])).n;
    const refused = await act('x402_fetch', social.turnId, { url: paidUrl, reason: 'e2e: a paid call with no fuel must be refused' });
    assert.equal(refused.status, 'failed', `a paid call with no fuel was not refused: ${JSON.stringify(refused).slice(0, 300)}`);
    assert.equal(refused.error, NO_FUEL);
    const callsAfter = (await one('select count(*)::int as n from sv_service_calls where agent_id = $1', [agent.agent_id])).n;
    assert.equal(callsAfter, callsBefore, 'a service call was started although the spender is empty: the refusal must come before any request');
    const refusal = await one("select status, result->>'error' as error from sv_actions where action_id = $1", [refused.actionId]);
    assert.deepEqual(refusal, { status: 'failed', error: NO_FUEL }, 'the refusal is on the record as a failed action');
    ok('x402_fetch refused with no fuel, before any request and with nothing signed', new URL(paidUrl).host);
    await finish(social.turnId, 'e2e: paid services checked');

    // ---------------- 2 and 3. the treasury turn, with a request of the creator's ----------------
    const requestId = `req_${randomUUID()}`;
    await db.query("insert into sv_memories (id, agent_id, text, sources, tags, created_at) values ($1, $2, $3, $4::jsonb, $5::jsonb, now() - interval '1 minute')", [requestId, agent.agent_id, 'Set a little USDC aside for paid services.', JSON.stringify(['creator-chat']), JSON.stringify(['creator-request', 'for-treasury'])]);
    // One USDC on the treasury, so a transfer to the spender can be simulated. Nothing is executed in this part.
    const anvil = createTestClient({ chain: base, mode: 'anvil', transport: http(rpc) }).extend(publicActions);
    await anvil.impersonateAccount({ address: USDC_WHALE });
    await anvil.setBalance({ address: USDC_WHALE, value: parseEther('1') });
    const funded = await createWalletClient({ account: USDC_WHALE, chain: base, transport: http(rpc) }).writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [agent.kernel, 1_000_000n] });
    await anvil.waitForTransactionReceipt({ hash: funded });
    await anvil.stopImpersonatingAccount({ address: USDC_WHALE });

    const due = (await dueNow());
    assert.equal(due.treasury.on, true, 'the treasury turn is off although the Bounties power is on');
    assert.equal(due.treasury.due, true, `the treasury turn is not due: ${JSON.stringify(due.treasury)}`);
    assert.ok(due.treasury.reasons.includes('treasury_interval'));
    const treasury = (await must('turn', { role: 'treasury' })).json;
    assert.equal(treasury.role, 'treasury');
    for (const tool of X_TOOLS) assert.ok(!treasury.tools.includes(`bootr_agent_${tool}`), `a treasury turn holds ${tool}`);
    for (const tool of ['treasury_read', 'treasury_prepare', 'treasury_execute', 'bounty_post', 'answer_request']) assert.ok(treasury.tools.includes(`bootr_agent_${tool}`), `the treasury turn does not hold ${tool}`);
    assert.equal(treasury.observation.role, 'treasury');
    assert.equal(treasury.observation.social, undefined, 'the treasury observation carries the social section');
    assert.deepEqual(treasury.observation.creatorRequests?.items?.map((i) => i.requestId), [requestId]);
    assert.equal(treasury.observation.fuel?.thoughtsLeft, undefined, 'an own coin was shown a thought estimate');
    // An X tool called all the same is not part of the turn.
    const post = await call('publish_post', { turnId: treasury.turnId, text: 'gm from the treasury turn' });
    assert.equal(post.error, 'tool_unavailable', `a treasury turn took publish_post: ${post.text.slice(0, 200)}`);
    ok('treasury turn opened', `reasons ${due.treasury.reasons.join(', ')}; no X tool, no mention`);

    const read = await act('treasury_read', treasury.turnId);
    assert.equal(read.status, 'completed', read.error);
    assert.equal(Number(read.result.balances.usdc) >= 1, true, 'the treasury read does not show the USDC just sent');
    // `done` before anything was done is refused; the read above is not an action that did it.
    const early = await act('answer_request', treasury.turnId, { requestId, outcome: 'done', reason: 'set aside' });
    assert.equal(early.status, 'failed');
    assert.match(early.error, /done needs an action of this turn/);
    const stranger = await act('treasury_prepare', treasury.turnId, { operation: 'transfer', amount: '0.5', to: PAYEE });
    assert.equal(stranger.status, 'failed', 'a transfer to a stranger was prepared');
    assert.match(stranger.error, /^treasury_operation_not_allowed/);
    const prepared = await act('treasury_prepare', treasury.turnId, { operation: 'transfer', amount: '0.5', memo: 'e2e' });
    assert.equal(prepared.status, 'completed', prepared.error);
    assert.ok(prepared.result.preparedId && prepared.result.expectedHash, 'the prepared operation has no id or hash');
    const op = await one('select kind, status, origin, tx_hash from sv_treasury_ops where op_id = $1', [prepared.result.preparedId]);
    assert.deepEqual(op, { kind: 'fund_model', status: 'prepared', origin: 'model', tx_hash: null });
    ok('treasury read and one operation prepared, nothing executed', prepared.result.description);

    const answered = await act('answer_request', treasury.turnId, { requestId, outcome: 'done', reason: 'prepared 0.5 USDC for the spender; it waits for my next step' });
    assert.equal(answered.status, 'completed', answered.error);
    assert.deepEqual(answered.result, { requestId, outcome: 'done', closed: true });
    const request = await one('select tags from sv_memories where id = $1', [requestId]);
    assert.ok(request.tags.includes('request-done'));
    const answer = await one('select text, sources from sv_memories where supersedes = $1', [requestId]);
    assert.match(answer.text, /^Done: prepared 0\.5 USDC/);
    assert.equal(answer.sources.length, 1);
    ok('a request filed before the switch was shown and answered', requestId);

    // ---------------- 4. a bounty job, from the post to the proposal ----------------
    const posted = await act('bounty_post', treasury.turnId, { task: 'A public page that explains how Base fees are set', criteria: ['It explains the base fee', 'It names its sources'], deliverable: 'link', amountUsdc: 0.1 });
    assert.equal(posted.status, 'completed', posted.error);
    const jobId = posted.result.jobId;
    assert.match(jobId, /^0x[0-9a-f]{64}$/);
    await finish(treasury.turnId, 'e2e: one operation prepared, one request answered, one job posted');
    assert.equal((await dueNow()).treasury.due, false, 'the treasury turn is due again right after its finish');
    ok('bounty job posted from the treasury turn', `${jobId.slice(0, 18)} ${posted.result.status}`);

    // The window closes and one page entry is collected: written here as the sweep leaves it for an own coin.
    await db.query('begin');
    await db.query(
      "update sv_bounty_jobs set status = 'judging', opened_at = coalesce(opened_at, now() - interval '2 hours'), closes_at = now() - interval '1 minute', conversation_id = coalesce(conversation_id, 'e2e'), attempts = 1, entries_received = 1, entries_eligible = 1, entries_considered = 1, publish_not_before = null, updated_at = now() where id = $1",
      [jobId],
    );
    await db.query(
      "insert into sv_bounty_entries (id, job_id, agent_id, reply_id, author_id, author_created_at, received_at, kind, artefact, payee, eligible, considered, n, created_at) values ($1, $2, $3, '900000000000000001', '900000000000000002', now() - interval '400 days', now() - interval '10 minutes', 'link', $4::jsonb, $5, true, true, 1, now())",
      [`${jobId}:900000000000000001`, jobId, agent.agent_id, JSON.stringify({ url: 'https://fees.example/base', host: 'fees.example', sha256: sha256(EXCERPT), excerpt: EXCERPT }), PAYEE],
    );
    await db.query('commit');

    const waiting = (await dueNow());
    assert.equal(waiting.judge.due, true, `no job waits for a ruling: ${JSON.stringify(waiting.judge)}`);
    assert.ok(waiting.judge.jobs.some((j) => j.jobId === jobId && j.entries === 1));
    const judge = (await must('turn', { role: 'judge', jobId })).json;
    assert.equal(judge.role, 'judge');
    assert.deepEqual(judge.observation.job.entries, [{ n: 1, kind: 'link' }]);
    assert.equal(judge.observation.job.jobId, jobId);
    for (const tool of [...MONEY_TOOLS, ...X_TOOLS, 'x402_fetch', 'remember']) assert.ok(!judge.tools.includes(`bootr_agent_${tool}`), `a judge turn holds ${tool}`);
    const seen = JSON.stringify(judge);
    for (const secret of [PAYEE, '900000000000000001', '900000000000000002', 'fees.example']) assert.ok(!seen.includes(secret), `the judge turn shows ${secret}`);
    const entry = await act('judge_entry', judge.turnId, { n: 1 });
    assert.equal(entry.status, 'completed', entry.error);
    assert.equal(entry.result.excerpt, EXCERPT);
    assert.ok(!JSON.stringify(entry).includes(PAYEE));
    const unknown = await act('judge_entry', judge.turnId, { n: 2 });
    assert.equal(unknown.error, 'judge_entry_unknown: this job has no entry 2.');
    const ruled = await act('judge', judge.turnId, { winner: 1, perCriterion: { 1: ['pass', 'pass'] }, reason: 'A short page that explains the base fee and names the Base docs as its source.' });
    assert.equal(ruled.status, 'completed', ruled.error);
    assert.deepEqual(ruled.result, { jobId, accepted: true, winner: 1 });
    assert.equal(ruled.turnEnded, true);
    const job = await one('select status, payee, approval_id, verdict from sv_bounty_jobs where id = $1', [jobId]);
    assert.equal(job.status, 'proposed');
    assert.equal(job.payee, PAYEE, 'the payee is not the one on the entry record');
    assert.equal(job.verdict.thought.model, 'own-agent');
    const approval = await one('select kind, status, meta from sv_approvals where id = $1', [job.approval_id]);
    assert.equal(approval.kind, 'bounty_payout');
    assert.equal(approval.status, 'pending_approval');
    assert.equal(approval.meta.payee, PAYEE);
    // One ruling per job: the turn is over, and no second turn opens for it.
    assert.ok(['turn_closed', 'turn_not_found'].includes((await call('judge', { turnId: judge.turnId, winner: null, perCriterion: { 1: ['fail', 'fail'] }, reason: 'changed my mind' })).error));
    assert.equal((await dueNow()).judge.due, false);
    assert.equal((await one('select payee from sv_bounty_jobs where id = $1', [jobId])).payee, PAYEE);
    ok('bounty job ruled by the client and proposed to the creator', `${jobId.slice(0, 18)} entry 1`);

    // No thought was bought for this coin from the first step to the last.
    const bought = await one('select count(*)::int as n from sv_inference where agent_id = $1 and created_at >= $2', [agent.agent_id, startedAt]);
    assert.equal(bought.n, 0, 'a thought was bought for an own coin');
    ok('no thought bought');
    return { ok: done };
  } finally {
    if (original) await db.query('update sv_agents set config = $2, updated_at = now() where agent_id = $1', [String(seed.agentId), JSON.stringify(original)]).catch(() => undefined);
    await db.end().catch(() => undefined);
    if (transport) await client.close().catch(() => undefined);
  }
}

// Run alone: `node packages/mcp/test/own-agent-e2e.w2.mjs` with the environment named at the top.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({})
    .then((r) => console.log(`\nw2: ${r.ok.length} checks passed`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
