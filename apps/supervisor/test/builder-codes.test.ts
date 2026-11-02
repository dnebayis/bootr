import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { concatHex, decodeAbiParameters, encodeFunctionData, erc20Abi, parseAbiParameters, slice, type Hex } from 'viem';
import * as Attribution from 'ox/erc8021/Attribution';
import { KERNEL_EXECUTE_SELECTOR, KERNEL_EXECUTE_USER_OP_SELECTOR } from '../src/abi.js';
import { attributionSuffix, backfillBuilderCodes, ensureBuilderCode, fetchBuilderCode, isValidBuilderCode } from '../src/builder-codes.js';
import { createApp } from '../src/api.js';
import { agents } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { createKernelClient, encodeKernelCalls } from '../src/kernel.js';
import { registerAgent, type LaunchEvent } from '../src/onboarding.js';
import { ADDR, AGENT_ID, CREATOR, GUARDIAN, KERNEL, makeWorld, PAYTO, SUPERVISOR_KEY, SESSION_PK, seedAgent, TOKEN, type TestWorld } from './helpers.js';
import { privateKeyToAccount } from 'viem/accounts';

const CODE = 'bc_a1b2c3d4';
/** 16-byte ERC-8021 marker every suffix ends with. */
const MARKER = '80218021802180218021802180218021';

function launch(agentId: bigint): LaunchEvent {
  return { token: TOKEN, kernel: KERNEL, creator: CREATOR, burner: '0x0000000000000000000000000000000000000000', agentId, dormancyPeriod: 90 * 86_400, model: 'openai/gpt-4.1-mini', agentURI: '', workerHash: `0x${'00'.repeat(32)}`, blockNumber: 42n, txHash: `0x${'07'.repeat(32)}` };
}

/** Records every builder-code request and answers with the scripted response (or throws). */
function builderCodesFetch(world: TestWorld, answer: (body: { walletAddress: string }) => Response | Promise<Response>) {
  const calls: { url: string; method: string; body: { walletAddress: string }; signal: AbortSignal | null | undefined }[] = [];
  const inner = world.ctx.fetch;
  world.ctx.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === world.ctx.config.BUILDER_CODES_URL) {
      const body = JSON.parse(String(init?.body)) as { walletAddress: string };
      calls.push({ url, method: init?.method ?? 'GET', body, signal: init?.signal });
      return answer(body);
    }
    return inner(input, init);
  }) as typeof fetch;
  return calls;
}

