/**
 * Own agents, after the security review of the engine (docs/design/byo-agent.md "Limits added after review"): the
 * paid-service tools. `x402_fetch` asks a service for its price with an unpaid request, so for a coin that buys no
 * thought it was an HTTP client that cost nothing; `discover_services` kept every search it was ever asked for.
 */
import { DEFAULT_SERVICES_POLICY, parseAgentConfig } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { servicesDailyCount } from '../src/broker/index.js';
import { serviceCalls } from '../src/db/schema.js';
import { DISCOVERY_CACHE_MAX, DISCOVERY_CACHE_MS, SERVICES_FUEL_UNREADABLE, SERVICES_INSUFFICIENT_FUEL, discoverServices, discoveryCacheSize } from '../src/services.js';
import { AGENT_ID, agentConfig, seedAgent, type TestWorld } from './helpers.js';
import { act, connectClient, openSocial, ownWorld, seedOwn } from './own-helpers.js';

const CAPS = { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false, services: true };

/** Every request that leaves for a host other than the catalogue is recorded; the catalogue answers an empty list. */
function watchOutbound(w: TestWorld): { service: string[]; catalogue: string[] } {
  const seen = { service: [] as string[], catalogue: [] as string[] };
  const inner = w.ctx.fetch;
  w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname === 'api.cdp.coinbase.com') {
      seen.catalogue.push(url.searchParams.get('query') ?? '');
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.hostname.endsWith('.example')) {
      seen.service.push(url.toString());
      return new Response(JSON.stringify({ hello: 'free' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return inner(input, init);
  }) as typeof fetch;
  return seen;
}

describe('own agent: x402_fetch is not a free HTTP client', () => {
  it('a coin whose spender cannot cover the per-call cap sends nothing at all: no request, no lookup, no row', async () => {
    // 0.01 USDC of fuel against the default per-call cap of 0.05: not empty, and still not enough.
    const w = await ownWorld({ chain: { spenderUsdc: 10_000n } });
    try {
      await seedOwn(w, { config: { capabilities: CAPS, services: { ...DEFAULT_SERVICES_POLICY } } });
      const { credential } = await connectClient(w);
      const seen = watchOutbound(w);
      let lookups = 0;
      w.ctx.resolveHost = async () => ((lookups += 1), [{ address: '93.184.216.34' }]);
      const turn = await openSocial(w, credential);
      // The client names a price it could pay; the creator's cap decides, not the caller's number.
      const refused = await act(w, credential, turn.turnId, 'x402_fetch', { url: 'https://free.example/anything?x=1', reason: 'a page', maxPriceMicroUsdc: 1 });
      expect(refused.body).toMatchObject({ tool: 'x402_fetch', status: 'failed', error: SERVICES_INSUFFICIENT_FUEL });
      expect(seen.service).toEqual([]);
      expect(lookups).toBe(0);
      expect(await w.db.select().from(serviceCalls).where(eq(serviceCalls.agentId, AGENT_ID))).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('with the fuel unreadable nothing is sent on a guess; with enough fuel the call goes out as before', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w, { config: { capabilities: CAPS, services: { ...DEFAULT_SERVICES_POLICY } } });
      const { credential } = await connectClient(w);
      const seen = watchOutbound(w);
      const turn = await openSocial(w, credential);
      const read = w.ctx.chain.publicClient.readContract;
      let broken = true;
      w.ctx.chain.publicClient.readContract = (async (args: { functionName?: string }) => {
        if (broken && args.functionName === 'balanceOf') throw new Error('rpc down');
        return (read as (a: unknown) => Promise<unknown>)(args);
      }) as typeof read;
      const blind = await act(w, credential, turn.turnId, 'x402_fetch', { url: 'https://free.example/a', reason: 'a page' });
      expect(blind.body).toMatchObject({ status: 'failed', error: SERVICES_FUEL_UNREADABLE });
      expect(seen.service).toEqual([]);
      broken = false;
      const sent = await act(w, credential, turn.turnId, 'x402_fetch', { url: 'https://free.example/b', reason: 'a page' });
      expect(sent.body.error ?? '').not.toMatch(/services_insufficient_fuel|services_fuel_unreadable/);
      expect(seen.service).toEqual(['https://free.example/b']);
    } finally {
      await w.close();
    }
  });

  it('paid calls and catalogue searches share one count per day, and a call past it leaves nothing', async () => {
    const w = await ownWorld({ config: { OWN_SERVICE_CALLS_PER_DAY: '3' } });
    try {
      await seedOwn(w, { config: { capabilities: CAPS, services: { ...DEFAULT_SERVICES_POLICY } } });
      const { credential } = await connectClient(w);
      const seen = watchOutbound(w);
      const turn = await openSocial(w, credential);
      expect((await act(w, credential, turn.turnId, 'discover_services', { query: 'prices' })).body.status).toBe('completed');
      expect((await act(w, credential, turn.turnId, 'x402_fetch', { url: 'https://free.example/a', reason: 'a page' })).body.error ?? '').not.toMatch(/services_daily_count/);
      expect((await act(w, credential, turn.turnId, 'discover_services', { query: 'weather' })).body.status).toBe('completed');
      const fetchPast = await act(w, credential, turn.turnId, 'x402_fetch', { url: 'https://free.example/b', reason: 'a page' });
      expect(fetchPast.body).toMatchObject({ status: 'failed', error: servicesDailyCount(3) });
      const searchPast = await act(w, credential, turn.turnId, 'discover_services', { query: 'news' });
      expect(searchPast.body).toMatchObject({ status: 'failed', error: servicesDailyCount(3) });
      expect(seen.service).toEqual(['https://free.example/a']);
      expect(seen.catalogue).toEqual(['prices', 'weather']);
    } finally {
      await w.close();
    }
  });
});

describe('discover_services: the catalogue cache is bounded', () => {
  it('keeps at most a few hundred searches, the oldest out first, and drops what ran out when it writes', async () => {
    const w = await ownWorld();
    try {
      const agent = await seedAgent(w);
      const config = parseAgentConfig(agentConfig(w.ctx.now(), { capabilities: CAPS, services: { ...DEFAULT_SERVICES_POLICY } }));
      const seen = watchOutbound(w);
      const t0 = w.ctx.now();
      for (let i = 0; i < DISCOVERY_CACHE_MAX + 50; i++) await discoverServices(w.ctx, agent, config, { query: `query number ${i}` });
      expect(seen.catalogue).toHaveLength(DISCOVERY_CACHE_MAX + 50);
      expect(discoveryCacheSize(w.ctx)).toBe(DISCOVERY_CACHE_MAX);
      // The newest is still served from the cache, the oldest was dropped and is read again.
      await discoverServices(w.ctx, agent, config, { query: `query number ${DISCOVERY_CACHE_MAX + 49}` });
      expect(seen.catalogue).toHaveLength(DISCOVERY_CACHE_MAX + 50);
      await discoverServices(w.ctx, agent, config, { query: 'query number 0' });
      expect(seen.catalogue).toHaveLength(DISCOVERY_CACHE_MAX + 51);
      expect(discoveryCacheSize(w.ctx)).toBe(DISCOVERY_CACHE_MAX);
      // Ten minutes on, one write clears everything that ran out.
      w.setNow(t0 + DISCOVERY_CACHE_MS);
      await discoverServices(w.ctx, agent, config, { query: 'a fresh search' });
      expect(discoveryCacheSize(w.ctx)).toBe(1);
    } finally {
      await w.close();
    }
  });
});
