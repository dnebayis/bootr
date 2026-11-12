/**
 * `POST /api/agent/launch` and who runs the agent (docs/design/byo-agent.md sections 5.4, 6 and 13.6): an own-agent
 * launch writes the reserved model id and no fuel, names no model, and is refused while own agents are switched off;
 * a Bootr-agent launch is what it always was. The route runs in mock mode here (no chain, the image pin computed),
 * with a real signature check.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { SiweMessage } from 'siwe';
import { decodeFunctionData, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OWN_AGENT_MODEL_ID, OWN_ERRORS } from '@bootr/shared/own-agent';
import { launcherAbi } from '@/lib/abi/launcher';
import { FALLBACK_MODELS, RECOMMENDED_MODEL } from '@/lib/models';
import { readLaunchDraft } from '@/lib/server/launch-drafts';
import { issueNonce } from '@/lib/server/siwe-verify';
import { POST as launch } from './route';

// The signature check without an RPC: a real ECDSA check.
vi.mock('viem', async (original) => {
  const actual = await original<typeof import('viem')>();
  return { ...actual, createPublicClient: () => ({ verifyMessage: (args: Parameters<typeof actual.verifyMessage>[0]) => actual.verifyMessage(args) }) };
});
vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, useMock: true } };
});
vi.mock('@/lib/server/relay-models', async (original) => {
  const actual = await original<typeof import('@/lib/server/relay-models')>();
  return { ...actual, relayModels: async () => ({ models: FALLBACK_MODELS }) };
});

// A throwaway key (the same one as e2e/agent-api.spec.ts): its address owns nothing.
const wallet = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const BASE = { name: 'Quiet Engine', symbol: 'qeng', identity: 'A patient onchain analyst for small Base coins.', image: { dataUrl: `data:image/png;base64,${PNG}` } };

let dir = '';
let ip = 0;

async function post(launchFields: Record<string, unknown>) {
  const message = new SiweMessage({ domain: 'bootr.fun', address: wallet.address, statement: 'Prepare a Bootr launch.', uri: 'https://bootr.fun', version: '1', chainId: 84532, nonce: issueNonce().nonce, issuedAt: new Date().toISOString() }).prepareMessage();
  const signature = await wallet.signMessage({ message });
  ip += 1;
  const res = await launch(
    new NextRequest('https://bootr.fun/api/agent/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': `10.8.${ip >> 8}.${ip & 255}` },
      body: JSON.stringify({ message, signature, launch: { ...BASE, ...launchFields } }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { transactions?: { step: string; data: `0x${string}`; to: string; value: string }[] } };
}

/** `LaunchParams` as the launch step's calldata carries them. */
function launchParams(body: { transactions?: { step: string; data: `0x${string}` }[] }) {
  const step = body.transactions!.find((t) => t.step === 'launch')!;
  return decodeFunctionData({ abi: launcherAbi, data: step.data }).args![0] as unknown as { model: string; fuelUsdc: bigint; workerHash: string; name: string };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bootr-own-launch-'));
  process.env.LAUNCH_DRAFTS_DIR = dir;
});
afterEach(() => {
  delete process.env.OWN_AGENT_ENABLED;
});
afterAll(async () => {
  delete process.env.LAUNCH_DRAFTS_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('an own-agent launch (runner: own), own agents switched on', () => {
  it('writes own-agent as the model and no fuel: no approve step, the launch is the first transaction, and the draft says own', async () => {
    process.env.OWN_AGENT_ENABLED = 'true';
    const { status, body } = await post({ runner: 'own' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ runner: 'own', model: OWN_AGENT_MODEL_ID, fuelUsdc: '0' });
    expect(body.transactions!.map((t) => t.step)).toEqual(['launch', 'gas']);
    const params = launchParams(body);
    expect(params.model).toBe('own-agent');
    expect(params.fuelUsdc).toBe(0n);
    expect(await readLaunchDraft(body.launchId as string)).toMatchObject({ runner: 'own', identity: BASE.identity });
  });

  it('carries fuel when the creator names an amount, with the approval for exactly that', async () => {
    process.env.OWN_AGENT_ENABLED = 'true';
    const { status, body } = await post({ runner: 'own', fuelUsdc: '5' });
    expect(status).toBe(200);
    expect(body.transactions!.map((t) => t.step)).toEqual(['approve', 'launch', 'gas']);
    expect(decodeFunctionData({ abi: erc20Abi, data: body.transactions![0]!.data }).args![1]).toBe(5_000_000n);
    expect(launchParams(body)).toMatchObject({ model: 'own-agent', fuelUsdc: 5_000_000n });
  });

  it('refuses a model: an own agent has none to choose, and the reserved id is the only one it takes', async () => {
    process.env.OWN_AGENT_ENABLED = 'true';
    const named = await post({ runner: 'own', model: RECOMMENDED_MODEL });
    expect(named.status).toBe(400);
    expect(named.body).toMatchObject({ error: 'invalid_request', field: 'model' });
    expect(String(named.body.message)).toContain('own-agent');
    const reserved = await post({ runner: 'own', model: OWN_AGENT_MODEL_ID });
    expect(reserved.status).toBe(200);
    expect(reserved.body.model).toBe('own-agent');
  });

  it('is the same coin otherwise: the worker, the path and the gas are what a Bootr-agent launch would get', async () => {
    process.env.OWN_AGENT_ENABLED = 'true';
    const own = await post({ runner: 'own', worker: 'researcher', launchThrough: 'clanker' });
    const hosted = await post({ worker: 'researcher', launchThrough: 'clanker' });
    expect(own.status).toBe(200);
    for (const key of ['worker', 'workerHash', 'launchThrough', 'launcher', 'launchFeeWei', 'buyback'] as const) expect(own.body[key], key).toEqual(hosted.body[key]);
    expect(launchParams(own.body).workerHash).toBe(launchParams(hosted.body).workerHash);
  });

  it('refuses a runner it does not know, whatever the flag says', async () => {
    process.env.OWN_AGENT_ENABLED = 'true';
    const { status, body } = await post({ runner: 'cloud' });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_request', field: 'runner' });
  });
});

describe('own agents switched off', () => {
  for (const value of [undefined, 'false', '', '1', 'TRUE']) {
    it(`refuses runner: own with own_agent_disabled and stores nothing (OWN_AGENT_ENABLED=${JSON.stringify(value)})`, async () => {
      if (value === undefined) delete process.env.OWN_AGENT_ENABLED;
      else process.env.OWN_AGENT_ENABLED = value;
      const before = (await readdir(dir)).length;
      const { status, body } = await post({ runner: 'own' });
      expect(status).toBe(404);
      expect(body.error).toBe('own_agent_disabled');
      expect(String(body.message)).toContain(OWN_ERRORS.own_agent_disabled.message);
      expect(body.transactions).toBeUndefined();
      expect((await readdir(dir)).length).toBe(before);
    });
  }

  it('does not let the reserved model id through the Bootr-agent path: it is not an offered model', async () => {
    const { status, body } = await post({ model: OWN_AGENT_MODEL_ID });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid_request', field: 'model' });
  });
});

describe('a Bootr-agent launch is what it always was', () => {
  for (const flag of ['true', undefined]) {
    it(`defaults: the recommended model, 20 USDC of fuel behind an approval, runner hosted (flag ${flag ?? 'unset'})`, async () => {
      if (flag) process.env.OWN_AGENT_ENABLED = flag;
      const { status, body } = await post({});
      expect(status).toBe(200);
      expect(body).toMatchObject({ runner: 'hosted', model: RECOMMENDED_MODEL, fuelUsdc: '20' });
      expect(body.transactions!.map((t) => t.step)).toEqual(['approve', 'launch', 'gas']);
      expect(decodeFunctionData({ abi: erc20Abi, data: body.transactions![0]!.data }).args![1]).toBe(20_000_000n);
      expect(launchParams(body)).toMatchObject({ model: RECOMMENDED_MODEL, fuelUsdc: 20_000_000n });
      // the draft of a Bootr-agent launch names no runner, like every draft before
      const draft = await readLaunchDraft(body.launchId as string);
      expect(draft).not.toBeNull();
      expect('runner' in draft!).toBe(false);
      // and naming the default changes nothing
      const explicit = await post({ runner: 'hosted' });
      expect(explicit.body).toMatchObject({ runner: 'hosted', model: RECOMMENDED_MODEL, fuelUsdc: '20' });
    });
  }

  it('has no minimum: 0 launches the coin with no approval, and 0.5 is taken as it is', async () => {
    const none = await post({ fuelUsdc: '0' });
    expect(none.status).toBe(200);
    expect(none.body.transactions!.map((t) => t.step)).toEqual(['launch', 'gas']);
    expect(launchParams(none.body).fuelUsdc).toBe(0n);
    const some = await post({ fuelUsdc: 0.5 });
    expect(some.status).toBe(200);
    expect(launchParams(some.body).fuelUsdc).toBe(500_000n);
    const bad = await post({ fuelUsdc: 'lots' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'invalid_request', field: 'fuelUsdc' });
  });
});
