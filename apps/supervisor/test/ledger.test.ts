/**
 * The public ledger (ledger.ts): every source and the field each row is read from, the cursor across sources with a
 * page boundary inside a busy minute (rows of several sources sharing one millisecond and one block second), `unknown`
 * rows that stay unknown until the chain closes their source row, the indexer being down, and the daily totals.
 * The indexer is a fake GraphQL store that applies the filters the module sends and orders ties its own way.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api.js';
import { bountyJobs, inference, serviceCalls, treasuryOps } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { decodeCursor, encodeCursor, ledgerDays, ledgerPage, ledgerRowsBetween, ledgerSummary, type LedgerRow } from '../src/ledger.js';
import { SERVICES_PAID_NO_ANSWER } from '../src/services.js';
import { encodeFundSpenderCall, encodeSwapCalls } from '../src/treasury.js';
import type { AgentRow } from '../src/context.js';
import { ADDR, AGENT_ID, CREATOR, KERNEL, makeWorld, RWAGMI_LP_LOCKER, seedAgent, SPENDER, SUPERVISOR_KEY, type TestWorld } from './helpers.js';

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const RELAY = '0x9999999999999999999999999999999999999999';
const BLOCKRUN = '0x8888888888888888888888888888888888888888';
const SERVICE_PAYTO = '0x7777777777777777777777777777777777777777';
const STRANGER = '0x6666666666666666666666666666666666666666';
const WINNER = '0x5555555555555555555555555555555555555555';
const lc = (a: string) => a.toLowerCase();

interface ClaimRow {
  id: string;
  recipient: string;
  timestamp: number;
  amount: string;
  amountUsd: number;
  txHash: string;
  asset: string;
}
interface FuelRow {
  id: string;
  kernel: string;
  from: string;
  timestamp: number;
  amount: string;
  amountUsd: number;
  txHash: string;
}

/** A fake of the indexer's GraphQL lists: the filters the ledger sends, ordered by timestamp desc and (unlike the module) id asc. */
function fakeIndexer(w: TestWorld, store: { feeClaims: ClaimRow[]; fuels: FuelRow[] }) {
  const state = { down: false, requests: 0 };
  const match = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k.endsWith('_not_in')) return !(v as string[]).includes(String(row[k.slice(0, -7)]));
      if (k.endsWith('_in')) return (v as string[]).includes(String(row[k.slice(0, -3)]));
      if (k.endsWith('_lt')) return Number(row[k.slice(0, -3)]) < Number(v);
      return row[k] === v;
    });
  w.ctx.indexer = {
    ...w.ctx.indexer,
    async graphql(query: string, variables: Record<string, unknown> = {}) {
      state.requests += 1;
      if (state.down) return null;
      const out: Record<string, unknown> = {};
      for (const m of query.matchAll(/(\w+): (feeClaims|fuels)\(where: \$(w\d+), orderBy: "timestamp", orderDirection: "desc", limit: (\d+)\)/g)) {
        const rows = (store[m[2] as 'feeClaims' | 'fuels'] as unknown as Record<string, unknown>[])
          .filter((r) => match(r, (variables[m[3]!] ?? {}) as Record<string, unknown>))
          .sort((a, b) => Number(b.timestamp) - Number(a.timestamp) || String(a.id).localeCompare(String(b.id)))
          .slice(0, Number(m[4]));
        out[m[1]!] = { items: rows };
      }
      return out;
    },
  } as typeof w.ctx.indexer;
  return state;
}

const T = Date.parse('2026-10-24T11:00:00.000Z');

async function op(w: TestWorld, row: Partial<typeof treasuryOps.$inferInsert> & { opId: string; kind: (typeof treasuryOps.$inferInsert)['kind'] }) {
  await w.db.insert(treasuryOps).values({ agentId: AGENT_ID, calls: [], callHash: '0x', description: '', origin: 'policy', status: 'confirmed', createdAt: new Date(T), updatedAt: new Date(T), ...row });
}

