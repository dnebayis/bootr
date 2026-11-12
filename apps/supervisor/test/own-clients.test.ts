/**
 * Own agents (docs/design/byo-agent.md sections 3.2, 3.3 and 13.6): the device-style grant and the credential a
 * creator's AI client holds. This is the first path where a bearer credential, not a fresh wallet signature, can make
 * an agent post, so the tests here are about what a wrong wallet, a used or late code, a stolen, expired or revoked
 * credential, a client of another coin and a stranger's launch draft can and cannot do.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { CREDENTIAL_RE, DEVICE_CODE_TTL_S, OWN_ERRORS, USER_CODE_RE, type AgentStatus, type ClientsResponse, type ConnectApproveResponse, type ConnectCoinsResponse, type ConnectGrantView, type ConnectStartResponse, type ConnectTokenResponse, type DraftClientsResponse, type DueView, type OwnErrorBody } from '@bootr/shared/own-agent';
import { actions, agentClients, agentGrants, agents } from '../src/db/schema.js';
import { GRANT_MISSES_PER_MINUTE, MAX_PENDING_GRANTS, adoptDraftClients, cleanText, hashSecret, newUserCode } from '../src/own/clients.js';
import { ownHooks } from '../src/own/registry.js';
import { AGENT_ID, CREATOR, KERNEL, TOKEN } from './helpers.js';
import { OTHER_AGENT_ID, OTHER_CREATOR, OTHER_KERNEL, connectClient, credentialHash, newCredential, openSocial, ownWorld, seedOther, seedOwn, turnOf, type OwnWorld } from './own-helpers.js';

const DAY = 86_400_000;
const DRAFT = '11111111-2222-4333-8444-555555555555';
const STRANGER = '0x9000000000000000000000000000000000000009';

async function start(world: OwnWorld, body: Record<string, unknown> = {}) {
  const res = await world.call<ConnectStartResponse>('POST', '/internal/own/connect/start', { siteUrl: 'https://bootr.fun', clientName: 'Claude Code', ...body });
  expect(res.status).toBe(200);
  return res.body;
}

const approveCoin = (world: OwnWorld, userCode: string, over: Record<string, unknown> = {}) =>
  world.call<ConnectApproveResponse & OwnErrorBody>('POST', '/internal/own/connect/approve', { userCode, creator: CREATOR, target: { kind: 'coin', kernel: KERNEL, agentId: AGENT_ID }, ...over });

/**
 * The token call as the web makes it: the web makes the credential and sends only its SHA-256. The supervisor's answer
 * never carries a credential; the one this helper made is put on the body afterwards, as the web does for its caller.
 */
async function token(world: OwnWorld, deviceCode: string) {
  const credential = newCredential();
  const res = await world.call<ConnectTokenResponse & OwnErrorBody>('POST', '/internal/own/connect/token', { deviceCode, credentialHash: credentialHash(credential) });
  expect(res.body).not.toHaveProperty('credential');
  expect(JSON.stringify(res.body)).not.toContain('bootr_agt_');
  if (res.body.status === 'approved') (res.body as { credential: string }).credential = credential;
  return res;
}

