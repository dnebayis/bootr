import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { customWorker, normalizeWorkerPreset, POSTS_PER_DAY, postIntervalForPostsPerDay, workerTemplateById } from '@bootr/shared/workers';
import { agentActivity, shortAmount } from '../src/activity.js';
import { createApp } from '../src/api.js';
import { actions, agents, runtimes, treasuryOps } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { DEFAULT_COIN_IMAGE_MODEL } from '../src/images.js';
import { agentConfigOf, defaultIdentity, PLATFORM_CAPABILITIES, PLATFORM_POST_INTERVAL_MS } from '../src/onboarding.js';
import { DEFAULT_SERVICES_POLICY } from '@bootr/agent-core';
import { AGENT_ID, CREATOR, KERNEL, makeWorld, seedAgent, SUPERVISOR_KEY, type TestWorld } from './helpers.js';

const CARD_URI = 'https://bootr.fun/agents/7.json';
const INSTRUCTIONS = 'A patient onchain analyst for small Base coins. Short, plain, no hype.';
const COMMUNITY = workerTemplateById('community')!;
const CUSTOM_PRESET = normalizeWorkerPreset({ capabilities: { xRead: true, xReply: false, xPublish: true, research: true, images: true }, postIntervalMs: 8 * 3_600_000, jobLines: ['Watch Base DeFi and post one sourced finding per cycle.'] })!;
const CUSTOM = customWorker(CUSTOM_PRESET);

function api(world: TestWorld) {
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  return {
    get: async (path: string) => app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } }),
    put: async (path: string, body: unknown) => {
      const text = JSON.stringify(body);
      return app.request(path, { method: 'PUT', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'PUT', path, text, nowSec()) } });
    },
  };
}

/** A community-preset agent as registration stores it today, X connected, creator text set. */
const presetConfig = (over: Record<string, unknown> = {}) => ({
  identityText: `${INSTRUCTIONS}\n\n${defaultIdentity('Test Coin', 'TEST', CARD_URI, false, COMMUNITY.preset.identity)}`,
  creatorIdentity: INSTRUCTIONS,
  capabilities: { ...COMMUNITY.preset.capabilities },
  postIntervalMs: COMMUNITY.preset.postIntervalMs,
  workerTemplate: 'community',
  workerHash: COMMUNITY.hash,
  agentURI: CARD_URI,
  revision: 1,
  ...over,
});

describe('GET /internal/agents/:id/config', () => {
  it('reports the configuration in force: instructions, model, worker kind, powers, cadence, job lines, revision', async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world, { config: presetConfig() });
      const res = await api(world).get(`/internal/agents/${AGENT_ID}/config`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        agentId: AGENT_ID,
        kernel: KERNEL,
        creator: CREATOR,
        model: 'openai/gpt-4.1-mini',
        instructions: INSTRUCTIONS,
        // `services` (paid web services) is a console switch like the others, off on every v1 preset
        worker: { kind: 'community', capabilities: { ...COMMUNITY.preset.capabilities, services: false }, postIntervalMs: COMMUNITY.preset.postIntervalMs, jobLines: COMMUNITY.preset.identity },
        workerHash: COMMUNITY.hash,
        postsPerDay: 24,
        requireApproval: false,
        routing: { decideModel: null },
        // a coin agent's default image model is the cheaper one (images.ts); the platform agent keeps Nano Banana Pro
        imageModel: DEFAULT_COIN_IMAGE_MODEL,
        imageStyle: { reference: null, notes: '' },
        services: DEFAULT_SERVICES_POLICY,
        // no policy stored on the seeded row: nothing is installed to compare, the wanted set is today's always-on rules
        sessionRules: { current: [], wanted: ['claims.settleAndClaim', 'claims.claimQuote', 'swap.approveWeth', 'swap.swapWethToUsdc', 'treasury.fundSpender', 'treasury.withdrawWethForGas'], reinstallNeeded: false },
        revision: 1,
        updatedAt: expect.any(String),
        xHold: null,
        xConnection: 'connected',
      });
      expect((await api(world).get('/internal/agents/404/config')).status).toBe(404);
      // a custom worker reports its stored preset
      await world.db.update(agents).set({ config: presetConfig({ workerTemplate: 'custom', workerHash: CUSTOM.hash, workerPreset: CUSTOM_PRESET, capabilities: CUSTOM_PRESET.capabilities, postIntervalMs: CUSTOM_PRESET.postIntervalMs }) }).where(eq(agents.agentId, AGENT_ID));
      const custom = (await (await api(world).get(`/internal/agents/${AGENT_ID}/config`)).json()) as { worker: unknown };
      expect(custom.worker).toEqual({ kind: 'custom', capabilities: CUSTOM_PRESET.capabilities, postIntervalMs: CUSTOM_PRESET.postIntervalMs, jobLines: CUSTOM_PRESET.identity });
    } finally {
      await world.close();
    }
  });
});