const callsOf = (calls: { to: string; value?: bigint; data?: string }[]) => calls.map((c) => ({ to: c.to, value: String(c.value ?? 0n), data: c.data ?? '0x' }));

async function thought(w: TestWorld, key: string, at: number, status: 'succeeded' | 'unknown' | 'pending' | 'failed', receipt: Record<string, unknown> | null, request: Record<string, unknown> = { model: 'm' }, error: string | null = null) {
  await w.db.insert(inference).values({ idempotencyKey: key, agentId: AGENT_ID, cycle: 1, requestHash: key, request, status, receipt, error, createdAt: new Date(at), updatedAt: new Date(at) });
}

async function service(w: TestWorld, id: string, at: number, over: Partial<typeof serviceCalls.$inferInsert>) {
  await w.db.insert(serviceCalls).values({ id, agentId: AGENT_ID, url: 'https://data.example/price', host: 'data.example', method: 'GET', reason: 'ETH price for a reply', status: 'succeeded', capMicroUsdc: '50000', payTo: SERVICE_PAYTO, createdAt: new Date(at), updatedAt: new Date(at), ...over });
}

async function job(w: TestWorld, id: string, over: Partial<typeof bountyJobs.$inferInsert>) {
  await w.db.insert(bountyJobs).values({ id, agentId: AGENT_ID, actionId: `act-${id}`, nonce: 1, task: 'a picture of a fee becoming a burn', criteria: ['shows the burn'], deliverable: 'image', amountMicroUsdc: '500000', status: 'open', createdAt: new Date(T), closesAt: new Date(T + 86_400_000), pageText: 'job', updatedAt: new Date(T), ...over });
}

