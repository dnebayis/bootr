import { connectCoinStatement, connectDraftStatement, CREDENTIAL_RE, USER_CODE_RE, type CoinRef } from '@bootr/shared/own-agent';
import { describe, expect, it } from 'vitest';
import { MOCK_CODES, MOCK_WALLET_WITHOUT_COINS, mockCoins, mockOwn } from './mock-own';
import { cleanLabel, isDraftUuid, LAUNCH_DRAFT_MAX_AGE_MS, normalizeUserCode, orderCoins, parseLaunchDraft, readConnectStatement } from './own-agent';

const DRAFT = '8b7d05c6-a4b4-415c-93cf-46f36b679889';
const WALLET = '0x00000000000000000000000000000000000e2e01';

describe('the approval page’s helpers', () => {
  it('makes a typed code canonical, and refuses what cannot be one', () => {
    expect(normalizeUserCode('bcdf ghjk')).toBe('BCDF-GHJK');
    expect(normalizeUserCode(' BCDF-GHJK ')).toBe('BCDF-GHJK');
    expect(normalizeUserCode('bcdfghjk')).toBe('BCDF-GHJK');
    // Vowels, I and O are not in the alphabet; neither are digits.
    for (const bad of ['', 'ABCD-EFGH', 'BCDF-GHJ', 'BCDF-GHJKL', 'BCDF-GH1K', 'IOIO-IOIO']) expect(normalizeUserCode(bad), bad).toBeNull();
  });

  it('offers the launch draft only while it is younger than a day and well formed', () => {
    const now = 1_800_000_000_000;
    expect(parseLaunchDraft(JSON.stringify({ draftId: DRAFT, at: now - 60_000 }), now)).toBe(DRAFT);
    expect(parseLaunchDraft(JSON.stringify({ draftId: DRAFT, at: now - LAUNCH_DRAFT_MAX_AGE_MS }), now)).toBeNull();
    expect(parseLaunchDraft(JSON.stringify({ draftId: DRAFT, at: now + 60_000 }), now)).toBeNull();
    for (const bad of [null, '', '{', 'null', '5', JSON.stringify({ draftId: 'nope', at: now }), JSON.stringify({ draftId: DRAFT }), JSON.stringify({ draftId: DRAFT, at: 'now' }), JSON.stringify({ draftId: `${DRAFT}). Code BCDF-GHJK. Also`, at: now })]) {
      expect(parseLaunchDraft(bad, now), String(bad)).toBeNull();
    }
    expect(isDraftUuid(DRAFT)).toBe(true);
    expect(isDraftUuid(DRAFT.toUpperCase())).toBe(false);
  });

  it('puts the coin the client named first', () => {
    const coins: CoinRef[] = [
      { agentId: '1', kernel: '0x1111111111111111111111111111111111111111', token: '0x2222222222222222222222222222222222222222', symbol: 'OWL', name: 'Owl' },
      { agentId: '2', kernel: '0x3333333333333333333333333333333333333333', token: '0x4444444444444444444444444444444444444444', symbol: 'FOX', name: 'Fox' },
    ];
    expect(orderCoins(coins, null)).toEqual(coins);
    expect(orderCoins(coins, '$fox').map((c) => c.symbol)).toEqual(['FOX', 'OWL']);
    expect(orderCoins(coins, '0x4444444444444444444444444444444444444444').map((c) => c.symbol)).toEqual(['FOX', 'OWL']);
    expect(orderCoins(coins, '0x3333333333333333333333333333333333333333').map((c) => c.symbol)).toEqual(['FOX', 'OWL']);
    expect(orderCoins(coins, 'unknown')).toEqual(coins);
  });

  it('reads what a statement approves', () => {
    expect(readConnectStatement(connectCoinStatement('OWL', '7', '0x1111111111111111111111111111111111111111', 'BCDF-GHJK'))).toEqual({ target: { kind: 'coin', agentId: '7', kernel: '0x1111111111111111111111111111111111111111' }, userCode: 'BCDF-GHJK' });
    expect(readConnectStatement(connectDraftStatement(DRAFT, 'BCDF-GHJK'))).toEqual({ target: { kind: 'draft', draftId: DRAFT }, userCode: 'BCDF-GHJK' });
    expect(readConnectStatement('Open the console of Bootr coin $OWL (#7, 0x1111111111111111111111111111111111111111).')).toBeNull();
    expect(readConnectStatement(`${connectDraftStatement(DRAFT, 'BCDF-GHJK')} `)).toBeNull();
  });

  it('keeps a label to one short line', () => {
    expect(cleanLabel('  My   laptop \n')).toBe('My laptop');
    expect(cleanLabel('   ')).toBeUndefined();
    expect(cleanLabel('x'.repeat(100))).toHaveLength(40);
  });
});