describe('GET /internal/agents/:id/config xHold', () => {
  it('shows the 403 hold on the X account while it lasts, and nothing once it has passed or was cleared', async () => {
    const world = await makeWorld();
    try {
      const now = world.ctx.now();
      await seedAgent(world, { config: presetConfig() });
      const read = async () => ((await (await api(world).get(`/internal/agents/${AGENT_ID}/config`)).json()) as { xHold: unknown }).xHold;
      expect(await read()).toBeNull();
      const row = (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      const until = now + 12 * 3_600_000;
      await world.db.update(runtimes).set({ state: { ...(row.state as Record<string, unknown>), postForbiddenUntil: until, postForbiddenStrikes: 2, postForbiddenAt: now } }).where(eq(runtimes.agentId, AGENT_ID));
      expect(await read()).toEqual({ reason: 'forbidden', until: new Date(until).toISOString(), strikes: 2 });
      // the PUT answer carries it too (the console replaces its config with that answer)
      const put = await api(world).put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, requireApproval: true });
      expect(put.status).toBe(200);
      expect(((await put.json()) as { xHold: unknown }).xHold).toEqual({ reason: 'forbidden', until: new Date(until).toISOString(), strikes: 2 });
      // past its time: gone, even before the tick clears the state
      world.setNow(until + 1);
      expect(await read()).toBeNull();
      world.setNow(now);
      await world.db.update(runtimes).set({ state: { ...(row.state as Record<string, unknown>), postForbiddenUntil: null, postForbiddenStrikes: 0 } }).where(eq(runtimes.agentId, AGENT_ID));
      expect(await read()).toBeNull();
    } finally {
      await world.close();
    }
  });
});

describe('GET /internal/agents/:id/config xConnection', () => {
  it("says connected, revoked or none from the sender's account row, and null when the sender does not answer", async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world, { config: presetConfig() });
      const read = async () => ((await (await api(world).get(`/internal/agents/${AGENT_ID}/config`)).json()) as { xConnection: unknown }).xConnection;
      expect(await read()).toBe('connected');
      // what the sender said of Brian Brain's agent on 2026-11-08 after the creator reset the app's access on X
      world.sender.accounts = { [AGENT_ID]: { agentId: AGENT_ID, connected: false, revoked: true, handle: 'brianbrain', xUserId: '77' } };
      expect(await read()).toBe('revoked');
      // the PUT answer carries it too
      const put = await api(world).put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, requireApproval: true });
      expect(put.status).toBe(200);
      expect(((await put.json()) as { xConnection: unknown }).xConnection).toBe('revoked');
      // no account row at all
      world.sender.accounts = {};
      expect(await read()).toBe('none');
      // the sender down: null, and the rest of the config still answers
      const account = world.ctx.sender.account;
      world.ctx.sender.account = async () => {
        throw new Error('sender unreachable');
      };
      const res = await api(world).get(`/internal/agents/${AGENT_ID}/config`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { xConnection: unknown; agentId: string }).xConnection).toBeNull();
      world.ctx.sender.account = account;
    } finally {
      await world.close();
    }
  });
});