const ok = (code = CODE) => (body: { walletAddress: string }) => new Response(JSON.stringify({ builderCode: code, walletAddress: body.walletAddress }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('ERC-8021 suffix', () => {
  it('attributionSuffix equals ox toDataSuffix for one code and ends with the marker', () => {
    const suffix = attributionSuffix(CODE);
    expect(suffix).toBe(Attribution.toDataSuffix({ codes: [CODE] }));
    expect(suffix.endsWith(MARKER)).toBe(true);
    // codes ‖ codesLength(1) ‖ schemaId(1) ‖ marker(16); the fork test hard-codes this exact value for bc_a1b2c3d4
    expect(suffix).toBe('0x62635f61316232633364340b0080218021802180218021802180218021');
    expect(Attribution.fromData(concatHex(['0xdeadbeef', suffix]))).toEqual({ codes: [CODE], id: 0 });
    expect(isValidBuilderCode('bc_a1b2c3d4')).toBe(true);
    for (const bad of ['', 'a,b', 'has space', 'x'.repeat(65), 42, null]) expect(isValidBuilderCode(bad)).toBe(false);
    expect(() => attributionSuffix('a,b')).toThrow(/invalid builder code/);
  });

  it('encodeCalls output = encodeKernelCalls(calls) ‖ suffix, still starts with executeUserOp and decodes from the head', async () => {
    const world = await makeWorld();
    try {
      const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [PAYTO, 1n] });
      const calls = [{ to: ADDR.usdc, value: 0n, data: transfer }];
      const base = { publicClient: world.ctx.chain.publicClient, chain: world.ctx.chain.chain, kernel: KERNEL, guardian: GUARDIAN, permissionId: '0x11223344' as Hex, sessionSigner: privateKeyToAccount(SESSION_PK), bundlerUrl: 'http://bundler.test' };
      const withCode = await createKernelClient({ ...base, builderCode: CODE });
      const plain = encodeKernelCalls(calls);
      const encoded = await withCode.account.encodeCalls(calls);
      expect(withCode.callDataSuffix).toBe(attributionSuffix(CODE));
      expect(encoded).toBe(concatHex([plain, attributionSuffix(CODE)]));
      expect(encoded.startsWith('0x8dd7712f')).toBe(true);
      expect(encoded.startsWith(KERNEL_EXECUTE_USER_OP_SELECTOR)).toBe(true);
      expect(encoded.endsWith(MARKER)).toBe(true);
      expect(slice(encoded, 4, 8)).toBe(KERNEL_EXECUTE_SELECTOR);
      // the head still decodes as execute(mode, executionCalldata) despite the trailing bytes
      const [, execCalldata] = decodeAbiParameters(parseAbiParameters('bytes32, bytes'), slice(encoded, 8));
      expect(execCalldata.toLowerCase()).toBe(slice(plain, 8 + 64 + 32).toLowerCase().slice(0, execCalldata.length));
      // batch too
      const batch = await withCode.account.encodeCalls([...calls, { to: ADDR.weth, value: 0n, data: transfer }]);
      expect(batch).toBe(concatHex([encodeKernelCalls([...calls, { to: ADDR.weth, value: 0n, data: transfer }]), attributionSuffix(CODE)]));
      // without a code: unchanged
      const without = await createKernelClient(base);
      expect(without.callDataSuffix).toBeNull();
      expect(await without.account.encodeCalls(calls)).toBe(plain);
      // there is no ERC-1271 path: the kernel refuses to sign typed data at all
      await expect(withCode.signTypedData({ domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: ADDR.usdc }, types: { Probe: [{ name: 'to', type: 'address' }] }, primaryType: 'Probe', message: { to: PAYTO } })).rejects.toThrow(/kernel signing refused/);
    } finally {
      await world.close();
    }
  });
});