/** One row of every source, and rows each source must leave out. */
async function seedAll(w: TestWorld) {
  await op(w, { opId: 'op_fuel', kind: 'fund_model', calls: callsOf([encodeFundSpenderCall(ADDR.usdc, SPENDER, 2_000_000n)]), description: `fund the spender ${SPENDER} with 2 USDC (float 0 -> target 5; 8 USDC left in this window)`, txHash: H(1), sentAt: new Date(T + 1000), confirmedAt: new Date(T + 1500) });
  await op(w, { opId: 'op_gas', kind: 'fund_gas', description: 'unwrap 0.001 WETH into gas (gas 0.0001 ETH -> target 0.002 ETH)', txHash: H(2), sentAt: new Date(T + 2000) });
  await op(w, { opId: 'op_swap', kind: 'swap', calls: callsOf(encodeSwapCalls({ weth: ADDR.weth, swapHelper: ADDR.bootr.swapHelper!, amountIn: 2_000_000_000_000_000n, maxSlippageBps: 100 })), description: 'swap 0.002 WETH -> ~>= 5.5 USDC via the swap helper (refuel to 5)', txHash: H(3), sentAt: new Date(T + 3000) });
  await op(w, { opId: 'op_claim_indexed', kind: 'claim_fees', calls: [{ to: RWAGMI_LP_LOCKER, value: '0', data: '0x' }], description: 'claim 0.0024 WETH of swap fees (~$5.00; 0.0024 pending + 0 settled) via settleAndClaim', txHash: H(4), sentAt: new Date(T + 4000) });
  await op(w, { opId: 'op_claim_late', kind: 'claim_fees', calls: [{ to: RWAGMI_LP_LOCKER, value: '0', data: '0x' }], description: 'claim 0.001 WETH of settled swap fees (~$2.10) via claimQuote', txHash: H(5), sentAt: new Date(T + 5000) });
  await op(w, { opId: 'op_claim_failed', kind: 'claim_fees', description: 'claim 0.001 WETH of settled swap fees (~$2.10) via claimQuote', status: 'failed', error: 'simulation_failed: x', updatedAt: new Date(T + 6000) });
  await op(w, { opId: 'op_claim_open', kind: 'claim_fees', description: 'claim 0.003 WETH of settled swap fees (~$6.30) via claimQuote', status: 'sent', userOpHash: H(66), sentAt: new Date(T + 7000), updatedAt: new Date(T + 7000) });
  await op(w, { opId: 'op_prepared', kind: 'swap', description: 'swap 1 WETH -> ~>= 1 USDC', status: 'prepared' });

  await thought(w, 'k1', T + 100, 'succeeded', { relay: { chargedMicroUsdc: '30000' }, payment: { accepted: { amount: '40000', payTo: RELAY } } });
  await thought(w, 'k2', T + 200, 'succeeded', { relay: { chargedMicroUsdc: '30000' }, payment: { accepted: { amount: '40000', payTo: RELAY } } });
  await thought(w, 'k-pic', T + 300, 'succeeded', { relay: { chargedMicroUsdc: '20000' }, payment: { accepted: { amount: '20000', payTo: RELAY } } }, { model: 'img', modalities: ['image'] });
  await thought(w, 'k-direct', T + 400, 'succeeded', { route: 'blockrun', relay: { chargedMicroUsdc: '10000' }, payment: { accepted: { amount: '10000', payTo: BLOCKRUN } } });
  await thought(w, 'k-open', T + 500, 'unknown', { payment: { accepted: { amount: '50000', payTo: RELAY } } });
  await thought(w, 'k-lost', T + 550, 'failed', { payment: { accepted: { amount: '40000', payTo: RELAY, scheme: 'exact' } } }, { model: 'm' }, 'credit_exhausted');
  await thought(w, 'k-fresh', w.ctx.now() - 60_000, 'pending', { payment: { accepted: { amount: '50000', payTo: RELAY } } });
  await thought(w, 'k-free', T + 600, 'failed', null, { model: 'm' }, 'relay_unavailable');

  await service(w, 'svc-ok', T + 8000, { chargedMicroUsdc: '5000', quoteMicroUsdc: '5000', txHash: H(10) });
  await service(w, 'svc-lost', T + 8100, { status: 'failed', error: SERVICES_PAID_NO_ANSWER, quoteMicroUsdc: '7000', chargedMicroUsdc: '7000', reason: 'a weather answer' });
  await service(w, 'svc-open', T + 8200, { status: 'unknown', quoteMicroUsdc: '9000', reason: 'a news answer' });
  await service(w, 'svc-refused', T + 8300, { status: 'failed', error: 'services_price_refused', quoteMicroUsdc: '80000' });
  await service(w, 'svc-free', T + 8400, { status: 'succeeded', quoteMicroUsdc: '0', chargedMicroUsdc: '0' });

  await job(w, H(100), { status: 'paid', openedAt: new Date(T + 10_000), postId: '1234', judgedAt: new Date(T + 11_000), verdict: { winner: 2 }, entriesConsidered: 3, payee: WINNER, txHash: H(20), paidAt: new Date(T + 12_000), closedAt: new Date(T + 12_000) });
  await job(w, H(101), { status: 'cancelled', openedAt: new Date(T + 13_000), postId: '1235', closedAt: new Date(T + 14_000) });
  await job(w, H(102), { status: 'draft' });

  const sec = (ms: number) => Math.floor(ms / 1000);
  return fakeIndexer(w, {
    feeClaims: [
      { id: 'c-1', recipient: lc(KERNEL), timestamp: sec(T + 4000) + 2, amount: '2400000000000000', amountUsd: 5.1, txHash: H(4), asset: lc(ADDR.weth) },
      { id: 'c-other', recipient: lc(STRANGER), timestamp: sec(T + 4000), amount: '1', amountUsd: 1, txHash: H(40), asset: lc(ADDR.weth) },
    ],
    fuels: [
      { id: 'f-creator', kernel: lc(KERNEL), from: lc(CREATOR), timestamp: sec(T + 9000), amount: '10000000', amountUsd: 10, txHash: H(30) },
      { id: 'f-stranger', kernel: lc(KERNEL), from: STRANGER, timestamp: sec(T + 9500), amount: '1000000', amountUsd: 1, txHash: H(31) },
      { id: 'f-swap', kernel: lc(KERNEL), from: '0x1111111111111111111111111111111111111111', timestamp: sec(T + 3000), amount: '5600000', amountUsd: 5.6, txHash: H(3) },
      { id: 'f-pool', kernel: lc(KERNEL), from: lc(ADDR.uniswap.poolManager), timestamp: sec(T + 3000), amount: '5600000', amountUsd: 5.6, txHash: H(77) },
      { id: 'f-elsewhere', kernel: STRANGER, from: lc(CREATOR), timestamp: sec(T + 9000), amount: '1', amountUsd: 0, txHash: H(78) },
    ],
  });
}