describe('PUT /internal/agents/:id/config', () => {
  it('applies instructions, model, powers and cadence, bumps the revision, records the edit, and the next tick reads it', async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world, { config: presetConfig() });
      const { put, get } = api(world);
      const next = 'A sharper voice: two sentences per post, always dated, never a price call.';
      const res = await put(`/internal/agents/${AGENT_ID}/config`, {
        by: CREATOR.toLowerCase(),
        instructions: `  ${next}\r\n`,
        model: 'anthropic/claude-sonnet-4.5',
        allowedModels: ['openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4.5'],
        worker: { capabilities: { research: true, images: true, treasury: false }, postIntervalMs: 4 * 3_600_000 },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { revision: number; instructions: string; model: string; worker: { kind: string; capabilities: Record<string, boolean>; postIntervalMs: number; jobLines: string[] } };
      expect(body.revision).toBe(2);
      expect(body.instructions).toBe(next);
      expect(body.model).toBe('anthropic/claude-sonnet-4.5');
      // treasury stays on (always-on), the rest of the community powers are kept, the two switches flipped
      expect(body.worker).toEqual({ kind: 'community', capabilities: { ...COMMUNITY.preset.capabilities, research: true, images: true, services: false }, postIntervalMs: 4 * 3_600_000, jobLines: COMMUNITY.preset.identity });
      expect(await (await get(`/internal/agents/${AGENT_ID}/config`)).json()).toEqual(body);

      // the stored config the tick parses (`agentConfigOf` on the sv_agents row) carries all of it: live next tick
      const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      const parsed = agentConfigOf(agent)!;
      expect(parsed.revision).toBe(2);
      expect(parsed.model).toBe('anthropic/claude-sonnet-4.5');
      expect(parsed.capabilities).toEqual(body.worker.capabilities);
      expect(parsed.postIntervalMs).toBe(4 * 3_600_000);
      expect(parsed.identityText).toBe(`${next}\n\n${defaultIdentity('Test Coin', 'TEST', CARD_URI, false, COMMUNITY.preset.identity)}`);
      expect(agent.config.workerPreset).toEqual({ capabilities: body.worker.capabilities, postIntervalMs: 4 * 3_600_000, identity: COMMUNITY.preset.identity });

      const rows = await world.db.select().from(actions).where(eq(actions.agentId, AGENT_ID));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionId: `config-${AGENT_ID}-r2`, status: 'completed', action: { kind: 'config_updated', fields: ['instructions', 'model', 'powers', 'cadence'], by: CREATOR, revision: 2 } });

      // a second edit of one field: revision 3, its own row
      expect((await put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, worker: { postIntervalMs: 24 * 3_600_000 } })).status).toBe(200);
      expect((await world.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).map((r) => (r.action as { fields: string[] }).fields)).toEqual([['instructions', 'model', 'powers', 'cadence'], ['cadence']]);
      expect(agentConfigOf((await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!)!.revision).toBe(3);
    } finally {
      await world.close();
    }
  });

  it('rejects out-of-bounds workers, a wrong `by`, a model outside the allow-list, bad instructions, and answers 409 to a no-op', async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world, { config: presetConfig() });
      const { put } = api(world);
      const path = `/internal/agents/${AGENT_ID}/config`;
      const expectError = async (body: unknown, status: number, error: string) => {
        const res = await put(path, body);
        expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([status, error]);
      };
      await expectError({ by: '0x9000000000000000000000000000000000000009', model: 'x/y' }, 403, 'not_creator');
      await expectError({ by: 'nope', model: 'x/y' }, 400, 'invalid_by');
      await expectError({ by: CREATOR, worker: { postIntervalMs: 10 * 60_000 } }, 400, 'invalid_worker'); // below 30 min
      await expectError({ by: CREATOR, worker: { postIntervalMs: 8 * 86_400_000 } }, 400, 'invalid_worker'); // above 7 d
      await expectError({ by: CREATOR, worker: { capabilities: { flight: true } } }, 400, 'invalid_worker');
      await expectError({ by: CREATOR, worker: { capabilities: { xRead: 'yes' } } }, 400, 'invalid_worker');
      await expectError({ by: CREATOR, worker: { jobLines: ['a', 'b', 'c', 'd', 'e'] } }, 400, 'invalid_worker'); // 5 lines
      await expectError({ by: CREATOR, worker: { jobLines: ['x'.repeat(241)] } }, 400, 'invalid_worker');
      await expectError({ by: CREATOR, worker: { jobLines: ['A new job line for a preset agent.'] } }, 400, 'job_lines_fixed');
      await expectError({ by: CREATOR, model: 'openai/o3', allowedModels: ['openai/gpt-4.1-mini'] }, 400, 'model_not_allowed');
      await expectError({ by: CREATOR, model: '' }, 400, 'invalid_model');
      await expectError({ by: CREATOR, instructions: 'too short' }, 400, 'invalid_instructions');
      await expectError({ by: CREATOR, instructions: 'x'.repeat(601) }, 400, 'invalid_instructions');
      await expectError({ by: CREATOR, instructions: 42 }, 400, 'invalid_instructions');
      // no-ops: same values, or an empty body
      await expectError({ by: CREATOR, instructions: INSTRUCTIONS, model: 'openai/gpt-4.1-mini', worker: { postIntervalMs: COMMUNITY.preset.postIntervalMs, capabilities: { research: false } } }, 409, 'unchanged');
      await expectError({ by: CREATOR }, 409, 'unchanged');
      await expectError({ by: CREATOR, worker: { capabilities: { memory: false } } }, 409, 'unchanged'); // always-on: forced back
      expect((await put('/internal/agents/404/config', { by: CREATOR, model: 'x/y' })).status).toBe(404);
      // nothing was written
      const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      expect(agent.config.revision).toBe(1);
      expect(await world.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it('takes an image model from the relay list and an image style (reference and notes), and labels them on the tape', async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world, { config: presetConfig({ imageStyle: { reference: 'https://cdn.bootr.fun/coins/test.png', notes: '' } }) });
      const { put, get } = api(world);
      const path = `/internal/agents/${AGENT_ID}/config`;
      // the test relay answers `{}` to GET /v1/models: the built-in list applies
      const res = await put(path, { by: CREATOR, imageModel: 'openai/gpt-5.4-image-2', imageStyle: { notes: '  flat\tcolours,\n no  text  ' } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { imageModel: string; imageStyle: { reference: string | null; notes: string }; revision: number };
      // stored under its catalog id whatever name the relay lists it by
      expect(body.imageModel).toBe('openai/gpt-image-2');
      // a partial style keeps the reference and normalises the notes to one line
      expect(body.imageStyle).toEqual({ reference: 'https://cdn.bootr.fun/coins/test.png', notes: 'flat colours, no text' });
      expect(body.revision).toBe(2);
      expect(await (await get(path)).json()).toMatchObject({ imageModel: 'openai/gpt-image-2', imageStyle: body.imageStyle });
      // the parsed config the tick runs with carries both
      const parsed = agentConfigOf((await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!)!;
      expect(parsed.imageModel).toBe('openai/gpt-image-2');
      expect(parsed.imageStyle).toEqual(body.imageStyle);

      // reference off, then another picture
      expect(((await (await put(path, { by: CREATOR, imageStyle: { reference: null } })).json()) as { imageStyle: unknown }).imageStyle).toEqual({ reference: null, notes: 'flat colours, no text' });
      expect(((await (await put(path, { by: CREATOR, imageStyle: { reference: 'https://cdn.bootr.fun/coins/other.png' } })).json()) as { imageStyle: unknown }).imageStyle).toEqual({ reference: 'https://cdn.bootr.fun/coins/other.png', notes: 'flat colours, no text' });

      const expectError = async (b: unknown, status: number, error: string) => {
        const r = await put(path, b);
        expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([status, error]);
      };
      await expectError({ by: CREATOR, imageModel: 'openai/gpt-4.1-mini' }, 400, 'image_model_not_allowed'); // a mind, not an image model
      await expectError({ by: CREATOR, imageModel: '' }, 400, 'invalid_image_model');
      await expectError({ by: CREATOR, imageStyle: { reference: 'http://cdn.bootr.fun/x.png' } }, 400, 'invalid_image_style');
      await expectError({ by: CREATOR, imageStyle: { reference: 'ipfs://bafy' } }, 400, 'invalid_image_style');
      await expectError({ by: CREATOR, imageStyle: { notes: 'x'.repeat(201) } }, 400, 'invalid_image_style');
      await expectError({ by: CREATOR, imageStyle: 'flat' }, 400, 'invalid_image_style');
      await expectError({ by: CREATOR, imageModel: 'openai/gpt-5.4-image-2', imageStyle: { notes: 'flat colours, no text' } }, 409, 'unchanged');

      const fields = (await world.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).map((r) => (r.action as { fields: string[] }).fields);
      expect(fields).toEqual([['imageModel', 'imageStyle'], ['imageStyle'], ['imageStyle']]);
      const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      const runtime = (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      const tape = await agentActivity(world.ctx, agent, runtime);
      expect(tape.map((t) => t.summary)).toContain('Config updated: image model, image style');
    } finally {
      await world.close();
    }
  });

  it('accepts the relay\'s own image model list when it answers', async () => {
    const world = await makeWorld();
    try {
      const inner = world.ctx.fetch;
      world.ctx.fetch = (async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/v1/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'google/gemini-2.5-flash-image', output_modalities: ['text', 'image'] }, { id: 'openai/gpt-4.1-mini', output_modalities: ['text'] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return inner(input, init);
      }) as typeof fetch;
      await seedAgent(world, { config: presetConfig() });
      const { put } = api(world);
      const path = `/internal/agents/${AGENT_ID}/config`;
      expect((await put(path, { by: CREATOR, imageModel: 'google/gemini-2.5-flash-image' })).status).toBe(200);
      // the relay's list, not the built-in one, decides; and it is cached, so the second answer does not need the relay
      const res = await put(path, { by: CREATOR, imageModel: 'google/gemini-3-pro-image' });
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, 'image_model_not_allowed']);
    } finally {
      await world.close();
    }
  });

  it('toggles the platform agent\'s powers (images included) without touching its cadence or persona', async () => {
    const world = await makeWorld();
    try {
      const identity = defaultIdentity('Test Coin', 'TEST', CARD_URI, true);
      await seedAgent(world, { config: presetConfig({ platform: true, capabilities: { ...PLATFORM_CAPABILITIES }, postIntervalMs: PLATFORM_POST_INTERVAL_MS, identityText: identity, creatorIdentity: '' }) });
      const { put, get } = api(world);
      const path = `/internal/agents/${AGENT_ID}/config`;
      expect(((await (await get(path)).json()) as { worker: { capabilities: Record<string, boolean>; postIntervalMs: number } }).worker).toMatchObject({ capabilities: PLATFORM_CAPABILITIES, postIntervalMs: PLATFORM_POST_INTERVAL_MS });
      const res = await put(path, { by: CREATOR, worker: { capabilities: { images: true } } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { worker: { capabilities: Record<string, boolean>; postIntervalMs: number } };
      expect(body.worker.capabilities).toEqual({ ...PLATFORM_CAPABILITIES, images: true });
      expect(body.worker.postIntervalMs).toBe(PLATFORM_POST_INTERVAL_MS);
      const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      const parsed = agentConfigOf(agent)!;
      expect(parsed.capabilities.images).toBe(true);
      expect(parsed.postIntervalMs).toBe(PLATFORM_POST_INTERVAL_MS);
      expect(parsed.identityText).toBe(identity); // no job lines enter the platform persona
      expect(parsed.platform).toBe(true);
    } finally {
      await world.close();
    }
  });

  it('lets a custom worker edit its job lines, which re-enter the identity text', async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world, { config: presetConfig({ workerTemplate: 'custom', workerHash: CUSTOM.hash, workerPreset: CUSTOM_PRESET, capabilities: CUSTOM_PRESET.capabilities, postIntervalMs: CUSTOM_PRESET.postIntervalMs }) });
      const res = await api(world).put(`/internal/agents/${AGENT_ID}/config`, { by: CREATOR, worker: { jobLines: ['  Watch Base DeFi.  ', '', 'Never reply; only publish.'] } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { worker: { jobLines: string[] }; workerHash: string };
      expect(body.worker.jobLines).toEqual(['Watch Base DeFi.', 'Never reply; only publish.']);
      expect(body.workerHash).toBe(CUSTOM.hash); // the on-chain commitment is not rewritten
      const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      expect(agentConfigOf(agent)!.identityText).toBe(`${INSTRUCTIONS}\n\n${defaultIdentity('Test Coin', 'TEST', CARD_URI, false, ['Watch Base DeFi.', 'Never reply; only publish.'])}`);
      expect((await world.db.select().from(actions)).map((r) => (r.action as { fields: string[] }).fields)).toEqual([['jobLines']]);
    } finally {
      await world.close();
    }
  });
});

