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
import { adoptDraftClients, cleanText, hashSecret, newUserCode } from '../src/own/clients.js';
import { ownHooks } from '../src/own/registry.js';
import { AGENT_ID, CREATOR, KERNEL, TOKEN } from './helpers.js';
import { OTHER_AGENT_ID, OTHER_CREATOR, OTHER_KERNEL, connectClient, openSocial, ownWorld, seedOther, seedOwn, turnOf, type OwnWorld } from './own-helpers.js';

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

const token = (world: OwnWorld, deviceCode: string) => world.call<ConnectTokenResponse & OwnErrorBody>('POST', '/internal/own/connect/token', { deviceCode });

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
      for (const bad of [undefined, '', 'bootr_agt_short', credential.toUpperCase(), ` ${credential}`, `${credential}x`, flipped, { $ne: null }, ['bootr_agt_'], 12345]) {
        for (const op of ['status', 'due', 'turn', 'act', 'finish', 'upload', 'disconnect']) {
          const res = await w.call<OwnErrorBody>('POST', `/internal/own/run/${op}`, { credential: bad, role: 'social' });
          expect([op, res.status]).toEqual([op, 401]);
          expect(res.body).toEqual({ error: 'unauthorized', message: OWN_ERRORS.unauthorized.message });
        }
      }
      expect((await w.call<OwnErrorBody>('POST', '/internal/own/run/steal', { credential })).body.error).toBe('invalid_request');
      expect(await turnOf(w)).toBeNull();
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
      for (const op of ['status', 'due', 'turn', 'act', 'finish', 'upload', 'disconnect']) {
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
      for (const op of ['due', 'turn', 'act', 'finish', 'upload']) {
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

  async function connectDraft(w: OwnWorld, creator: string) {
    const grant = await start(w);
    expect((await approveDraft(w, grant.userCode, creator)).body.target).toEqual({ kind: 'draft', draftId: DRAFT });
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
        ['POST', '/internal/own/connect/token', { deviceCode: pendingGrant.deviceCode }],
        ['GET', `/internal/own/drafts/${DRAFT}/clients`, undefined],
        ...['status', 'due', 'turn', 'act', 'finish', 'upload', 'disconnect'].map((op) => ['POST', `/internal/own/run/${op}`, { credential: client.credential, role: 'social' }] as const),
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