const brief = (r: LedgerRow) => ({ id: r.id, kind: r.kind, direction: r.direction, status: r.status, raw: r.amount?.raw ?? null, bound: r.amount?.bound ?? null });

async function seeded(): Promise<{ w: TestWorld; agent: AgentRow; ix: ReturnType<typeof fakeIndexer> }> {
  const w = await makeWorld();
  const agent = await seedAgent(w, { agent: { spender: SPENDER } });
  const ix = await seedAll(w);
  return { w, agent, ix };
}

describe('the ledger: every source', () => {
  it('reads each source into one list, newest first, with the field each row comes from, and leaves out what moved nothing', async () => {
    const { w, agent } = await seeded();
    try {
      const page = await ledgerPage(w.ctx, agent, { limit: 200 });
      expect(page.partial).toBe(false);
      expect(page.next).toBeNull();
      expect(page.rows.map(brief)).toEqual([
        { id: `bounty:${H(101)}:closed`, kind: 'bounty_closed', direction: 'none', status: 'confirmed', raw: null, bound: null },
        { id: `bounty:${H(101)}:posted`, kind: 'bounty_posted', direction: 'none', status: 'confirmed', raw: '500000', bound: null },
        { id: `bounty:${H(100)}:paid`, kind: 'bounty_paid', direction: 'out', status: 'confirmed', raw: '500000', bound: null },
        { id: `bounty:${H(100)}:judged`, kind: 'bounty_judged', direction: 'none', status: 'confirmed', raw: null, bound: null },
        { id: `bounty:${H(100)}:posted`, kind: 'bounty_posted', direction: 'none', status: 'confirmed', raw: '500000', bound: null },
        { id: 'fuel:f-stranger', kind: 'fuel_received', direction: 'in', status: 'confirmed', raw: '1000000', bound: null },
        { id: 'fuel:f-creator', kind: 'fuel_received', direction: 'in', status: 'confirmed', raw: '10000000', bound: null },
        { id: 'svc:svc-open', kind: 'service', direction: 'out', status: 'unknown', raw: '9000', bound: 'at_most' },
        { id: 'svc:svc-lost', kind: 'service', direction: 'out', status: 'confirmed', raw: '7000', bound: null },
        { id: 'svc:svc-ok', kind: 'service', direction: 'out', status: 'confirmed', raw: '5000', bound: null },
        { id: 'op:op_claim_open', kind: 'fee_claim', direction: 'in', status: 'unknown', raw: '3000000000000000', bound: 'about' },
        { id: 'op:op_claim_failed', kind: 'fee_claim', direction: 'in', status: 'failed', raw: null, bound: null },
        { id: 'claim:c-1', kind: 'fee_claim', direction: 'in', status: 'confirmed', raw: '2400000000000000', bound: null },
        { id: 'op:op_claim_late', kind: 'fee_claim', direction: 'in', status: 'confirmed', raw: '1000000000000000', bound: 'about' },
        { id: 'op:op_swap', kind: 'swap', direction: 'move', status: 'confirmed', raw: '2000000000000000', bound: null },
        { id: 'op:op_gas', kind: 'gas_topup', direction: 'move', status: 'confirmed', raw: '1000000000000000', bound: null },
        { id: 'op:op_fuel', kind: 'fuel_topup', direction: 'move', status: 'confirmed', raw: '2000000', bound: null },
        { id: 'think:2026-10-24:relay:paid', kind: 'thinking', direction: 'out', status: 'confirmed', raw: '120000', bound: null },
        { id: 'think:2026-10-24:relay:open', kind: 'thinking', direction: 'out', status: 'unknown', raw: '50000', bound: 'at_most' },
        { id: 'think:2026-10-24:blockrun:paid', kind: 'thinking', direction: 'out', status: 'confirmed', raw: '10000', bound: null },
      ]);
      const byId = new Map(page.rows.map((r) => [r.id, r]));
      // Counterparties as the page shows them: who, and the public address.
      expect(byId.get('fuel:f-creator')).toMatchObject({ counterparty: { role: 'creator', address: lc(CREATOR) }, reason: 'Its creator sent it fuel', txHash: H(30), amount: { asset: 'USDC', usd: 10 } });
      expect(byId.get('fuel:f-stranger')).toMatchObject({ counterparty: { role: 'person', address: STRANGER }, reason: 'Someone sent it fuel' });
      expect(byId.get('claim:c-1')).toMatchObject({ counterparty: { role: 'fee_locker', address: lc(RWAGMI_LP_LOCKER) }, amount: { asset: 'WETH', usd: 5.1 }, txHash: H(4) });
      expect(byId.get('op:op_fuel')).toMatchObject({ counterparty: { role: 'own_wallet', address: lc(SPENDER) }, txHash: H(1) });
      expect(byId.get('op:op_swap')).toMatchObject({ received: { asset: 'USDC', raw: '5500000', bound: 'at_least' }, counterparty: { role: 'swap', address: lc(ADDR.bootr.swapHelper!) } });
      expect(byId.get('svc:svc-ok')).toMatchObject({ reason: 'ETH price for a reply', counterparty: { role: 'service', host: 'data.example', address: SERVICE_PAYTO }, txHash: H(10) });
      expect(byId.get('svc:svc-lost')!.reason).toBe('a weather answer (paid, no answer came back)');
      expect(byId.get(`bounty:${H(100)}:paid`)).toMatchObject({ paidBy: 'creator', counterparty: { role: 'bounty_winner', address: WINNER }, txHash: H(20) });
      expect(byId.get(`bounty:${H(100)}:judged`)!.reason).toBe('Judged its bounty: entry 2 of 3 won');
      expect(byId.get(`bounty:${H(101)}:posted`)!.url).toBe('https://x.com/i/status/1235');
      // A day of thinking: thoughts and pictures counted, the paid failure in the sum, at the latest call of the group.
      expect(byId.get('think:2026-10-24:relay:paid')).toMatchObject({ reason: 'Paid for 3 thoughts and 1 picture on 2026-10-24 (UTC)', counterparty: { role: 'thinking_service', address: RELAY }, at: new Date(T + 550).toISOString() });
      expect(byId.get('think:2026-10-24:blockrun:paid')!.counterparty).toEqual({ role: 'blockrun', address: BLOCKRUN });
      // No row anywhere carries a word of the internals.
      expect(JSON.stringify(page.rows)).not.toMatch(/x402|session key|kernel|spender/i);
    } finally {
      await w.close();
    }
  });

  it('with the indexer down says so, and shows the agent’s own confirmed claims from its ops instead of losing them', async () => {
    const { w, agent, ix } = await seeded();
    try {
      ix.down = true;
      const page = await ledgerPage(w.ctx, agent, { limit: 200 });
      expect(page.partial).toBe(true);
      const ids = page.rows.map((r) => r.id);
      expect(ids.filter((id) => id.startsWith('claim:') || id.startsWith('fuel:'))).toEqual([]);
      expect(page.rows.find((r) => r.id === 'op:op_claim_indexed')).toMatchObject({ status: 'confirmed', amount: { raw: '2400000000000000', bound: 'about' } });
    } finally {
      await w.close();
    }
  });
});