describe('own agent: connecting a client', () => {
  it('a grant goes from pending to approved to redeemed, hands the credential out once, and stores hashes only', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const grant = await start(w, { coin: '$TEST' });
      expect(grant.userCode).toMatch(USER_CODE_RE);
      expect(grant.verificationUri).toBe('https://bootr.fun/connect');
      expect(grant.verificationUriComplete).toBe(`https://bootr.fun/connect/${grant.userCode}`);
      expect(grant).toMatchObject({ expiresIn: DEVICE_CODE_TTL_S, interval: 5 });

      const view = await w.call<ConnectGrantView>('GET', `/internal/own/connect/grant?code=${grant.userCode}`);
      expect(view.body).toMatchObject({ userCode: grant.userCode, clientName: 'Claude Code', coinHint: '$TEST', status: 'pending' });
      // What the approval page reads never carries the device code or its hash.
      expect(JSON.stringify(view.body)).not.toContain(grant.deviceCode);
      expect((await token(w, grant.deviceCode)).body).toEqual({ status: 'pending' });

      const approved = await approveCoin(w, grant.userCode, { label: 'My laptop' });
      expect(approved.status).toBe(200);
      expect(approved.body).toEqual({ ok: true, label: 'My laptop', target: { kind: 'coin', coin: { agentId: AGENT_ID, kernel: KERNEL, token: TOKEN, symbol: 'TEST', name: 'Test Coin' } } });
      expect((await w.call<ConnectGrantView>('GET', `/internal/own/connect/grant?code=${grant.userCode}`)).body.status).toBe('approved');

      const first = await token(w, grant.deviceCode);
      expect(first.status).toBe(200);
      if (first.body.status !== 'approved') throw new Error('expected an approved grant');
      expect(first.body.credential).toMatch(CREDENTIAL_RE);
      expect(first.body.clientId).toMatch(/^cli_[0-9a-f]{16}$/);
      expect(first.body.label).toBe('My laptop');
      expect(Date.parse(first.body.expiresAt)).toBe(w.ctx.now() + 90 * DAY);

      // The same device code again: the grant was used, and no second credential exists.
      const again = await token(w, grant.deviceCode);
      expect(again.status).toBe(410);
      expect(again.body).toEqual({ error: 'grant_used', message: OWN_ERRORS.grant_used.message });
      expect((await w.call<ConnectGrantView>('GET', `/internal/own/connect/grant?code=${grant.userCode}`)).body.status).toBe('redeemed');

      // Neither secret is in the database: only their SHA-256.
      const clients = await w.db.select().from(agentClients);
      expect(clients).toHaveLength(1);
      expect(clients[0]!.tokenHash).toBe(createHash('sha256').update(first.body.credential).digest('hex'));
      const grants = await w.db.select().from(agentGrants);
      expect(grants[0]!.deviceHash).toBe(hashSecret(grant.deviceCode));
      const everything = JSON.stringify([clients, grants, await w.db.select().from(actions)]);
      expect(everything).not.toContain(first.body.credential);
      expect(everything).not.toContain(first.body.credential.slice('bootr_agt_'.length));
      expect(everything).not.toContain(grant.deviceCode);
      // The connection is on the coin's tape, with nothing private in it.
      const tape = await w.call<{ items: { kind: string; summary: string }[] }>('GET', `/internal/agents/${AGENT_ID}/activity`);
      expect(tape.body.items.find((i) => i.kind === 'config')?.summary).toBe('Config updated: AI client connected');
    } finally {
      await w.close();
    }
  });

  it('only the wallet that launched the coin can approve, and the signed coin must be a real one', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const grant = await start(w);
      const stranger = await approveCoin(w, grant.userCode, { creator: STRANGER });
      expect(stranger.status).toBe(403);
      expect(stranger.body.error).toBe('not_creator');
      // The agent id and the kernel were both in the signed text: a kernel of another coin is no coin at all.
      expect((await approveCoin(w, grant.userCode, { target: { kind: 'coin', kernel: OTHER_KERNEL, agentId: AGENT_ID } })).body.error).toBe('unknown_coin');
      expect((await approveCoin(w, grant.userCode, { target: { kind: 'coin', kernel: KERNEL, agentId: '999' } })).body.error).toBe('unknown_coin');
      expect((await approveCoin(w, grant.userCode, { creator: 'not-an-address' })).status).toBe(400);
      expect((await approveCoin(w, grant.userCode, { target: { kind: 'wallet' } })).body.error).toBe('invalid_request');
      // None of that used the grant up or made a client: the creator can still approve, in any letter case of the address.
      expect(await w.db.select().from(agentClients)).toHaveLength(0);
      expect((await token(w, grant.deviceCode)).body).toEqual({ status: 'pending' });
      expect((await approveCoin(w, grant.userCode, { creator: CREATOR.toLowerCase() })).status).toBe(200);
      // An approved grant cannot be approved again, by anyone, for anything.
      const second = await approveCoin(w, grant.userCode);
      expect(second.status).toBe(410);
      expect(second.body.error).toBe('grant_used');
    } finally {
      await w.close();
    }
  });

  it('a request that names one coin is for that coin alone: no other coin and no launch draft can be approved for it (security review M2)', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      // A second coin of the same creator, and a third with the same symbol as the second (symbols are not unique).
      const address = (lead: string, n: string) => `0x${lead}${n.padStart(39, '0')}`;
      const SECOND = { agentId: '9', kernel: address('2', '9'), token: address('3', '9') };
      const twin = (n: string, creator: string) => ({ config: { runner: 'own', agentId: n, token: { address: address('3', n), symbol: 'TWIN', name: `Twin ${n}`, chainId: 84532 }, kernel: { address: address('2', n) } }, agent: { agentId: n, token: address('3', n), kernel: address('2', n), creator }, runtime: { agentId: n } });
      await seedOwn(w, { config: { agentId: SECOND.agentId, token: { address: SECOND.token, symbol: 'SECOND', name: 'Second Coin', chainId: 84532 }, kernel: { address: SECOND.kernel } }, agent: { ...SECOND }, runtime: { agentId: SECOND.agentId } });
      await seedOwn(w, twin('11', CREATOR));
      await seedOwn(w, twin('12', STRANGER));
      const mine = { agentId: AGENT_ID, kernel: KERNEL, token: TOKEN, symbol: 'TEST', name: 'Test Coin' };
      const toSecond = { target: { kind: 'coin', kernel: SECOND.kernel, agentId: SECOND.agentId } };

      // Named by its symbol (with or without the $, in any case), its kernel or its token: the start answer says which coin.
      for (const named of ['$TEST', 'test', KERNEL, KERNEL.toLowerCase(), TOKEN]) {
        const grant = await start(w, { coin: named });
        expect([named, grant.coin]).toEqual([named, mine]);
        const view = await w.call<ConnectGrantView>('GET', `/internal/own/connect/grant?code=${grant.userCode}`);
        expect(view.body.coin).toEqual(mine);
        // The creator signs for another of their own coins, or for the draft of their next launch: refused, and nothing is used up.
        const other = await approveCoin(w, grant.userCode, toSecond);
        expect([other.status, other.body.error, other.body.message]).toEqual([409, 'wrong_coin', OWN_ERRORS.wrong_coin.message]);
        expect((await w.call<OwnErrorBody>('POST', '/internal/own/connect/approve', { userCode: grant.userCode, creator: CREATOR, target: { kind: 'draft', draftId: DRAFT } })).body.error).toBe('wrong_coin');
        expect((await token(w, grant.deviceCode)).body).toEqual({ status: 'pending' });
      }
      expect(await w.db.select().from(agentClients)).toHaveLength(0);
      // For the coin it names it is approved as ever, and the credential is that coin's.
      const grant = await start(w, { coin: '$TEST' });
      expect((await approveCoin(w, grant.userCode)).status).toBe(200);
      expect((await w.call<ConnectGrantView>('GET', `/internal/own/connect/grant?code=${grant.userCode}`)).body.coin ?? null).toBeNull();
      const got = await token(w, grant.deviceCode);
      expect(got.body.status === 'approved' && got.body.target).toEqual({ kind: 'coin', coin: mine });

      // A name that fits no coin, or two, binds nothing: it stays a hint and the creator chooses.
      for (const named of ['$TWIN', '$NOPE', '0x00000000000000000000000000000000000000aa', 'two words', undefined]) {
        const loose = await start(w, named === undefined ? {} : { coin: named });
        expect([named, loose.coin]).toEqual([named, undefined]);
        expect((await w.call<ConnectGrantView>('GET', `/internal/own/connect/grant?code=${loose.userCode}`)).body.coin).toBeNull();
        expect((await w.db.select().from(agentGrants)).find((g) => g.userCode === loose.userCode)?.agentId).toBeNull();
      }
      const loose = await start(w, { coin: '$TWIN' });
      expect((await approveCoin(w, loose.userCode, toSecond)).status).toBe(200);
      // A request started for this coin and not yet approved goes with "disconnect all" too.
      const bound = await start(w, { coin: KERNEL });
      await w.call('POST', `/internal/agents/${AGENT_ID}/clients/revoke`, { by: CREATOR, all: true });
      expect((await token(w, bound.deviceCode)).body.error).toBe('grant_not_found');
      // A revoked coin is no coin to name.
      await w.db.update(agents).set({ status: 'revoked' }).where(eq(agents.agentId, AGENT_ID));
      expect((await start(w, { coin: KERNEL })).coin).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it('a grant runs out after ten minutes, approved or not', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const t0 = w.ctx.now();
      const late = await start(w);
      const approvedLate = await start(w);
      expect((await approveCoin(w, approvedLate.userCode)).status).toBe(200);
      w.setNow(t0 + DEVICE_CODE_TTL_S * 1000);
      const approve = await approveCoin(w, late.userCode);
      expect(approve.status).toBe(410);
      expect(approve.body.error).toBe('grant_expired');
      expect((await token(w, late.deviceCode)).body.error).toBe('grant_expired');
      // Approved in time but never collected: no credential comes out of it after the ten minutes.
      expect((await token(w, approvedLate.deviceCode)).body.error).toBe('grant_expired');
      expect((await w.call<ConnectGrantView>('GET', `/internal/own/connect/grant?code=${late.userCode}`)).body.status).toBe('expired');
      expect(await w.db.select().from(agentClients)).toHaveLength(0);
      // Codes nobody ever issued.
      expect((await token(w, 'x'.repeat(43))).status).toBe(404);
      expect((await w.call<OwnErrorBody>('GET', '/internal/own/connect/grant?code=AAAA-EEEE')).body.error).toBe('grant_not_found');
      expect((await approveCoin(w, 'BCDF-GHJK')).body.error).toBe('grant_not_found');
      // A day later a new grant sweeps the old rows away.
      w.setNow(t0 + DAY + 1000);
      await start(w);
      expect(await w.db.select().from(agentGrants)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('holds the requests waiting for an approval to five hundred over all callers, and frees a place when one is approved or runs out (security review M4)', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const t0 = w.ctx.now();
      const first = await start(w);
      // Starting needs no credential: a flood of them from anywhere stops at the cap, whoever sends them.
      const row = (n: number) => ({ deviceHash: hashSecret(`flood-${n}`), userCode: `flood-${n}`, clientName: 'AI client', status: 'pending' as const, createdAt: new Date(t0), expiresAt: new Date(t0 + (n === 0 ? 120_000 : DEVICE_CODE_TTL_S * 1000)) });
      await w.db.insert(agentGrants).values(Array.from({ length: MAX_PENDING_GRANTS - 1 }, (_, n) => row(n)));
      const refused = await w.call<OwnErrorBody>('POST', '/internal/own/connect/start', { siteUrl: 'https://bootr.fun' });
      expect([refused.status, refused.body.error]).toEqual([429, 'rate_limited']);
      // It says when the oldest waiting request runs out, which is when a place is free again.
      expect(refused.body.retryAt).toBe(new Date(t0 + 120_000).toISOString());
      expect(await w.db.select({ n: agentGrants.userCode }).from(agentGrants)).toHaveLength(MAX_PENDING_GRANTS);
      // A request that was approved no longer waits: its place is free.
      expect((await approveCoin(w, first.userCode)).status).toBe(200);
      const next = await start(w);
      expect((await w.call<OwnErrorBody>('POST', '/internal/own/connect/start', { siteUrl: 'https://bootr.fun' })).body.error).toBe('rate_limited');
      // So is one that ran out.
      w.setNow(t0 + 120_000);
      await start(w);
      expect((await w.call<OwnErrorBody>('POST', '/internal/own/connect/start', { siteUrl: 'https://bootr.fun' })).body.error).toBe('rate_limited');
      // None of it touched a request that was already waiting.
      expect((await approveCoin(w, next.userCode)).status).toBe(200);
    } finally {
      await w.close();
    }
  });

  it('stops looking codes up for the rest of the minute once a hundred and twenty lookups found nothing, over all callers (security review M4)', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const t0 = w.ctx.now();
      const real = await start(w);
      const letters = 'BCDFGHJKLMNPQRSTVWXZ';
      const guess = (n: number) => `${letters[n % 20]}${letters[Math.floor(n / 20) % 20]}${letters[Math.floor(n / 400) % 20]}Z-ZZZZ`;
      const view = (code: string) => w.call<ConnectGrantView & OwnErrorBody>('GET', `/internal/own/connect/grant?code=${code}`);
      // Guesses, through the page's read and through an approval alike.
      for (let n = 0; n < GRANT_MISSES_PER_MINUTE; n++) {
        const miss = n % 2 ? await view(guess(n)) : await approveCoin(w, guess(n));
        expect([n, miss.body.error]).toEqual([n, 'grant_not_found']);
      }
      // Now nothing is looked up, a guess or the real code: a guesser learns nothing more this minute.
      for (const code of [guess(999), real.userCode]) {
        const closed = await view(code);
        expect([closed.status, closed.body.error, closed.body.retryAt]).toEqual([429, 'rate_limited', new Date(t0 + 60_000).toISOString()]);
      }
      expect((await approveCoin(w, real.userCode)).body.error).toBe('rate_limited');
      // A code of another shape was never a lookup, and the client's own poll goes by its device code, not by this.
      expect((await view('nope')).body.error).toBe('grant_not_found');
      expect((await token(w, real.deviceCode)).body).toEqual({ status: 'pending' });
      // The next minute it is open again, and the real request was not harmed.
      w.setNow(t0 + 60_000);
      expect((await view(real.userCode)).body.status).toBe('pending');
      expect((await approveCoin(w, real.userCode)).status).toBe(200);
      // Lookups that find their request never count.
      for (let n = 0; n < GRANT_MISSES_PER_MINUTE + 5; n++) expect((await view(real.userCode)).status).toBe(200);
    } finally {
      await w.close();
    }
  });

  it('the name the client gave is its label, unless the creator typed another one on the approval page', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      // `bootr own connect --label "My laptop"` sends the name with the request; the page's field was left empty.
      const untouched = await start(w, { clientName: 'My laptop' });
      expect((await approveCoin(w, untouched.userCode)).body.label).toBe('My laptop');
      expect((await token(w, untouched.deviceCode)).body).toMatchObject({ status: 'approved', label: 'My laptop' });
      // A field holding spaces only is a field left empty.
      const blank = await start(w, { clientName: 'Desk machine' });
      expect((await approveCoin(w, blank.userCode, { label: '   ' })).body.label).toBe('Desk machine');
      expect((await token(w, blank.deviceCode)).body).toMatchObject({ status: 'approved', label: 'Desk machine' });
      // The creator typed a name of their own: that one is kept.
      const typed = await start(w, { clientName: 'Third machine' });
      expect((await approveCoin(w, typed.userCode, { label: 'Office' })).body.label).toBe('Office');
      expect((await token(w, typed.deviceCode)).body).toMatchObject({ status: 'approved', label: 'Office' });
      const list = await w.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`);
      expect(list.body.clients.map((c) => c.label)).toEqual(['My laptop', 'Desk machine', 'Office']);
    } finally {
      await w.close();
    }
  });

  it('a coin has at most three clients, counting approvals not yet collected; disconnecting one frees a place', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const a = await connectClient(w, { label: 'one' });
      await connectClient(w, { label: 'two' });
      // The third is approved but its client has not collected the credential yet: the place is taken all the same.
      const third = await start(w);
      expect((await approveCoin(w, third.userCode)).status).toBe(200);
      const fourth = await start(w);
      const refused = await approveCoin(w, fourth.userCode);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('too_many_clients');
      expect((await token(w, third.deviceCode)).body.status).toBe('approved');
      const list = await w.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`);
      expect(list.body.max).toBe(3);
      expect(list.body.clients.map((c) => c.label)).toEqual(['one', 'two', 'Claude Code']);
      // No credential, no hash and no creator in what the console lists.
      expect(Object.keys(list.body.clients[0]!).sort()).toEqual(['clientId', 'createdAt', 'expiresAt', 'label', 'lastUsedAt']);

      const revoked = await w.call<ClientsResponse>('POST', `/internal/agents/${AGENT_ID}/clients/revoke`, { by: CREATOR, clientId: a.clientId });
      expect(revoked.status).toBe(200);
      expect(revoked.body.clients).toHaveLength(2);
      expect((await approveCoin(w, fourth.userCode)).status).toBe(200);
    } finally {
      await w.close();
    }
  });

  it('approvals of different codes that arrive together cannot take more places than the coin has', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      // Eight requests, approved at the same moment: each used to count the places before any of them took one.
      const grants = [];
      for (let i = 0; i < 8; i++) grants.push(await start(w));
      const answers = await Promise.all(grants.map((g) => approveCoin(w, g.userCode)));
      expect(answers.map((a) => a.status).sort()).toEqual([200, 200, 200, 409, 409, 409, 409, 409]);
      for (const refused of answers.filter((a) => a.status === 409)) expect(refused.body.error).toBe('too_many_clients');
      expect((await w.db.select().from(agentGrants)).filter((g) => g.status === 'approved')).toHaveLength(3);
      // The same for a launch draft, per approving wallet.
      const drafts = [];
      for (let i = 0; i < 6; i++) drafts.push(await start(w));
      const forDraft = await Promise.all(drafts.map((g) => w.call<OwnErrorBody>('POST', '/internal/own/connect/approve', { userCode: g.userCode, creator: STRANGER, target: { kind: 'draft', draftId: DRAFT } })));
      expect(forDraft.map((a) => a.status).sort()).toEqual([200, 200, 200, 409, 409, 409]);
      // One code approved twice at the same moment is still approved once.
      const twice = await start(w);
      await w.call('POST', `/internal/agents/${AGENT_ID}/clients/revoke`, { by: CREATOR, all: true });
      const both = await Promise.all([approveCoin(w, twice.userCode), approveCoin(w, twice.userCode)]);
      expect(both.map((a) => a.status).sort()).toEqual([200, 410]);
    } finally {
      await w.close();
    }
  });

  it('a user code is eight consonants in two groups, and a name is cleaned before it is stored or shown', () => {
    for (let i = 0; i < 200; i++) expect(newUserCode()).toMatch(USER_CODE_RE);
    expect(cleanText(`  Claude${String.fromCodePoint(0x202e)} Code${String.fromCodePoint(0x200b)}\n\t(work)  `, 40)).toBe('Claude Code (work)');
    expect(cleanText('x'.repeat(100), 40)).toHaveLength(40);
    expect(cleanText(42, 40)).toBe('');
  });

  it('lists the coins a wallet launched, newest first, and nobody else\'s', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      await seedOther(w);
      const mine = await w.call<ConnectCoinsResponse>('GET', `/internal/own/connect/coins?creator=${CREATOR.toLowerCase()}`);
      expect(mine.body.coins).toEqual([{ agentId: AGENT_ID, kernel: KERNEL, token: TOKEN, symbol: 'TEST', name: 'Test Coin' }]);
      expect((await w.call<ConnectCoinsResponse>('GET', `/internal/own/connect/coins?creator=${STRANGER}`)).body.coins).toEqual([]);
      expect((await w.call<OwnErrorBody>('GET', '/internal/own/connect/coins?creator=nobody')).body.error).toBe('invalid_request');
    } finally {
      await w.close();
    }
  });
});