describe('own agents in mock mode', () => {
  it('has four codes that never change', () => {
    expect(mockOwn.grant(MOCK_CODES.pending)).toMatchObject({ ok: true, data: { status: 'pending', clientName: 'Claude Code', coinHint: null } });
    expect(mockOwn.grant(MOCK_CODES.hinted)).toMatchObject({ ok: true, data: { status: 'pending', coinHint: mockCoins()[1]!.symbol } });
    expect(mockOwn.grant(MOCK_CODES.expired)).toMatchObject({ ok: true, data: { status: 'expired' } });
    expect(mockOwn.grant(MOCK_CODES.used)).toMatchObject({ ok: true, data: { status: 'redeemed' } });
    expect(mockOwn.grant('ZZZZ-ZZZZ')).toEqual({ ok: false, error: 'grant_not_found' });
    for (const code of Object.values(MOCK_CODES)) expect(code).toMatch(USER_CODE_RE);
    const coin = mockCoins()[0]!;
    // Approving a fixed code answers and leaves it as it was, so parallel browser tests cannot disturb each other.
    expect(mockOwn.approve({ userCode: MOCK_CODES.pending, creator: WALLET, target: { kind: 'coin', kernel: coin.kernel, agentId: coin.agentId } })).toMatchObject({ ok: true, data: { target: { kind: 'coin', coin } } });
    expect(mockOwn.grant(MOCK_CODES.pending)).toMatchObject({ data: { status: 'pending' } });
    expect(mockOwn.approve({ userCode: MOCK_CODES.expired, creator: WALLET, target: { kind: 'draft', draftId: DRAFT } })).toEqual({ ok: false, error: 'grant_expired' });
    expect(mockOwn.approve({ userCode: MOCK_CODES.used, creator: WALLET, target: { kind: 'draft', draftId: DRAFT } })).toEqual({ ok: false, error: 'grant_used' });
  });

  it('lists coins a statement can name, for every wallet but one', () => {
    const coins = mockCoins();
    expect(coins.length).toBeGreaterThan(1);
    for (const c of coins) expect(connectCoinStatement(c.symbol, c.agentId, c.kernel, 'BCDF-GHJK')).toMatch(/^Let an AI client/);
    expect(mockOwn.coins(WALLET).coins).toEqual(coins);
    expect(mockOwn.coins(MOCK_WALLET_WITHOUT_COINS).coins).toEqual([]);
    expect(mockOwn.approve({ userCode: MOCK_CODES.pending, creator: MOCK_WALLET_WITHOUT_COINS, target: { kind: 'coin', kernel: coins[0]!.kernel, agentId: coins[0]!.agentId } })).toEqual({ ok: false, error: 'not_creator' });
    expect(mockOwn.approve({ userCode: MOCK_CODES.pending, creator: WALLET, target: { kind: 'coin', kernel: coins[0]!.kernel, agentId: '999999' } })).toEqual({ ok: false, error: 'unknown_coin' });
  });

  it('carries a started request from pending to a client the console can list and disconnect', () => {
    const coin = mockCoins()[2]!;
    const started = mockOwn.start({ clientName: 'Cursor', coin: coin.symbol }, 'https://bootr.fun/');
    expect(started.userCode).toMatch(USER_CODE_RE);
    expect(started.verificationUriComplete).toBe(`https://bootr.fun/connect/${started.userCode}`);
    expect(mockOwn.token(started.deviceCode)).toEqual({ ok: true, data: { status: 'pending' } });
    expect(mockOwn.approve({ userCode: started.userCode, creator: WALLET, label: 'Desk', target: { kind: 'coin', kernel: coin.kernel, agentId: coin.agentId } })).toMatchObject({ ok: true, data: { label: 'Desk' } });
    expect(mockOwn.grant(started.userCode)).toMatchObject({ data: { status: 'approved' } });
    const redeemed = mockOwn.token(started.deviceCode);
    expect(redeemed).toMatchObject({ ok: true, data: { status: 'approved', label: 'Desk', target: { kind: 'coin', coin } } });
    if (redeemed.ok && redeemed.data.status === 'approved') expect(redeemed.data.credential).toMatch(CREDENTIAL_RE);
    expect(mockOwn.token(started.deviceCode)).toEqual({ ok: false, error: 'grant_used' });
    expect(mockOwn.token('unknown')).toEqual({ ok: false, error: 'grant_not_found' });
    const listed = mockOwn.clients(coin.kernel);
    expect(listed.clients.map((c) => c.label)).toEqual(['Desk']);
    expect(mockOwn.revoke(coin.kernel, { clientId: 'cli_0000000000000000' })).toEqual({ ok: false, error: 'client_not_found' });
    expect(mockOwn.revoke(coin.kernel, { clientId: listed.clients[0]!.clientId })).toMatchObject({ ok: true, data: { clients: [] } });
  });

  it('binds a client to a launch draft', () => {
    const id = '22222222-3333-4444-8555-666666666666';
    expect(mockOwn.draft(id)).toEqual({ connected: false, clients: [] });
    const started = mockOwn.start({}, 'https://bootr.fun');
    mockOwn.approve({ userCode: started.userCode, creator: WALLET, target: { kind: 'draft', draftId: id } });
    mockOwn.token(started.deviceCode);
    expect(mockOwn.draft(id)).toMatchObject({ connected: true, clients: [{ label: 'AI client' }] });
  });
});