describe('the ledger: paging across sources', () => {
  /** A busy minute: rows of five sources, many sharing one millisecond, and chain rows sharing one block second of their own. */
  async function busyMinute(): Promise<{ w: TestWorld; agent: AgentRow }> {
    const w = await makeWorld();
    const agent = await seedAgent(w, { agent: { spender: SPENDER } });
    const M = Date.parse('2026-10-24T11:30:00.000Z');
    const same = M + 30_000; // one millisecond shared by ops, services and bounty events
    for (let i = 0; i < 7; i++) await op(w, { opId: `op_${i}`, kind: 'fund_gas', description: 'unwrap 0.001 WETH into gas', txHash: H(200 + i), sentAt: new Date(i < 4 ? same : M + i * 1000) });
    for (let i = 0; i < 6; i++) await service(w, `svc-${i}`, i < 3 ? same : M + 40_000 + i, { chargedMicroUsdc: '1000', quoteMicroUsdc: '1000' });
    for (let i = 0; i < 3; i++) await job(w, H(300 + i), { status: 'cancelled', openedAt: new Date(same), closedAt: new Date(M + 50_000 + i) });
    await thought(w, 'busy-1', same, 'succeeded', { relay: { chargedMicroUsdc: '1000' }, payment: { accepted: { amount: '1000', payTo: RELAY } } });
    await thought(w, 'busy-older-day', M - 86_400_000, 'succeeded', { relay: { chargedMicroUsdc: '1000' }, payment: { accepted: { amount: '1000', payTo: RELAY } } });
    const s = Math.floor(same / 1000);
    fakeIndexer(w, {
      feeClaims: Array.from({ length: 5 }, (_, i) => ({ id: `c-${i}`, recipient: lc(KERNEL), timestamp: s - 10, amount: '1000', amountUsd: 0.01, txHash: H(400 + i), asset: lc(ADDR.weth) })),
      fuels: Array.from({ length: 5 }, (_, i) => ({ id: `f-${i}`, kernel: lc(KERNEL), from: STRANGER, timestamp: i < 4 ? s - 10 : s - 20, amount: '1000', amountUsd: 0.001, txHash: H(500 + i) })),
    });
    return { w, agent };
  }

  it('gives every row exactly once, in the one order, whatever the page size, with boundaries inside the shared millisecond and second', async () => {
    const { w, agent } = await busyMinute();
    try {
      const whole = await ledgerPage(w.ctx, agent, { limit: 200 });
      expect(whole.rows).toHaveLength(7 + 6 + 6 + 2 + 5 + 5);
      const ids = whole.rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const size of [1, 2, 3, 4, 5, 7, 11]) {
        const seen: string[] = [];
        let cursor = null;
        let pages = 0;
        do {
          const page: Awaited<ReturnType<typeof ledgerPage>> = await ledgerPage(w.ctx, agent, { limit: size, cursor });
          expect(page.rows.length).toBeLessThanOrEqual(size);
          seen.push(...page.rows.map((r) => r.id));
          cursor = page.next ? decodeCursor(page.next) : null;
          pages += 1;
        } while (cursor && pages < 100);
        expect([size, seen]).toEqual([size, ids]);
      }
    } finally {
      await w.close();
    }
  });

  it('reads a range for the report card with the same rows', async () => {
    const { w, agent } = await busyMinute();
    try {
      const whole = await ledgerPage(w.ctx, agent, { limit: 200 });
      const range = await ledgerRowsBetween(w.ctx, agent, new Date('2026-10-24T00:00:00.000Z'), new Date(w.ctx.now()));
      expect(range.complete).toBe(true);
      expect(range.rows.map((r) => r.id)).toEqual(whole.rows.filter((r) => r.at >= '2026-10-24').map((r) => r.id));
    } finally {
      await w.close();
    }
  });

  it('refuses a cursor it did not write, and round-trips its own', () => {
    expect(decodeCursor(encodeCursor({ at: 1_761_300_000_123, id: 'svc:a-b_c' }))).toEqual({ at: 1_761_300_000_123, id: 'svc:a-b_c' });
    for (const bad of ['', 'not base64!', Buffer.from('[1,"x"]').toString('base64url'), Buffer.from('[-1,"op:x"]').toString('base64url'), Buffer.from('{"at":1}').toString('base64url'), Buffer.from(`[1,"op:${'x'.repeat(300)}"]`).toString('base64url')]) {
      expect([bad, decodeCursor(bad)]).toEqual([bad, null]);
    }
  });
});

