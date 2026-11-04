import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseAgentConfig, ROUTING_RULES, TOOL_LIST } from '@bootr/agent-core';
import { agentActivity } from '../src/activity.js';
import { createApp } from '../src/api.js';
import { actions, agents, inference as inferenceTable, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { thoughtsByModel } from '../src/inference.js';
import { agentConfigOf } from '../src/onboarding.js';
import { decideModelOf, handleIntent, modelFor, startRouting, toolsForPhase, type RoutedTurn } from '../src/routing.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, agentConfig, CREATOR, finishResponse, makeWorld, seedAgent, SUPERVISOR_KEY, toolCallResponse, type TestWorld } from './helpers.js';

const WRITER = 'openai/gpt-4.1-mini';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** The relay's answer to the broker's image request (the picture `generate_image` makes), as images.test.ts scripts it. */
function imageResponse(): Response {
  const message = { role: 'assistant', content: 'Here you go.', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` } }] };
  return new Response(JSON.stringify({ id: 'img', choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 1300 } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-bootr-receipt': JSON.stringify({ requestId: 'r-img', quoteMicroUsdc: '43000', chargedMicroUsdc: '43000', paymentTxOrId: '0xtx', network: 'eip155:84532', usage: null }) },
  });
}
const DECIDER = 'deepseek/deepseek-v3.2';
const ECONOMY = { routing: { decideModel: DECIDER } };

type Post = { body: { model: string; messages: { role: string; content: string | null }[]; tools: { function: { name: string } }[] } };

function posts(w: TestWorld): Post[] {
  return w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')) as unknown as Post[];
}
const toolNames = (p: Post) => p.body.tools.map((t) => t.function.name);

async function runtimeRow(w: TestWorld) {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
}

function api(world: TestWorld) {
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  return {
    get: (path: string) => app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } }),
    put: (path: string, body: unknown) => {
      const text = JSON.stringify(body);
      return app.request(path, { method: 'PUT', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'PUT', path, text, nowSec()) } });
    },
  };
}

describe('routing state and tool sets', () => {
  const config = parseAgentConfig(agentConfig(Date.now(), ECONOMY));
  const catalog = TOOL_LIST.filter((t) => t.name !== 'search_web');

  it('is off without a decide model, with null, or with the writer itself as the decide model', () => {
    expect(startRouting(parseAgentConfig(agentConfig(Date.now())))).toBeNull();
    expect(startRouting(parseAgentConfig(agentConfig(Date.now(), { routing: { decideModel: null } })))).toBeNull();
    expect(startRouting(parseAgentConfig(agentConfig(Date.now(), { routing: { decideModel: WRITER } })))).toBeNull();
    expect(decideModelOf(config)).toBe(DECIDER);
    expect(startRouting(config)).toEqual({ phase: 'decide', decideModel: DECIDER, intent: null, steps: { decide: 0, write: 0 } });
  });

  it('gives the decide phase the catalog minus publishing and images plus draft_intent, and the writer the catalog', () => {
    const routing = startRouting(config)!;
    const decide = toolsForPhase(routing, catalog).map((t) => t.name);
    expect(decide).toContain('draft_intent');
    expect(decide).toContain('read_mentions');
    expect(decide).toContain('remember');
    expect(decide).toContain('treasury_prepare');
    expect(decide).toContain('finish');
    for (const name of ['publish_post', 'publish_reply', 'generate_image']) expect(decide).not.toContain(name);
    expect(modelFor(config, routing)).toBe(DECIDER);
    routing.phase = 'write';
    const write = toolsForPhase(routing, catalog).map((t) => t.name);
    expect(write).toEqual(catalog.map((t) => t.name));
    expect(write).not.toContain('draft_intent');
    expect(modelFor(config, routing)).toBe(WRITER);
    expect(toolsForPhase(null, catalog).map((t) => t.name)).toEqual(catalog.map((t) => t.name));
  });

  it('offers no draft_intent when neither publishing tool is open', () => {
    const quiet = catalog.filter((t) => t.name !== 'publish_post' && t.name !== 'publish_reply');
    const names = toolsForPhase(startRouting(config), quiet).map((t) => t.name);
    expect(names).not.toContain('draft_intent');
    expect(names).not.toContain('generate_image');
  });

  it('handleIntent switches the phase on a valid intent, rewrites the system prompt and restates the intent; stays on an invalid one', () => {
    const routing = startRouting(config)!;
    const turn: RoutedTurn = { messages: [{ role: 'system', content: 'old' }], recentSteps: [], routing };
    expect(handleIntent(config, turn, catalog, { id: 'c0', name: 'read_market', input: {} })).toBeNull();
    expect(handleIntent(config, turn, catalog, { id: 'c1', name: 'draft_intent', input: { kind: 'reply', about: 'no target' } })).toBe('invalid');
    expect(routing.phase).toBe('decide');
    expect(turn.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(turn.messages.at(-1)!.content).toContain('invalid_tool_call');
    expect(turn.recentSteps.at(-1)).toMatchObject({ tool: 'draft_intent', status: 'invalid' });
    // a reply intent while replies are closed is refused too
    const noReplies = catalog.filter((t) => t.name !== 'publish_reply');
    expect(handleIntent(config, turn, noReplies, { id: 'c2', name: 'draft_intent', input: { kind: 'reply', target: '55', about: 'x' } })).toBe('invalid');
    expect(turn.messages.at(-1)!.content).toContain('replies are not available');
    expect(routing.phase).toBe('decide');

    expect(handleIntent(config, turn, catalog, { id: 'c3', name: 'draft_intent', input: { kind: 'post', about: 'Holders doubled this week (read_market).' } })).toBe('switched');
    expect(routing.phase).toBe('write');
    expect(routing.intent).toEqual({ kind: 'post', about: 'Holders doubled this week (read_market).' });
    expect(turn.messages[0]!.content).toContain('ECONOMY MODE\n' + ROUTING_RULES.write);
    const result = JSON.parse(turn.messages.at(-1)!.content as string) as { decided: boolean; intent: unknown; note: string };
    expect(result.decided).toBe(true);
    expect(result.intent).toEqual(routing.intent);
    expect(result.note).toContain('You decided to write this; now write it');
    expect(result.note).toContain('draft_intent is gone');
    // once in the write phase the tool is no longer handled here
    expect(handleIntent(config, turn, catalog, { id: 'c4', name: 'draft_intent', input: { kind: 'post', about: 'again' } })).toBeNull();
  });
});

describe('economy mode turns', () => {
  it('starts on the decide model with draft_intent, switches to the writer on the intent, and meters each step by model', async () => {
    const script = [
      toolCallResponse('read_market', {}),
      toolCallResponse('draft_intent', { kind: 'post', about: 'TEST trades at $0.01 today; say so plainly and ask holders what they build.' }),
      toolCallResponse('generate_image', { prompt: 'a small coin on a desk', altText: 'A small coin on a desk' }),
      imageResponse(),
      toolCallResponse('publish_post', { text: 'TEST trades at about a cent today. What are you building with it?' }),
      finishResponse(Date.parse('2026-10-24T12:00:00Z') + 3_600_000),
    ];
    const w = await makeWorld({ script });
    try {
      await seedAgent(w, { config: { ...ECONOMY, capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: true } } });
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      expect(report.ran).toEqual([AGENT_ID]);

      // five thoughts; the broker's image request is a relay call too, but not a thought
      const calls = posts(w).filter((p) => !(p.body as { modalities?: unknown }).modalities);
      expect(calls).toHaveLength(5);
      // decide phase: the cheap model, the intent tool instead of the publishing tools, no images
      for (const p of calls.slice(0, 2)) {
        expect(p.body.model).toBe(DECIDER);
        expect(toolNames(p)).toContain('draft_intent');
        for (const name of ['publish_post', 'publish_reply', 'generate_image']) expect(toolNames(p)).not.toContain(name);
        expect(p.body.messages[0]!.content).toContain(ROUTING_RULES.decide);
      }
      // write phase: the agent's own model, the real publishing tools and generate_image back, draft_intent gone
      for (const p of calls.slice(2)) {
        expect(p.body.model).toBe(WRITER);
        expect(toolNames(p)).toContain('publish_post');
        expect(toolNames(p)).toContain('publish_reply');
        expect(toolNames(p)).toContain('generate_image');
        expect(toolNames(p)).not.toContain('draft_intent');
        expect(p.body.messages[0]!.content).toContain(ROUTING_RULES.write);
        expect(p.body.messages[0]!.content).not.toContain(ROUTING_RULES.decide);
      }
      // the writer's first request carries the intent as the result of its "own" draft_intent call
      const handoff = calls[2]!.body.messages.at(-1)!;
      expect(handoff.role).toBe('tool');
      expect(handoff.content).toContain('You decided to write this; now write it');
      expect(handoff.content).toContain('TEST trades at $0.01 today');

      // the intent never became an action; the post went out
      const acts = await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID));
      expect(acts.map((a) => (a.action as { tool: string }).tool).sort()).toEqual(['finish', 'generate_image', 'publish_post', 'read_market']);
      expect(w.sender.published).toHaveLength(1);
      const runtime = await runtimeRow(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.status).toBe('waiting');
      expect(runtime.cycle).toBe(5);

      // metering: every sv_inference row names the model it ran on, summed per model for the creator
      const rows = await w.db.select().from(inferenceTable).where(eq(inferenceTable.agentId, AGENT_ID));
      const thoughts = rows.filter((r) => !(r.request as { modalities?: unknown }).modalities);
      expect(thoughts.map((r) => (r.request as { model: string }).model).sort()).toEqual([DECIDER, DECIDER, WRITER, WRITER, WRITER].sort());
      const totals = await thoughtsByModel(w.ctx, AGENT_ID, new Date(w.ctx.now() - 86_400_000));
      expect(totals.find((t) => t.model === DECIDER)).toEqual({ model: DECIDER, thoughts: 2, chargedMicroUsdc: '2000' });
      expect(totals.find((t) => t.model === WRITER)).toEqual({ model: WRITER, thoughts: 3, chargedMicroUsdc: '3000' });
      expect(totals.find((t) => t.model === 'google/gemini-2.5-flash-image')).toEqual({ model: 'google/gemini-2.5-flash-image', thoughts: 1, chargedMicroUsdc: '43000' });
      const fuel = await api(w).get(`/internal/agents/${AGENT_ID}/fuel?days=7`);
      expect(fuel.status).toBe(200);
      expect(await fuel.json()).toMatchObject({ agentId: AGENT_ID, days: 7, byModel: expect.arrayContaining([{ model: DECIDER, thoughts: 2, chargedMicroUsdc: '2000' }]) });
      expect((await api(w).get(`/internal/agents/${AGENT_ID}/fuel?days=0`)).status).toBe(400);
      expect((await api(w).get('/internal/agents/404/fuel')).status).toBe(404);
    } finally {
      await w.close();
    }
  });

  it('runs a turn with nothing to say entirely on the decide model', async () => {
    const script = [toolCallResponse('read_market', {}), toolCallResponse('remember', { text: 'TEST at $0.01 on 2026-10-24', tags: ['price'] }), finishResponse(Date.parse('2026-10-24T12:00:00Z') + 3_600_000)];
    const w = await makeWorld({ script });
    try {
      await seedAgent(w, { config: ECONOMY });
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      const calls = posts(w);
      expect(calls).toHaveLength(3);
      expect(calls.every((p) => p.body.model === DECIDER)).toBe(true);
      expect(calls.every((p) => toolNames(p).includes('draft_intent') && !toolNames(p).includes('publish_post'))).toBe(true);
      expect((await runtimeRow(w)).state).toMatchObject({ phase: 'social', memory: 'm' });
      expect(await w.ctx.memories.count(AGENT_ID)).toBe(1);
      const totals = await thoughtsByModel(w.ctx, AGENT_ID, new Date(w.ctx.now() - 86_400_000));
      expect(totals).toEqual([{ model: DECIDER, thoughts: 3, chargedMicroUsdc: '3000' }]);
    } finally {
      await w.close();
    }
  });

  it('answers a publishing call in the decide phase as unavailable and keeps the phase', async () => {
    const script = [toolCallResponse('publish_post', { text: 'too early to write this myself' }), toolCallResponse('draft_intent', { kind: 'post', about: 'say hello' }), finishResponse(Date.parse('2026-10-24T12:00:00Z') + 3_600_000)];
    const w = await makeWorld({ script });
    try {
      await seedAgent(w, { config: ECONOMY });
      await tick(w.ctx);
      const calls = posts(w);
      expect(calls).toHaveLength(3);
      expect(calls[1]!.body.model).toBe(DECIDER);
      expect(calls[1]!.body.messages.at(-1)!.content).toContain('tool_unavailable: publish_post');
      expect(calls[2]!.body.model).toBe(WRITER);
      expect(w.sender.published).toHaveLength(0);
      expect((await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).map((a) => (a.action as { tool: string }).tool)).toEqual(['finish']);
    } finally {
      await w.close();
    }
  });

  it('shares one step budget across both phases', async () => {
    const script = [toolCallResponse('read_market', {}), toolCallResponse('draft_intent', { kind: 'post', about: 'say hello' }), toolCallResponse('read_market', {}), toolCallResponse('publish_post', { text: 'never reached' })];
    const w = await makeWorld({ script, config: { MAX_TOOL_STEPS: '3' } });
    try {
      await seedAgent(w, { config: ECONOMY });
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      // 2 decide steps + 1 writer step = the cap; the writer's publish never ran
      expect(posts(w)).toHaveLength(3);
      expect(posts(w).map((p) => p.body.model)).toEqual([DECIDER, DECIDER, WRITER]);
      const runtime = await runtimeRow(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.state).toMatchObject({ continuation: { progress: expect.stringContaining('step cap reached') } });
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('a turn with economy mode off runs on the writer with the publishing tools from the first step', async () => {
    const script = [toolCallResponse('publish_post', { text: 'plain mode post, written on the first step' }), finishResponse(Date.parse('2026-10-24T12:00:00Z') + 3_600_000)];
    const w = await makeWorld({ script });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const calls = posts(w);
      expect(calls.map((p) => p.body.model)).toEqual([WRITER, WRITER]);
      expect(toolNames(calls[0]!)).toContain('publish_post');
      expect(toolNames(calls[0]!)).not.toContain('draft_intent');
      expect(calls[0]!.body.messages[0]!.content).not.toContain('ECONOMY MODE');
      expect(w.sender.published).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});

describe('PUT /internal/agents/:id/config routing', () => {
  it('sets, validates and clears the decide model, records the edit and shows it on the tape', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const { put, get } = api(w);
      const path = `/internal/agents/${AGENT_ID}/config`;
      const expectError = async (body: unknown, status: number, error: string) => {
        const res = await put(path, body);
        expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([status, error]);
      };
      expect(((await (await get(path)).json()) as { routing: unknown }).routing).toEqual({ decideModel: null });

      await expectError({ by: CREATOR, routing: { decideModel: 'openai/o3' }, allowedModels: [WRITER, DECIDER] }, 400, 'model_not_allowed');
      await expectError({ by: CREATOR, routing: { decideModel: '' } }, 400, 'invalid_routing');
      await expectError({ by: CREATOR, routing: { decideModel: 7 } }, 400, 'invalid_routing');
      await expectError({ by: CREATOR, routing: 'deepseek' }, 400, 'invalid_routing');
      await expectError({ by: CREATOR, routing: { decideModel: null } }, 409, 'unchanged');

      const on = await put(path, { by: CREATOR, routing: { decideModel: ` ${DECIDER} ` }, allowedModels: [WRITER, DECIDER] });
      expect(on.status).toBe(200);
      const body = (await on.json()) as { routing: { decideModel: string | null }; revision: number };
      expect(body.routing).toEqual({ decideModel: DECIDER });
      expect(body.revision).toBe(2);
      const parsed = agentConfigOf((await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!)!;
      expect(parsed.routing).toEqual({ decideModel: DECIDER });
      expect(startRouting(parsed)?.decideModel).toBe(DECIDER);
      await expectError({ by: CREATOR, routing: { decideModel: DECIDER } }, 409, 'unchanged');

      const tape = await agentActivity(w.ctx, (await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!, null);
      expect(tape.find((i) => i.kind === 'config')?.summary).toBe('Config updated: economy mode');
      const rows = await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID));
      expect(rows[0]).toMatchObject({ action: { kind: 'config_updated', fields: ['routing'], revision: 2 } });

      const off = await put(path, { by: CREATOR, routing: { decideModel: null } });
      expect(((await off.json()) as { routing: unknown; revision: number }).routing).toEqual({ decideModel: null });
      expect(agentConfigOf((await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!)!.routing).toEqual({ decideModel: null });
    } finally {
      await w.close();
    }
  });
});