describe('own agent: what a credential opens', () => {
  it('opens the one coin it was approved for: status and due answer, and another coin\'s turn does not exist for it', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      await seedOther(w);
      const mine = await connectClient(w);
      const theirs = await connectClient(w, { creator: OTHER_CREATOR, agentId: OTHER_AGENT_ID, kernel: OTHER_KERNEL });
      const status = await w.run<AgentStatus>('status', mine.credential);
      expect(status.status).toBe(200);
      expect(status.body.coin.agentId).toBe(AGENT_ID);
      expect(status.body.runner).toBe('own');
      expect(status.body.client.clientId).toBe(mine.clientId);
      expect(status.body.powers).toMatchObject({ xRead: true, xPublish: true, images: false });
      expect(status.body.picturesLeftToday).toBe(6);
      expect(status.body.forcedTurnsLeftToday).toBe(6);
      expect(status.body.fuel).toEqual({ spendableUsdc: '20.00', reserveUsdc: '50.00' });
      // Nothing in a status carries the credential back.
      expect(JSON.stringify(status.body)).not.toContain(mine.credential);

      const turn = await openSocial(w, mine.credential);
      // The other coin's client names this coin's turn: for its own coin there is no such turn, and nothing happens here.
      const cross = await w.run<OwnErrorBody>('act', theirs.credential, { turnId: turn.turnId, tool: 'publish_post', input: { text: 'posted through another coin\'s turn' } });
      expect(cross.status).toBe(404);
      expect(cross.body.error).toBe('turn_not_found');
      expect((await w.run<OwnErrorBody>('finish', theirs.credential, { turnId: turn.turnId, memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(w.ctx.now() + 3_600_000).toISOString() })).body.error).toBe('turn_not_found');
      expect(w.sender.published).toHaveLength(0);
      expect((await turnOf(w))?.steps).toBe(0);
      expect((await w.run<DueView>('due', theirs.credential)).body.coin.agentId).toBe(OTHER_AGENT_ID);
      // A turn id that was never issued, and one that is not a turn id at all.
      expect((await w.run<OwnErrorBody>('act', mine.credential, { turnId: `otn_${'0'.repeat(32)}`, tool: 'read_market', input: {} })).body.error).toBe('turn_not_found');
      expect((await w.run<OwnErrorBody>('act', mine.credential, { turnId: 'DROP TABLE', tool: 'read_market', input: {} })).body.error).toBe('invalid_request');
    } finally {
      await w.close();
    }
  });

  it('refuses a missing, malformed or unknown credential with one answer, and never says which', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const flipped = credential.slice(0, -1) + (credential.endsWith('A') ? 'B' : 'A');
      const hash = credentialHash(credential);
      // What arrives is the SHA-256 of a credential. None of these is the hash of a live one; the credential itself is not one either.
      for (const bad of [undefined, '', 'abc', hash.toUpperCase(), ` ${hash}`, `${hash}0`, hash.slice(1), credentialHash(flipped), credential, { $ne: null }, [hash], 12345]) {
        for (const op of ['status', 'due', 'turn', 'act', 'finish', 'upload', 'disconnect']) {
          const res = await w.call<OwnErrorBody>('POST', `/internal/own/run/${op}`, { credentialHash: bad, role: 'social' });
          expect([op, res.status]).toEqual([op, 401]);
          expect(res.body).toEqual({ error: 'unauthorized', message: OWN_ERRORS.unauthorized.message });
        }
      }
      // The credential in the clear opens nothing, alone or beside a wrong hash: this service only ever compares hashes.
      expect((await w.call<OwnErrorBody>('POST', '/internal/own/run/status', { credential })).body.error).toBe('unauthorized');
      expect((await w.call<OwnErrorBody>('POST', '/internal/own/run/status', { credentialHash: credentialHash(flipped), credential })).body.error).toBe('unauthorized');
      // The hash is read from the head of the body before the rest is parsed: anywhere else it is not looked for,
      expect((await w.call<OwnErrorBody>('POST', '/internal/own/run/status', { role: 'social', credentialHash: hash })).body.error).toBe('unauthorized');
      // a body that is not JSON after a live hash is refused as a body, and after a dead one as a credential,
      expect((await w.raw('POST', '/internal/own/run/status', `{"credentialHash":"${hash}",oops`)).body.error).toBe('invalid_request');
      expect((await w.raw('POST', '/internal/own/run/status', `{"credentialHash":"${credentialHash(flipped)}",oops`)).body.error).toBe('unauthorized');
      // and a second hash further down, which would win the parse, does not stand in for the one that was checked.
      expect((await w.raw('POST', '/internal/own/run/status', `{"credentialHash":"${hash}","credentialHash":"${credentialHash(flipped)}"}`)).body.error).toBe('unauthorized');
      expect((await w.raw('POST', '/internal/own/run/status', `{"credentialHash":"${hash}"}`)).status).toBe(200);
      // What the web asks before it reads an upload's body: is this credential live on a coin its client runs? Megabytes
      // behind a hash nobody holds are answered from the head of the body alone, and never parsed.
      expect((await w.run('verify', credential)).body).toEqual({ ok: true });
      expect((await w.run<OwnErrorBody>('verify', flipped)).body.error).toBe('unauthorized');
      const unparsed = await w.raw('POST', '/internal/own/run/upload', `{"credentialHash":"${credentialHash(flipped)}","dataBase64":"${'A'.repeat(2 * 1024 * 1024)}`);
      expect([unparsed.status, unparsed.body.error]).toEqual([401, 'unauthorized']);
      expect((await w.call<OwnErrorBody>('POST', '/internal/own/run/steal', { credentialHash: hash })).body.error).toBe('invalid_request');
      expect(await turnOf(w)).toBeNull();
      // A grant is redeemed for a hash the web made; without one nothing is redeemed and no credential is made here.
      const grant = await start(w);
      expect((await approveCoin(w, grant.userCode)).status).toBe(200);
      for (const missing of [undefined, '', credential, hash.toUpperCase()]) {
        const refused = await w.call<OwnErrorBody>('POST', '/internal/own/connect/token', { deviceCode: grant.deviceCode, credentialHash: missing });
        expect([refused.status, refused.body.error, refused.body.field]).toEqual([400, 'invalid_request', 'credentialHash']);
      }
      expect((await w.db.select().from(agentGrants)).find((g) => g.userCode === grant.userCode)?.status).toBe('approved');
    } finally {
      await w.close();
    }
  });

  it('a credential runs out after 90 days and a revoked one is refused on its next call, its open turn closed', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const t0 = w.ctx.now();
      const kept = await connectClient(w, { label: 'kept' });
      const lost = await connectClient(w, { label: 'lost laptop' });
      const turn = await openSocial(w, lost.credential);

      // Only the coin's creator disconnects a client from the console.
      const stranger = await w.call<OwnErrorBody>('POST', `/internal/agents/${AGENT_ID}/clients/revoke`, { by: STRANGER, clientId: lost.clientId });
      expect(stranger.status).toBe(403);
      expect(stranger.body.error).toBe('not_creator');
      expect((await w.call<OwnErrorBody>('POST', `/internal/agents/${AGENT_ID}/clients/revoke`, { by: CREATOR, clientId: 'cli_0000000000000000' })).body.error).toBe('client_not_found');
      expect((await w.call<OwnErrorBody>('POST', '/internal/agents/999/clients/revoke', { by: CREATOR, all: true })).body.error).toBe('unknown_coin');
      expect((await turnOf(w))?.own?.turnId).toBe(turn.turnId);

      const revoked = await w.call<ClientsResponse>('POST', `/internal/agents/${AGENT_ID}/clients/revoke`, { by: CREATOR, clientId: lost.clientId });
      expect(revoked.body.clients.map((c) => c.clientId)).toEqual([kept.clientId]);
      // The turn the revoked client had open is gone, and its credential opens nothing.
      expect(await turnOf(w)).toBeNull();
      for (const op of ['status', 'due', 'turn', 'act', 'finish', 'upload', 'disconnect', 'verify']) {
        const res = await w.run<OwnErrorBody>(op, lost.credential, { role: 'social', turnId: turn.turnId, tool: 'publish_post', input: { text: 'still here' } });
        expect([op, res.status, res.body.error]).toEqual([op, 401, 'credential_revoked']);
      }
      expect(w.sender.published).toHaveLength(0);
      // The other client of the same coin is untouched; the old turn id tells it the turn is over.
      expect((await w.run<AgentStatus>('status', kept.credential)).status).toBe(200);
      expect((await w.run<OwnErrorBody>('act', kept.credential, { turnId: turn.turnId, tool: 'read_market', input: {} })).body.error).toBe('turn_closed');

      w.setNow(t0 + 90 * DAY);
      const expired = await w.run<OwnErrorBody>('status', kept.credential);
      expect(expired.status).toBe(401);
      expect(expired.body.error).toBe('credential_expired');
      expect((await w.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`)).body.clients).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('a client gives its own credential up with disconnect, and "disconnect all" leaves none', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const a = await connectClient(w);
      const b = await connectClient(w);
      const turn = await openSocial(w, a.credential);
      expect((await w.run('disconnect', a.credential)).body).toEqual({ ok: true });
      expect(await turnOf(w)).toBeNull();
      expect((await w.run<OwnErrorBody>('act', a.credential, { turnId: turn.turnId, tool: 'read_market', input: {} })).body.error).toBe('credential_revoked');
      const all = await w.call<ClientsResponse>('POST', `/internal/agents/${AGENT_ID}/clients/revoke`, { by: CREATOR, all: true });
      expect(all.body.clients).toEqual([]);
      expect((await w.run<OwnErrorBody>('status', b.credential)).body.error).toBe('credential_revoked');
    } finally {
      await w.close();
    }
  });

  it('"disconnect all" leaves no approval a client could still collect, and the creator sees and can cancel one (security review M1)', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      await seedOther(w);
      const kept = await connectClient(w, { label: 'my laptop' });
      // Approved a moment ago (say, on a link somebody sent) and not collected yet: no client row exists for it.
      const lure = await start(w, { clientName: 'Their client' });
      expect((await approveCoin(w, lure.userCode, { label: 'Looks like mine' })).status).toBe(200);
      const second = await start(w);
      expect((await approveCoin(w, second.userCode)).status).toBe(200);
      // Another coin's approval, which none of this may touch.
      const theirs = await start(w);
      expect((await approveCoin(w, theirs.userCode, { creator: OTHER_CREATOR, target: { kind: 'coin', kernel: OTHER_KERNEL, agentId: OTHER_AGENT_ID } })).status).toBe(200);

      const list = await w.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`);
      expect(list.body.clients.map((c) => c.clientId)).toEqual([kept.clientId]);
      expect(list.body.waiting).toEqual([
        { userCode: lure.userCode, label: 'Looks like mine', approvedAt: new Date(w.ctx.now()).toISOString(), expiresAt: new Date(w.ctx.now() + DEVICE_CODE_TTL_S * 1000).toISOString() },
        { userCode: second.userCode, label: 'Claude Code', approvedAt: expect.any(String), expiresAt: expect.any(String) },
      ]);
      // Neither the device code's hash nor who approved is in what the console lists.
      expect(JSON.stringify(list.body)).not.toContain(hashSecret(lure.deviceCode));
      expect(JSON.stringify(list.body).toLowerCase()).not.toContain(CREATOR.toLowerCase());

      // One of them, by its code: only the creator, only this coin's.
      const revoke = (body: Record<string, unknown>, agentId = AGENT_ID) => w.call<ClientsResponse & OwnErrorBody>('POST', `/internal/agents/${agentId}/clients/revoke`, body);
      expect((await revoke({ by: STRANGER, userCode: second.userCode })).body.error).toBe('not_creator');
      expect((await revoke({ by: CREATOR, userCode: theirs.userCode })).body.error).toBe('client_not_found');
      expect((await revoke({ by: CREATOR, userCode: 'not a code' })).body.error).toBe('invalid_request');
      const cancelled = await revoke({ by: CREATOR, userCode: second.userCode });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.waiting?.map((x) => x.userCode)).toEqual([lure.userCode]);
      expect((await token(w, second.deviceCode)).body.error).toBe('grant_not_found');
      expect((await revoke({ by: CREATOR, userCode: second.userCode })).body.error).toBe('client_not_found');

      // All: the client, the approval waiting to be collected, and a request started for this coin that nobody approved yet.
      const all = await revoke({ by: CREATOR, all: true });
      expect(all.body).toEqual({ clients: [], max: 3, waiting: [] });
      const late = await token(w, lure.deviceCode);
      expect([late.status, late.body.error]).toEqual([404, 'grant_not_found']);
      expect((await w.run<OwnErrorBody>('status', kept.credential)).body.error).toBe('credential_revoked');
      expect((await w.db.select().from(agentClients)).filter((c) => !c.revokedAt)).toHaveLength(0);
      // The other coin's approval is still there and still collects.
      expect((await w.call<ClientsResponse>('GET', `/internal/agents/${OTHER_AGENT_ID}/clients`)).body.waiting?.map((x) => x.userCode)).toEqual([theirs.userCode]);
      expect((await token(w, theirs.deviceCode)).body.status).toBe('approved');
      // An approval whose ten minutes passed is not listed.
      const stale = await start(w);
      expect((await approveCoin(w, stale.userCode)).status).toBe(200);
      w.setNow(w.ctx.now() + DEVICE_CODE_TTL_S * 1000);
      expect((await w.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`)).body.waiting).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('"disconnect all" also ends what was approved for the coin\'s launch draft and not collected or not bound yet', async () => {
    const w = await ownWorld();
    try {
      const approveDraft = (userCode: string) => w.call('POST', '/internal/own/connect/approve', { userCode, creator: CREATOR, target: { kind: 'draft', draftId: DRAFT } });
      // One client collected before the launch, and one approval still waiting when the coin exists.
      const early = await start(w);
      expect((await approveDraft(early.userCode)).status).toBe(200);
      const collected = await token(w, early.deviceCode);
      if (collected.body.status !== 'approved') throw new Error('expected an approved grant');
      const waiting = await start(w);
      expect((await approveDraft(waiting.userCode)).status).toBe(200);
      // The launch is registered, and the registration hook has not run.
      await seedOwn(w, { agent: { draftId: DRAFT } });
      expect((await w.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`)).body.waiting?.map((x) => x.userCode)).toEqual([waiting.userCode]);
      const all = await w.call<ClientsResponse>('POST', `/internal/agents/${AGENT_ID}/clients/revoke`, { by: CREATOR, all: true });
      expect(all.body).toEqual({ clients: [], max: 3, waiting: [] });
      expect((await token(w, waiting.deviceCode)).body.error).toBe('grant_not_found');
      expect((await w.run<OwnErrorBody>('status', collected.body.credential)).body.error).toBe('credential_revoked');
    } finally {
      await w.close();
    }
  });

  it('stops working the moment the coin has another creator on record, and for a coin that is revoked', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      await w.db.update(agents).set({ creator: STRANGER }).where(eq(agents.agentId, AGENT_ID));
      expect((await w.run<OwnErrorBody>('status', credential)).body.error).toBe('unauthorized');
      await w.db.update(agents).set({ creator: CREATOR, status: 'revoked' }).where(eq(agents.agentId, AGENT_ID));
      expect((await w.run<OwnErrorBody>('due', credential)).body.error).toBe('unauthorized');
    } finally {
      await w.close();
    }
  });

  it('answers a hosted coin\'s status but runs nothing for it, and says when the agent is still being set up', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w, { config: { runner: 'hosted' } });
      const { credential } = await connectClient(w);
      const status = await w.run<AgentStatus>('status', credential);
      expect(status.status).toBe(200);
      expect(status.body.runner).toBe('hosted');
      for (const op of ['due', 'turn', 'act', 'finish', 'upload', 'verify']) {
        const res = await w.run<OwnErrorBody>(op, credential, { role: 'social', turnId: `otn_${'a'.repeat(32)}`, tool: 'read_market', input: {}, memory: 'm', agenda: 'a', summary: 's', nextAt: new Date().toISOString(), mime: 'image/png', dataBase64: 'AAAA', alt: 'a', description: 'd' });
        expect([op, res.status, res.body.error]).toEqual([op, 409, 'agent_runs_hosted']);
      }
      await w.db.update(agents).set({ status: 'onboarding', config: { ...(await w.db.query.agents.findFirst())!.config, runner: 'own' } }).where(eq(agents.agentId, AGENT_ID));
      expect((await w.run<OwnErrorBody>('due', credential)).body.error).toBe('agent_onboarding');
      expect((await w.run<OwnErrorBody>('turn', credential, { role: 'social' })).body.error).toBe('agent_onboarding');
      expect((await w.run<AgentStatus>('status', credential)).status).toBe(200);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });
});