describe('the ledger: unknown rows', () => {
  it('stay unknown until their source row is closed by the chain, then read as confirmed and are counted once', async () => {
    const { w, agent } = await seeded();
    try {
      const before = await ledgerPage(w.ctx, agent, { limit: 200 });
      expect(before.rows.filter((r) => r.status === 'unknown').map((r) => r.id)).toEqual(['svc:svc-open', 'op:op_claim_open', 'think:2026-10-24:relay:open']);
      // The chain closes each: the claim is mined (and indexed), the payment settled, the thought's receipt came.
      await w.db.update(treasuryOps).set({ status: 'confirmed', txHash: H(9), confirmedAt: new Date(T + 7100) }).where(eq(treasuryOps.opId, 'op_claim_open'));
      await w.db.update(serviceCalls).set({ status: 'succeeded', chargedMicroUsdc: '9000', txHash: H(11) }).where(eq(serviceCalls.id, 'svc-open'));
      await w.db.update(inference).set({ status: 'succeeded', receipt: { relay: { chargedMicroUsdc: '45000' }, payment: { accepted: { amount: '50000', payTo: RELAY } } } }).where(eq(inference.idempotencyKey, 'k-open'));
      const ix = fakeIndexer(w, { feeClaims: [{ id: 'c-1', recipient: lc(KERNEL), timestamp: Math.floor((T + 4000) / 1000) + 2, amount: '2400000000000000', amountUsd: 5.1, txHash: H(4), asset: lc(ADDR.weth) }, { id: 'c-9', recipient: lc(KERNEL), timestamp: Math.floor((T + 7100) / 1000), amount: '3100000000000000', amountUsd: 6.4, txHash: H(9), asset: lc(ADDR.weth) }], fuels: [] });
      const after = await ledgerPage(w.ctx, agent, { limit: 200 });
      expect(ix.requests).toBeGreaterThan(0);
      expect(after.rows.filter((r) => r.status === 'unknown')).toEqual([]);
      const ids = after.rows.map((r) => r.id);
      expect(ids).not.toContain('op:op_claim_open');
      expect(after.rows.find((r) => r.id === 'claim:c-9')).toMatchObject({ status: 'confirmed', amount: { raw: '3100000000000000', usd: 6.4 } });
      expect(after.rows.find((r) => r.id === 'svc:svc-open')).toMatchObject({ status: 'confirmed', txHash: H(11), amount: { raw: '9000' } });
      expect(after.rows.find((r) => r.id === 'think:2026-10-24:relay:paid')!.amount!.raw).toBe(String(120_000 + 45_000));
    } finally {
      await w.close();
    }
  });
});

