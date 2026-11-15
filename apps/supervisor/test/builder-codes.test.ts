import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { concatHex, decodeAbiParameters, encodeFunctionData, erc20Abi, parseAbiParameters, slice, type Hex } from 'viem';
import * as Attribution from 'ox/erc8021/Attribution';
import { KERNEL_EXECUTE_SELECTOR, KERNEL_EXECUTE_USER_OP_SELECTOR } from '../src/abi.js';
import { attributionSuffix, fetchBuilderCode, isValidBuilderCode, platformBuilderCode } from '../src/builder-codes.js';
import { createApp } from '../src/api.js';
import { agents } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { createKernelClient, encodeKernelCalls } from '../src/kernel.js';
import { registerAgent, type LaunchEvent } from '../src/onboarding.js';
import { ADDR, CREATOR, GUARDIAN, KERNEL, LAUNCHER, makeWorld, PAYTO, SUPERVISOR_KEY, SESSION_PK, TOKEN, type TestWorld } from './helpers.js';
import { privateKeyToAccount } from 'viem/accounts';

const CODE = 'bc_a1b2c3d4';
/** 16-byte ERC-8021 marker every suffix ends with. */
const MARKER = '80218021802180218021802180218021';

function launch(agentId: bigint): LaunchEvent {
  return { token: TOKEN, kernel: KERNEL, creator: CREATOR, burner: '0x0000000000000000000000000000000000000000', agentId, dormancyPeriod: 90 * 86_400, model: 'openai/gpt-4.1-mini', agentURI: '', workerHash: `0x${'00'.repeat(32)}`, blockNumber: 42n, txHash: `0x${'07'.repeat(32)}`, launcher: LAUNCHER, source: 'bootr' };
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

  it('a new agent registers no code of its own: the platform is one builder (the owner\'s decision of 2026-11-15)', async () => {
    const world = await makeWorld({ config: { BUILDER_CODE: 'bc_platform1' } });
    try {
      const calls = builderCodesFetch(world, ok());
      const row = await registerAgent(world.ctx, launch(7n));
      expect(row).not.toBeNull();
      expect(row!.builderCode).toBeNull();
      expect(calls).toHaveLength(0);
      const stored = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(stored!.builderCode).toBeNull();
      expect(stored!.status).toBe('onboarding');
      // the admin API shows the one code every agent's operations carry
      const nowSec = () => Math.floor(world.ctx.now() / 1000);
      const app = createApp(world.ctx, nowSec);
      const list = (await (await app.request('/internal/agents', { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', '/internal/agents', '', nowSec()) } })).json()) as { agents: { agentId: string; builderCode: string | null }[] };
      expect(list.agents.find((a) => a.agentId === '7')?.builderCode).toBe('bc_platform1');
    } finally {
      await world.close();
    }
  });

  it('platformBuilderCode: the platform\'s code, or null when unset, invalid or switched off; an agent\'s old code is never used', () => {
    expect(platformBuilderCode({ BUILDER_CODE: 'bc_platform1', BUILDER_CODES_ENABLED: true })).toBe('bc_platform1');
    expect(platformBuilderCode({ BUILDER_CODE: undefined, BUILDER_CODES_ENABLED: true })).toBeNull();
    expect(platformBuilderCode({ BUILDER_CODE: 'bc_platform1', BUILDER_CODES_ENABLED: false })).toBeNull();
    expect(platformBuilderCode({ BUILDER_CODE: 'bad,code', BUILDER_CODES_ENABLED: true })).toBeNull();
  });

  it('the code is read from the deployment, trimmed, and an invalid one is dropped', async () => {
    for (const [given, read] of [[' bc_x1 ', 'bc_x1'], ['', undefined], ['has space', undefined], ['a,b', undefined]] as const) {
      const world = await makeWorld({ config: { BUILDER_CODE: given } });
      try {
        expect(world.ctx.config.BUILDER_CODE, given).toBe(read);
      } finally {
        await world.close();
      }
    }
  });

  it('BUILDER_CODES_ENABLED=false turns the suffix off even with a code set', async () => {
    const world = await makeWorld({ config: { BUILDER_CODES_ENABLED: 'false', BUILDER_CODE: 'bc_platform1' } });
    try {
      expect(world.ctx.config.BUILDER_CODES_ENABLED).toBe(false);
      expect(platformBuilderCode(world.ctx.config)).toBeNull();
      const calls = builderCodesFetch(world, ok());
      await registerAgent(world.ctx, launch(7n));
      expect(calls).toHaveLength(0);
    } finally {
      await world.close();
    }
  });
});