describe('own agent: a client connected before the launch', () => {
  const approveDraft = (w: OwnWorld, userCode: string, creator: string, draftId = DRAFT) => w.call<ConnectApproveResponse & OwnErrorBody>('POST', '/internal/own/connect/approve', { userCode, creator, target: { kind: 'draft', draftId } });

  async function connectDraft(w: OwnWorld, creator: string, draftId = DRAFT) {
    const grant = await start(w);
    expect((await approveDraft(w, grant.userCode, creator, draftId)).body.target).toEqual({ kind: 'draft', draftId });
    const res = await token(w, grant.deviceCode);
    if (res.body.status !== 'approved') throw new Error('expected an approved grant');
    return res.body;
  }

  it('waits for the launch, is bound when the launch\'s creator is the wallet that approved it, and revoked otherwise', async () => {
    const w = await ownWorld();
    try {
      const mine = await connectDraft(w, CREATOR);
      const strangers = await connectDraft(w, STRANGER);
      expect(mine.target).toEqual({ kind: 'draft', draftId: DRAFT });
      const waiting = await w.call<DraftClientsResponse>('GET', `/internal/own/drafts/${DRAFT}/clients`);
      expect(waiting.body.connected).toBe(true);
      expect(waiting.body.clients).toHaveLength(2);
      // Before the launch the credential opens nothing.
      const early = await w.run<OwnErrorBody>('status', mine.credential);
      expect(early.status).toBe(409);
      expect(early.body.error).toBe('coin_not_launched');

      // The launch is registered with this draft id and CREATOR as its creator.
      const agent = await seedOwn(w, { agent: { draftId: DRAFT } });
      expect(await ownHooks.adoptDraftClients(w.ctx, agent)).toBe(1);
      expect((await w.run<AgentStatus>('status', mine.credential)).body.coin.agentId).toBe(AGENT_ID);
      // The stranger approved a client for somebody else's draft: it never becomes a client of the coin.
      expect((await w.run<OwnErrorBody>('status', strangers.credential)).body.error).toBe('credential_revoked');
      expect((await w.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`)).body.clients.map((c) => c.clientId)).toEqual([mine.clientId]);
      expect(await adoptDraftClients(w.ctx, agent)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('a later launch that copies the draft id decides nothing: the draft belongs to the earliest launch that carries it (security review L3)', async () => {
    // Whichever row the database happens to answer first, the copy registered before or after the real launch.
    for (const copyFirst of [true, false]) {
      const w = await ownWorld();
      try {
        const mine = await connectDraft(w, CREATOR);
        // The creator's launch at block 100; a stranger's at block 200 with the same draft id, read off the chain.
        const real = () => seedOwn(w, { agent: { draftId: DRAFT, launchBlock: 100 } });
        const copy = () => seedOther(w, { agent: { draftId: DRAFT, launchBlock: 200, creator: STRANGER }, config: { creator: { address: STRANGER } } });
        const [realAgent, copyAgent] = copyFirst ? [await copy(), await real()].reverse() : [await real(), await copy()];
        // The copy's registration neither binds nor revokes the creator's client,
        expect(await adoptDraftClients(w.ctx, copyAgent!)).toBe(0);
        expect((await w.db.select().from(agentClients))[0]).toMatchObject({ agentId: null, revokedAt: null });
        // and the client's own first call finds the real launch, not whichever came back first.
        const status = await w.run<AgentStatus & OwnErrorBody>('status', mine.credential);
        expect([copyFirst, status.status, status.body.coin?.agentId]).toEqual([copyFirst, 200, AGENT_ID]);
        expect(await adoptDraftClients(w.ctx, realAgent!)).toBe(0);
        // A client the stranger approves for the id afterwards is judged against the real launch too: revoked.
        const theirs = await connectDraft(w, STRANGER);
        expect((await w.run<OwnErrorBody>('status', theirs.credential)).body.error).toBe('credential_revoked');
        expect((await w.call<ClientsResponse>('GET', `/internal/agents/${OTHER_AGENT_ID}/clients`)).body.clients).toEqual([]);
      } finally {
        await w.close();
      }
    }
  });

  it('a launch with no block on record counts as the earliest, and the lower agent id breaks a tie', async () => {
    const w = await ownWorld();
    try {
      const mine = await connectDraft(w, CREATOR);
      await seedOther(w, { agent: { draftId: DRAFT, launchBlock: 100, creator: STRANGER } });
      await seedOwn(w, { agent: { draftId: DRAFT, launchBlock: 100 } });
      // Agent 7 and agent 8 in the same block: 7 is the draft's launch.
      expect((await w.run<AgentStatus>('status', mine.credential)).body.coin.agentId).toBe(AGENT_ID);
    } finally {
      await w.close();
    }
  });

  it('the wizard\'s list is the draft\'s own secret: nothing after the launch, and only the launching wallet\'s clients when it is named', async () => {
    const w = await ownWorld();
    try {
      const list = (query = '') => w.call<DraftClientsResponse & OwnErrorBody>('GET', `/internal/own/drafts/${DRAFT}/clients${query}`);
      const mine = await connectDraft(w, CREATOR);
      await connectDraft(w, STRANGER);
      // Before the launch the id is known to the creator's browser alone. Told which wallet will launch, the wizard
      // is shown that wallet's clients only: another wallet's would be revoked at registration.
      expect((await list()).body.clients).toHaveLength(2);
      const own = await list(`?creator=${CREATOR.toLowerCase()}`);
      expect(own.body).toEqual({ connected: true, clients: [{ clientId: mine.clientId, label: 'Claude Code', createdAt: expect.any(String) }] });
      expect((await list(`?creator=${OTHER_CREATOR}`)).body).toEqual({ connected: false, clients: [] });
      expect((await list('?creator=nobody')).body.error).toBe('invalid_request');
      // The launch puts the id on chain: from then on this route says nothing to anyone, whatever wallet is named.
      await seedOwn(w, { agent: { draftId: DRAFT } });
      for (const query of ['', `?creator=${CREATOR}`, `?creator=${STRANGER}`]) expect((await list(query)).body).toEqual({ connected: false, clients: [] });
    } finally {
      await w.close();
    }
  });

  it('a client connected for a launch can give its credential up before the launch, and that is all it can do', async () => {
    const w = await ownWorld();
    try {
      const mine = await connectDraft(w, CREATOR);
      for (const op of ['status', 'due', 'turn', 'act', 'finish', 'upload', 'verify']) {
        expect([op, (await w.run<OwnErrorBody>(op, mine.credential, { role: 'social' })).body.error]).toEqual([op, 'coin_not_launched']);
      }
      expect((await w.run('disconnect', mine.credential)).body).toEqual({ ok: true });
      expect((await w.run<OwnErrorBody>('disconnect', mine.credential)).body.error).toBe('credential_revoked');
      expect((await w.call<DraftClientsResponse>('GET', `/internal/own/drafts/${DRAFT}/clients`)).body).toEqual({ connected: false, clients: [] });
      // The launch that follows does not bring it back.
      const agent = await seedOwn(w, { agent: { draftId: DRAFT } });
      expect(await adoptDraftClients(w.ctx, agent)).toBe(0);
      expect((await w.run<OwnErrorBody>('status', mine.credential)).body.error).toBe('credential_revoked');
    } finally {
      await w.close();
    }
  });

  it('a draft\'s clients whose launch never came are swept a day later, when a new request starts', async () => {
    const w = await ownWorld();
    try {
      const t0 = w.ctx.now();
      const OTHER_DRAFT = '99999999-2222-4333-8444-555555555555';
      const orphan = await connectDraft(w, CREATOR);
      // A second draft whose launch exists by then: its client is the launch's to bind, not the sweep's to delete.
      const second = await start(w);
      expect((await approveDraft(w, second.userCode, OTHER_CREATOR, OTHER_DRAFT)).status).toBe(200);
      const launched = await token(w, second.deviceCode);
      if (launched.body.status !== 'approved') throw new Error('expected an approved grant');
      // A day on nothing has changed until somebody starts a request.
      w.setNow(t0 + DAY - 1000);
      await start(w);
      expect(await w.db.select().from(agentClients)).toHaveLength(2);
      await w.db.insert(agents).values({ ...(await seedOther(w)), agentId: '99', kernel: '0x2000000000000000000000000000000000000099', token: '0x3000000000000000000000000000000000000099', draftId: OTHER_DRAFT });
      w.setNow(t0 + DAY + 1000);
      const fresh = await connectDraft(w, CREATOR, '77777777-2222-4333-8444-555555555555');
      const left = await w.db.select().from(agentClients);
      expect(left.map((c) => c.id).sort()).toEqual([launched.body.clientId, fresh.clientId].sort());
      // The swept credential is unknown from then on.
      expect((await w.run<OwnErrorBody>('disconnect', orphan.credential)).body.error).toBe('unauthorized');
      expect((await w.run<OwnErrorBody>('status', orphan.credential)).body.error).toBe('unauthorized');
    } finally {
      await w.close();
    }
  });

  it('a launch that carries somebody else\'s draft id gets none of that draft\'s clients', async () => {
    const w = await ownWorld();
    try {
      const victim = await connectDraft(w, CREATOR);
      // A stranger launches with the victim's draft id: the client the victim approved must not run the stranger's coin.
      const agent = await seedOwn(w, { agent: { draftId: DRAFT, creator: STRANGER } });
      expect(await adoptDraftClients(w.ctx, agent)).toBe(0);
      expect((await w.run<OwnErrorBody>('status', victim.credential)).body.error).toBe('credential_revoked');
      expect((await w.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`)).body.clients).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('a stranger who approves clients for somebody\'s draft cannot take the creator\'s places', async () => {
    const w = await ownWorld();
    try {
      // The draft id is public once the launch is on chain; a stranger approves as many clients for it as one wallet may.
      for (let n = 0; n < 3; n++) await connectDraft(w, STRANGER);
      const fourth = await start(w);
      expect((await approveDraft(w, fourth.userCode, STRANGER)).body.error).toBe('too_many_clients');
      // The creator's own approval is not blocked by them, and is the only one bound at registration.
      const mine = await connectDraft(w, CREATOR);
      const agent = await seedOwn(w, { agent: { draftId: DRAFT } });
      expect(await adoptDraftClients(w.ctx, agent)).toBe(1);
      expect((await w.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`)).body.clients.map((c) => c.clientId)).toEqual([mine.clientId]);
      expect(await ownHooks.countClients(w.ctx, AGENT_ID)).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('catches up with a launch that was registered before the hook ran, under the same creator check', async () => {
    const w = await ownWorld();
    try {
      const mine = await connectDraft(w, CREATOR);
      await seedOwn(w, { agent: { draftId: DRAFT } });
      // Nobody called the registration hook: the first call of the credential binds it.
      expect((await w.run<AgentStatus>('status', mine.credential)).body.coin.agentId).toBe(AGENT_ID);
      // A client redeemed after the launch is judged at once.
      const late = await connectDraft(w, STRANGER);
      expect((await w.run<OwnErrorBody>('status', late.credential)).body.error).toBe('credential_revoked');
      expect((await approveDraft(w, (await start(w)).userCode, CREATOR, 'not-a-draft')).body.error).toBe('invalid_request');
    } finally {
      await w.close();
    }
  });
});

describe('own agent: the flag off', () => {
  it('every connect and run route answers own_agent_disabled before anything is read; grant, coins and the two client routes still answer', async () => {
    const on = await ownWorld();
    try {
      await seedOwn(on);
      const client = await connectClient(on);
      const pendingGrant = await start(on);
      // The same deployment with the flag turned off (the coin is still own: the flag never changes how a coin is run).
      (on.ctx.config as { OWN_AGENT_ENABLED: boolean }).OWN_AGENT_ENABLED = false;
      const disabled = { error: 'own_agent_disabled', message: OWN_ERRORS.own_agent_disabled.message };
      for (const [method, path, body] of [
        ['POST', '/internal/own/connect/start', { siteUrl: 'https://bootr.fun' }],
        ['POST', '/internal/own/connect/approve', { userCode: pendingGrant.userCode, creator: CREATOR, target: { kind: 'coin', kernel: KERNEL, agentId: AGENT_ID } }],
        ['POST', '/internal/own/connect/token', { deviceCode: pendingGrant.deviceCode, credentialHash: credentialHash(newCredential()) }],
        ['GET', `/internal/own/drafts/${DRAFT}/clients`, undefined],
        ...['status', 'due', 'turn', 'act', 'finish', 'upload', 'disconnect', 'verify'].map((op) => ['POST', `/internal/own/run/${op}`, { credentialHash: credentialHash(client.credential), role: 'social' }] as const),
      ] as const) {
        const res = await on.call<OwnErrorBody>(method, path, body);
        expect([path, res.status]).toEqual([path, 404]);
        expect(res.body).toEqual(disabled);
      }
      // A wrong credential gets the same answer: the flag is asked first, nothing is looked up.
      expect((await on.run<OwnErrorBody>('status', 'bootr_agt_nothing')).body).toEqual(disabled);
      expect((await on.db.select().from(agentGrants)).find((g) => g.userCode === pendingGrant.userCode)?.status).toBe('pending');
      expect(await turnOf(on)).toBeNull();

      // Reading a grant and a wallet's coins works, and the creator can still see and disconnect clients.
      expect((await on.call<ConnectGrantView>('GET', `/internal/own/connect/grant?code=${pendingGrant.userCode}`)).body.status).toBe('pending');
      expect((await on.call<ConnectCoinsResponse>('GET', `/internal/own/connect/coins?creator=${CREATOR}`)).body.coins).toHaveLength(1);
      const list = await on.call<ClientsResponse>('GET', `/internal/agents/${AGENT_ID}/clients`);
      expect(list.body.clients.map((c) => c.clientId)).toEqual([client.clientId]);
      const revoked = await on.call<ClientsResponse>('POST', `/internal/agents/${AGENT_ID}/clients/revoke`, { by: CREATOR, clientId: client.clientId });
      expect(revoked.status).toBe(200);
      expect(revoked.body.clients).toEqual([]);
    } finally {
      await on.close();
    }
  });

  it('with the flag unset from the start nothing of the feature answers, and no table row is written', async () => {
    const w = await ownWorld({ flag: false });
    try {
      await seedOwn(w, { config: { runner: 'hosted' } });
      expect((await w.call<OwnErrorBody>('POST', '/internal/own/connect/start', { siteUrl: 'https://bootr.fun' })).body.error).toBe('own_agent_disabled');
      expect((await w.run<OwnErrorBody>('due', 'bootr_agt_' + 'A'.repeat(43))).body.error).toBe('own_agent_disabled');
      expect(await w.db.select().from(agentGrants)).toHaveLength(0);
      expect(await w.db.select().from(agentClients)).toHaveLength(0);
      // The internal routes are still behind the service key.
      const res = await (await import('../src/api.js')).createApp(w.ctx).request('/internal/own/connect/grant?code=BCDF-GHJK');
      expect(res.status).toBe(401);
    } finally {
      await w.close();
    }
  });
});