describe('the ledger: daily totals and the route', () => {
  it('sums confirmed rows per day, keeps moves and promises out of in and out, and a bounty its creator paid out of the agent’s spending', () => {
    const at = '2026-10-24T10:00:00.000Z';
    const usdc = (raw: string) => ({ asset: 'USDC' as const, decimals: 6, raw, usd: Number(raw) / 1e6 });
    const rows: LedgerRow[] = [
      { id: 'fuel:a', at, kind: 'fuel_received', direction: 'in', status: 'confirmed', amount: usdc('10000000'), reason: '' },
      { id: 'claim:a', at, kind: 'fee_claim', direction: 'in', status: 'confirmed', amount: { asset: 'WETH', decimals: 18, raw: '1000000000000000', usd: 2.5 }, reason: '' },
      { id: 'think:a', at, kind: 'thinking', direction: 'out', status: 'confirmed', amount: usdc('120000'), reason: '' },
      { id: 'svc:a', at, kind: 'service', direction: 'out', status: 'confirmed', amount: usdc('5000'), reason: '' },
      { id: 'svc:b', at, kind: 'service', direction: 'out', status: 'unknown', amount: usdc('9000'), reason: '' },
      { id: 'op:a', at, kind: 'fuel_topup', direction: 'move', status: 'confirmed', amount: usdc('2000000'), reason: '' },
      { id: 'op:b', at, kind: 'fee_claim', direction: 'in', status: 'failed', reason: '' },
      { id: 'bounty:a', at, kind: 'bounty_posted', direction: 'none', status: 'confirmed', amount: usdc('500000'), reason: '' },
      { id: 'bounty:b', at, kind: 'bounty_paid', direction: 'out', status: 'confirmed', amount: usdc('500000'), reason: '', paidBy: 'creator' },
      { id: 'fuel:old', at: '2026-10-10T10:00:00.000Z', kind: 'fuel_received', direction: 'in', status: 'confirmed', amount: usdc('1'), reason: '' },
    ];
    const [today, yesterday] = ledgerDays(rows, ['2026-10-24', '2026-10-23']);
    expect(today).toMatchObject({ day: '2026-10-24', inUsd: 12.5, outUsd: 0.13, unknown: 1, failed: 1 });
    expect(today!.lines.find((l) => l.kind === 'bounty_paid')).toMatchObject({ paidBy: 'creator', raw: '500000' });
    expect(today!.lines.find((l) => l.kind === 'fuel_topup')).toMatchObject({ direction: 'move', raw: '2000000' });
    expect(yesterday).toEqual({ day: '2026-10-23', lines: [], inUsd: 0, outUsd: 0, unknown: 0, failed: 0 });
    // A line with no dollar value makes that side's dollar sum unknown rather than wrong.
    const noValue = ledgerDays([{ id: 'op:c', at, kind: 'fee_claim', direction: 'in', status: 'confirmed', amount: { asset: 'WETH', decimals: 18, raw: '1', bound: 'about' }, reason: '' }], ['2026-10-24']);
    expect(noValue[0]!.inUsd).toBeNull();
  });

  it('serves the first page with seven days of totals, later pages by cursor, and refuses a bad cursor', async () => {
    const { w, agent } = await seeded();
    try {
      const summary = await ledgerSummary(w.ctx, agent);
      expect(summary.days.map((d) => d.day)).toEqual(['2026-10-24', '2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18']);
      const nowSec = () => Math.floor(w.ctx.now() / 1000);
      const app = createApp(w.ctx, nowSec);
      const get = (path: string) => app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } });
      const first = await get(`/internal/agents/${AGENT_ID}/ledger?limit=5`);
      expect(first.status).toBe(200);
      const body = (await first.json()) as { rows: LedgerRow[]; next: string; partial: boolean; days: unknown[]; daysComplete: boolean };
      expect(body.rows).toHaveLength(5);
      expect(body.days).toHaveLength(7);
      expect(body.daysComplete).toBe(true);
      const second = await get(`/internal/agents/${AGENT_ID}/ledger?limit=5&cursor=${body.next}`);
      const next = (await second.json()) as { rows: LedgerRow[]; days?: unknown };
      expect(next.days).toBeUndefined();
      expect(next.rows[0]!.id).not.toBe(body.rows[4]!.id);
      expect((await get(`/internal/agents/${AGENT_ID}/ledger?cursor=nope!`)).status).toBe(400);
      expect((await get(`/internal/agents/404/ledger`)).status).toBe(404);
    } finally {
      await w.close();
    }
  });
});