describe('GET /internal/agents/:id/activity', () => {
  const T0 = Date.parse('2026-10-24T12:00:00Z');
  const at = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000);

  async function seedTape(world: TestWorld) {
    await seedAgent(world, { config: presetConfig(), runtime: { status: 'sleeping', updatedAt: at(1) } });
    const row = (tool: string, min: number, status: 'completed' | 'failed', result: Record<string, unknown> | null = null) => ({ actionId: `${tool}-${min}`, agentId: AGENT_ID, cycleKey: `c${min}`, action: { tool, input: {} }, status, result, createdAt: at(min), updatedAt: at(min) });
    await world.db.insert(actions).values([
      row('publish_post', 50, 'completed', { postId: '1234' }),
      row('read_mentions', 45, 'completed', { items: [] }), // not on the tape
      row('publish_reply', 40, 'completed', { postId: '1235', replyAuthorId: '77' }),
      row('publish_post', 35, 'failed'), // not on the tape
      { actionId: `config-${AGENT_ID}-r2`, agentId: AGENT_ID, cycleKey: 'config:2', action: { kind: 'config_updated', fields: ['cadence', 'powers'], by: CREATOR, revision: 2 }, status: 'completed' as const, result: null, createdAt: at(20), updatedAt: at(20) },
    ]);
    const op = (opId: string, kind: 'claim_fees' | 'swap' | 'fund_gas' | 'fund_model', min: number, status: 'confirmed' | 'failed' | 'prepared', description: string) => ({
      opId,
      agentId: AGENT_ID,
      kind,
      calls: [],
      callHash: opId,
      description,
      origin: 'policy',
      status,
      txHash: status === 'prepared' ? null : `0x${opId.padEnd(64, '0')}`,
      confirmedAt: status === 'confirmed' ? at(min) : null,
      createdAt: at(min + 1),
      updatedAt: at(min),
    });
    await world.db.insert(treasuryOps).values([
      op('aa', 'claim_fees', 30, 'confirmed', 'claim 0.0024 WETH of swap fees (~$7.20; 0.001 pending + 0.0014 settled) via settleAndClaim'),
      op('bb', 'swap', 25, 'confirmed', 'swap 0.002 WETH -> ~>= 4.500000 USDC via the swap helper (refuel to 20)'),
      op('cc', 'fund_gas', 15, 'failed', 'unwrap 0.0005 WETH into gas (gas 0 ETH -> target 0.001 ETH)'),
      op('dd', 'fund_model', 10, 'confirmed', 'fund the spender 0xabc with 5.000000 USDC (float 1 -> target 6; 44 USDC left in this window)'),
      op('ee', 'claim_fees', 5, 'prepared', 'claim 0.001 WETH of swap fees'), // in flight: not on the tape
    ]);
  }

  it('merges posts, config edits, treasury ops and the current status, newest first, with short summaries and links', async () => {
    const world = await makeWorld();
    try {
      await seedTape(world);
      const res = await api(world).get(`/internal/agents/${AGENT_ID}/activity`);
      expect(res.status).toBe(200);
      const { items } = (await res.json()) as { items: { at: string; kind: string; summary: string; txHash?: string; url?: string }[] };
      expect(items.map((i) => [i.kind, i.summary])).toEqual([
        ['status', 'Went to sleep: fuel below 1 USDC'],
        ['fuel', 'Added 5 USDC of fuel'],
        ['gas', 'Gas top-up failed'],
        ['config', 'Config updated: cadence, powers'],
        ['swap', 'Swapped 0.002 WETH to at least 4.5 USDC'],
        ['claim', 'Claimed 0.0024 WETH'],
        ['reply', 'Replied on X'],
        ['post', 'Posted on X'],
      ]);
      expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort().reverse());
      expect(items[1]).toMatchObject({ txHash: `0x${'dd'.padEnd(64, '0')}`, url: `https://sepolia.basescan.org/tx/0x${'dd'.padEnd(64, '0')}` });
      expect(items[6]!.url).toBe('https://x.com/bootr_agent/status/1235');
      expect(items[7]!.url).toBe('https://x.com/bootr_agent/status/1234');
      expect(items[0]!.url).toBeUndefined();
    } finally {
      await world.close();
    }
  });

  it('pages with limit (default 50, max 200) and the before cursor', async () => {
    const world = await makeWorld();
    try {
      await seedTape(world);
      const { get } = api(world);
      const page1 = (await (await get(`/internal/agents/${AGENT_ID}/activity?limit=3`)).json()) as { items: { at: string; kind: string }[] };
      expect(page1.items.map((i) => i.kind)).toEqual(['status', 'fuel', 'gas']);
      const cursor = page1.items[2]!.at;
      const page2 = (await (await get(`/internal/agents/${AGENT_ID}/activity?limit=3&before=${encodeURIComponent(cursor)}`)).json()) as { items: { kind: string }[] };
      expect(page2.items.map((i) => i.kind)).toEqual(['config', 'swap', 'claim']);
      const page3 = (await (await get(`/internal/agents/${AGENT_ID}/activity?limit=3&before=${encodeURIComponent(at(25).toISOString())}`)).json()) as { items: { kind: string }[] };
      expect(page3.items.map((i) => i.kind)).toEqual(['claim', 'reply', 'post']);
      expect((await get(`/internal/agents/${AGENT_ID}/activity?before=yesterday`)).status).toBe(400);
      expect((await get(`/internal/agents/${AGENT_ID}/activity?limit=abc`)).status).toBe(400);
      expect((await get('/internal/agents/404/activity')).status).toBe(404);
      // the module clamps the limit
      const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      const runtime = (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      expect((await agentActivity(world.ctx, agent, runtime, { limit: 1000 })).length).toBe(8);
      expect((await agentActivity(world.ctx, agent, runtime, { limit: 0 })).length).toBe(1);
    } finally {
      await world.close();
    }
  });

  it('shortAmount trims trailing zeros and keeps tiny amounts visible', () => {
    expect(shortAmount('0.002400', 6)).toBe('0.0024');
    expect(shortAmount('4.500000', 2)).toBe('4.5');
    expect(shortAmount('10', 2)).toBe('10');
    expect(shortAmount('0.0000004', 6)).toBe('0.0000004');
    expect(shortAmount('0.000000123456', 6)).toBe('0.00000012');
    expect(shortAmount('nope', 2)).toBe('nope');
  });
});