describe('builder code registration', () => {
  it('fetchBuilderCode posts {walletAddress}, uses a timeout signal and validates the answer', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return ok()({ walletAddress: KERNEL });
    }) as typeof fetch;
    expect(await fetchBuilderCode(KERNEL, { url: 'https://api.base.dev/v1/agents/builder-codes', fetch: fetchImpl })).toBe(CODE);
    expect(seen[0]!.url).toBe('https://api.base.dev/v1/agents/builder-codes');
    expect(seen[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({ walletAddress: KERNEL });
    expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);

    const bad = async (res: Response) => fetchBuilderCode(KERNEL, { url: 'http://x.test', fetch: (async () => res) as typeof fetch });
    await expect(bad(new Response('nope', { status: 500 }))).rejects.toThrow(/HTTP 500/);
    await expect(bad(new Response('<html>', { status: 200 }))).rejects.toThrow(/non-JSON/);
    await expect(bad(new Response('{}', { status: 200 }))).rejects.toThrow(/no usable builderCode/);
    await expect(bad(new Response(JSON.stringify({ builderCode: 'a,b' }), { status: 200 }))).rejects.toThrow(/no usable builderCode/);
    await expect(bad(new Response(JSON.stringify({ builderCode: CODE, walletAddress: CREATOR }), { status: 200 }))).rejects.toThrow(/another wallet/);
    // a slow endpoint is aborted by the timeout
    const slow = (async (_i: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error)))) as typeof fetch;
    await expect(fetchBuilderCode(KERNEL, { url: 'http://x.test', fetch: slow, timeoutMs: 20 })).rejects.toThrow(/timeout|aborted/i);
  });

  it('registerAgent registers the kernel and stores the code', async () => {
    const world = await makeWorld();
    try {
      const calls = builderCodesFetch(world, ok());
      const row = await registerAgent(world.ctx, launch(7n));
      expect(row?.builderCode).toBe(CODE);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toEqual({ walletAddress: KERNEL });
      expect(calls[0]!.method).toBe('POST');
      const stored = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(stored!.builderCode).toBe(CODE);
      expect(stored!.status).toBe('onboarding');
      // already registered: no second call
      expect(await ensureBuilderCode(world.ctx, stored!)).toBe(CODE);
      expect(calls).toHaveLength(1);
    } finally {
      await world.close();
    }
  });

  it('a failed registration never blocks onboarding and is retried by the backfill on a later tick', async () => {
    const world = await makeWorld();
    try {
      let fail = true;
      const calls = builderCodesFetch(world, (body) => (fail ? new Response('boom', { status: 503 }) : ok()(body)));
      const row = await registerAgent(world.ctx, launch(7n));
      expect(row).not.toBeNull();
      expect(row!.builderCode).toBeNull();
      let stored = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(stored!.builderCode).toBeNull();
      expect(stored!.status).toBe('onboarding');
      // a network error (fetch throws) is a warn too
      world.ctx.fetch = (async () => {
        throw new Error('ECONNRESET');
      }) as typeof fetch;
      expect(await ensureBuilderCode(world.ctx, stored!)).toBeNull();
      const later = builderCodesFetch(world, (body) => (fail ? new Response('boom', { status: 503 }) : ok()(body)));
      // still failing: backfill registers nothing
      expect(await backfillBuilderCodes(world.ctx)).toBe(0);
      expect(later).toHaveLength(1);
      fail = false;
      expect(await backfillBuilderCodes(world.ctx)).toBe(1);
      expect(later).toHaveLength(2);
      stored = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(stored!.builderCode).toBe(CODE);
      // nothing left to do, no further call
      expect(await backfillBuilderCodes(world.ctx)).toBe(0);
      expect(later).toHaveLength(2);
      expect(calls).toHaveLength(1);
      // exposed by the admin API
      const nowSec = () => Math.floor(world.ctx.now() / 1000);
      const app = createApp(world.ctx, nowSec);
      const list = (await (await app.request('/internal/agents', { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', '/internal/agents', '', nowSec()) } })).json()) as { agents: { agentId: string; builderCode: string | null }[] };
      expect(list.agents.find((a) => a.agentId === '7')?.builderCode).toBe(CODE);
      const one = (await (await app.request('/internal/agents/7', { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', '/internal/agents/7', '', nowSec()) } })).json()) as { agent: { builderCode: string | null } };
      expect(one.agent.builderCode).toBe(CODE);
    } finally {
      await world.close();
    }
  });

  it('BUILDER_CODES_ENABLED=false disables registration, the backfill and the suffix', async () => {
    const world = await makeWorld({ config: { BUILDER_CODES_ENABLED: 'false' } });
    try {
      expect(world.ctx.config.BUILDER_CODES_ENABLED).toBe(false);
      expect(world.ctx.config.BUILDER_CODES_URL).toBe('https://api.base.dev/v1/agents/builder-codes');
      const calls = builderCodesFetch(world, ok());
      const row = await registerAgent(world.ctx, launch(7n));
      expect(row!.builderCode).toBeNull();
      expect(await backfillBuilderCodes(world.ctx)).toBe(0);
      expect(calls).toHaveLength(0);
    } finally {
      await world.close();
    }
  });

  it('BUILDER_CODES_URL overrides the endpoint and the active-agent backfill uses it', async () => {
    const world = await makeWorld({ config: { BUILDER_CODES_URL: 'http://codes.test/register' } });
    try {
      expect(world.ctx.config.BUILDER_CODES_URL).toBe('http://codes.test/register');
      const calls = builderCodesFetch(world, ok('bc_other'));
      await seedAgent(world); // active agent without a code
      expect(await backfillBuilderCodes(world.ctx)).toBe(1);
      expect(calls[0]!.url).toBe('http://codes.test/register');
      const stored = await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) });
      expect(stored!.builderCode).toBe('bc_other');
    } finally {
      await world.close();
    }
  });
});