describe('posts per day (PUT postsPerDay)', () => {
  it('writes the sender quota, derives the cadence (half the budget for original posts), records both on the tape, and the next tick reads it', async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world, { config: presetConfig() });
      const { put, get } = api(world);
      const path = `/internal/agents/${AGENT_ID}/config`;
      // the default is the sender's default and the community cadence it implies
      expect(postIntervalForPostsPerDay(POSTS_PER_DAY.default)).toBe(COMMUNITY.preset.postIntervalMs);
      expect(((await (await get(path)).json()) as { postsPerDay: number }).postsPerDay).toBe(POSTS_PER_DAY.default);

      const res = await put(path, { by: CREATOR, postsPerDay: 12 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { revision: number; postsPerDay: number; worker: { kind: string; postIntervalMs: number } };
      expect(body.postsPerDay).toBe(12);
      expect(body.worker).toMatchObject({ kind: 'community', postIntervalMs: 4 * 3_600_000 });
      expect(world.sender.quotaWrites).toEqual([{ agentId: AGENT_ID, patch: { postsPerDay: 12 } }]);
      const parsed = agentConfigOf((await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!)!;
      expect(parsed.postsPerDay).toBe(12);
      expect(parsed.postIntervalMs).toBe(4 * 3_600_000);
      let fields = (await world.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).map((r) => (r.action as { fields: string[] }).fields);
      expect(fields).toEqual([['postsPerDay', 'cadence']]);
      const runtime = (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      const tape = await agentActivity(world.ctx, (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!, runtime);
      expect(tape.find((i) => i.kind === 'config')?.summary).toBe('Config updated: posts per day, cadence');

      // the budget wins over a cadence sent in the same body; a budget whose cadence is already in force changes the budget alone
      expect((await put(path, { by: CREATOR, postsPerDay: 6, worker: { postIntervalMs: 3_600_000 } })).status).toBe(200);
      expect((await put(path, { by: CREATOR, worker: { postIntervalMs: 4 * 3_600_000 } })).status).toBe(200);
      expect((await put(path, { by: CREATOR, postsPerDay: 13 })).status).toBe(200);
      fields = (await world.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).map((r) => (r.action as { fields: string[] }).fields);
      expect(fields).toEqual([['postsPerDay', 'cadence'], ['cadence', 'postsPerDay'], ['cadence'], ['postsPerDay']]);
      expect(world.sender.quotaWrites.map((q) => q.patch.postsPerDay)).toEqual([12, 6, 13]);
      const view = (await (await get(path)).json()) as { postsPerDay: number; worker: { postIntervalMs: number } };
      expect(view).toMatchObject({ postsPerDay: 13, worker: { postIntervalMs: 4 * 3_600_000 } });

      // bounds, a no-op, and the sender down: nothing stored, no revision
      const expectError = async (body: unknown, status: number, error: string) => {
        const r = await put(path, body);
        expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([status, error]);
      };
      await expectError({ by: CREATOR, postsPerDay: 13 }, 409, 'unchanged');
      await expectError({ by: CREATOR, postsPerDay: POSTS_PER_DAY.min - 1 }, 400, 'invalid_posts_per_day');
      await expectError({ by: CREATOR, postsPerDay: POSTS_PER_DAY.max + 1 }, 400, 'invalid_posts_per_day');
      await expectError({ by: CREATOR, postsPerDay: '12' }, 400, 'invalid_posts_per_day');
      world.sender.quotaError = new Error('sender down');
      await expectError({ by: CREATOR, postsPerDay: 20, instructions: 'Another voice for this coin, still plain and dated.' }, 503, 'sender_unavailable');
      const after = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      expect(after.config.postsPerDay).toBe(13);
      expect(after.config.revision).toBe(5);
      expect(after.config.creatorIdentity).toBe(INSTRUCTIONS);
    } finally {
      await world.close();
    }
  });

  it('maps a budget to a cadence: 24 h over half of it, whole minutes, inside the worker bounds', () => {
    const H = 3_600_000;
    expect(postIntervalForPostsPerDay(48)).toBe(H);
    expect(postIntervalForPostsPerDay(24)).toBe(2 * H);
    expect(postIntervalForPostsPerDay(12)).toBe(4 * H);
    expect(postIntervalForPostsPerDay(6)).toBe(8 * H);
    expect(postIntervalForPostsPerDay(2)).toBe(24 * H);
    expect(postIntervalForPostsPerDay(3)).toBe(24 * H);
    expect(postIntervalForPostsPerDay(7)).toBe(8 * H);
    expect(postIntervalForPostsPerDay(14)).toBe(Math.round((24 * H) / 7 / 60_000) * 60_000);
    // out of range is clamped to the control's range first
    expect(postIntervalForPostsPerDay(1)).toBe(24 * H);
    expect(postIntervalForPostsPerDay(1000)).toBe(H);
  });
});
