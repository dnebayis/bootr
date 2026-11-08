/**
 * The one-shot move of every agent to the models BlockRun serves (model-migration.ts) and the catalog check that runs
 * at start (model-check.ts), against several agent shapes on a real database and a stubbed BlockRun model list.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MODEL_CATALOG, modelDisplayName } from '@bootr/agent-core';
import { agentActivity } from '../src/activity.js';
import { createApp } from '../src/api.js';
import { actions, agents, notifications, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { checkModelCatalog, lastCatalogCheck, modelFieldsOf } from '../src/model-check.js';
import { applyPlan, changeSummary, migrateModels, planConfigMigration } from '../src/model-migration.js';
import { notificationText } from '../src/notifications.js';
import { agentConfig, CREATOR, KERNEL, makeWorld, SUPERVISOR_KEY, TOKEN, type TestWorld } from './helpers.js';

/** BlockRun's list as the check reads it: the whole catalog, plus a served model the catalog does not list. */
const LIVE = {
  object: 'list',
  data: [
    ...MODEL_CATALOG.map((m) => ({ id: m.id, available: true, pricing: 'perImageMicroUsdc' in m.price ? { per_image: m.price.perImageMicroUsdc / 1_000_000 } : { input: m.price.inputMicroUsdcPerKTokens / 1000, output: m.price.outputMicroUsdcPerKTokens / 1000 } })),
    { id: 'openai/gpt-6-luna', available: true, pricing: { input: 0.1, output: 0.5 } },
  ],
};

function serveModels(w: TestWorld, body: unknown = LIVE, status = 200) {
  const inner = w.ctx.fetch;
  w.ctx.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://blockrun.test/') && url.endsWith('/models')) return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    return inner(input, init);
  }) as typeof fetch;
}

/** Each seeded agent gets its own kernel and coin (both unique in sv_agents), numbered after its id. */
const addr = (base: string, agentId: string) => `${base.slice(0, 42 - agentId.length)}${agentId}`;

async function seed(w: TestWorld, agentId: string, config: Record<string, unknown>, status: 'onboarding' | 'active' | 'revoked' = 'active') {
  const now = w.ctx.now();
  await w.db.insert(agents).values({ agentId, token: addr(TOKEN, agentId), kernel: addr(KERNEL, agentId), creator: CREATOR, config: agentConfig(now, { agentId, ...config }), permissionId: '0x11223344', sessionKeyInstalledAt: new Date(now), status });
  await w.db.insert(runtimes).values({ agentId, state: { phase: 'social', memory: 'remembered', agenda: 'a', summary: 's' }, cycle: 3, nextAt: new Date(now + 60_000), status: 'waiting', configRevision: 1 });
}

async function world() {
  const w = await makeWorld({ config: { BLOCKRUN_DIRECT_MODE: 'all', BLOCKRUN_BASE_URL: 'https://blockrun.test/api/v1' } });
  serveModels(w);
  // a) the $BOOTR shape: Sonnet, no economy mode, a picture model under the relay's name
  await seed(w, '1', { model: 'anthropic/claude-sonnet-4.6', imageModel: 'google/gemini-3-pro-image', platform: true, postIntervalMs: 6 * 3_600_000 });
  // b) a coin on Grok 4.20 with economy mode on DeepSeek V3.2 and no image model set
  await seed(w, '2', { model: 'x-ai/grok-4.20', routing: { decideModel: 'deepseek/deepseek-v3.2' }, revision: 4 });
  // c) already on catalog ids: nothing to do
  await seed(w, '3', { model: 'anthropic/claude-haiku-4.5', routing: { decideModel: 'deepseek/deepseek-chat' }, imageModel: 'google/nano-banana-2' });
  // d) Llama with Gemini preview as the decider: the writer becomes DeepSeek Chat, the decider is renamed
  await seed(w, '4', { model: 'meta-llama/llama-4-maverick', routing: { decideModel: 'google/gemini-3.1-pro-preview' } });
  // e) a model BlockRun serves that the catalog does not list: kept
  await seed(w, '5', { model: 'openai/gpt-6-luna' });
  // f) a model nobody knows
  await seed(w, '6', { model: 'vendor/retired-forever', imageModel: 'openai/gpt-5-image-mini' });
  // g) a revoked agent is not touched
  await seed(w, '7', { model: 'x-ai/grok-4.20' }, 'revoked');
  return w;
}

const configOf = async (w: TestWorld, agentId: string) => (await w.db.query.agents.findFirst({ where: eq(agents.agentId, agentId) }))!.config;

describe('planConfigMigration', () => {
  it('maps retired ids to their stand-ins, keeps catalog ids and served ids, and names the rest', () => {
    const served = new Set(['openai/gpt-6-luna', 'anthropic/claude-haiku-4.5']);
    expect(planConfigMigration({ model: 'x-ai/grok-4.20', routing: { decideModel: 'deepseek/deepseek-v3.2' }, imageModel: 'google/gemini-3-pro-image' }, served)).toEqual({
      changes: [
        { field: 'model', from: 'x-ai/grok-4.20', to: 'xai/grok-4.3', same: false },
        { field: 'decideModel', from: 'deepseek/deepseek-v3.2', to: 'deepseek/deepseek-chat', same: false },
        { field: 'imageModel', from: 'google/gemini-3-pro-image', to: 'google/nano-banana-pro', same: true },
      ],
      unknown: [],
      notes: [],
    });
    expect(planConfigMigration({ model: 'anthropic/claude-haiku-4.5', routing: { decideModel: null } }, served)).toEqual({ changes: [], unknown: [], notes: [] });
    expect(planConfigMigration({ model: 'openai/gpt-6-luna' }, served)).toEqual({ changes: [], unknown: [], notes: [] });
    expect(planConfigMigration({ model: 'vendor/gone' }, served)).toEqual({ changes: [], unknown: [{ field: 'model', model: 'vendor/gone', checked: true }], notes: [] });
    expect(planConfigMigration({ model: 'vendor/gone' }, null).unknown).toEqual([{ field: 'model', model: 'vendor/gone', checked: false }]);
    // both the writer and the decider land on the same model: economy mode goes quiet, and the plan says so
    const collapsed = planConfigMigration({ model: 'deepseek/deepseek-v3.2', routing: { decideModel: 'meta-llama/llama-4-maverick' } }, served);
    expect(collapsed.changes.map((c) => c.to)).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-chat']);
    expect(collapsed.notes[0]).toContain('economy mode now does nothing');
  });

  it('applies only the three model fields and writes the change in plain words', () => {
    const before = { model: 'x-ai/grok-4.20', routing: { decideModel: 'deepseek/deepseek-v3.2' }, memory: 'kept', postIntervalMs: 7200000, xHandle: 'h', revision: 2 };
    const plan = planConfigMigration(before, null);
    const after = applyPlan(before, plan.changes);
    expect(after).toEqual({ ...before, model: 'xai/grok-4.3', routing: { decideModel: 'deepseek/deepseek-chat' } });
    expect(changeSummary(plan.changes)).toBe('Model changed to Grok 4.3; deciding model changed to DeepSeek Chat by the platform; everything else unchanged.');
    expect(changeSummary([{ field: 'imageModel', from: 'google/gemini-3-pro-image', to: 'google/nano-banana-pro', same: true }])).toBe('Image model now named Nano Banana Pro (the same model) by the platform; everything else unchanged.');
    expect(modelFieldsOf({ model: 'a/b', routing: { decideModel: '' }, imageModel: 7 })).toEqual([{ field: 'model', model: 'a/b' }]);
  });
});

describe('migrateModels', () => {
  it('dry run: prints the plan for every live agent and writes nothing', async () => {
    const w = await world();
    try {
      const before = await Promise.all(['1', '2', '3', '4', '5', '6', '7'].map((id) => configOf(w, id)));
      const report = await migrateModels(w.ctx);
      expect(report.dryRun).toBe(true);
      expect(report.checkedAgainstBlockRun).toBe(true);
      expect(report.summary).toEqual({ agents: 6, changed: 4, unknown: 1 });
      expect(report.agents.map((a) => a.agentId)).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(report.agents.find((a) => a.agentId === '1')!.changes).toEqual([{ field: 'imageModel', from: 'google/gemini-3-pro-image', to: 'google/nano-banana-pro', same: true }]);
      expect(report.agents.find((a) => a.agentId === '2')!.changes).toEqual([
        { field: 'model', from: 'x-ai/grok-4.20', to: 'xai/grok-4.3', same: false },
        { field: 'decideModel', from: 'deepseek/deepseek-v3.2', to: 'deepseek/deepseek-chat', same: false },
      ]);
      expect(report.agents.find((a) => a.agentId === '4')!.changes).toEqual([
        { field: 'model', from: 'meta-llama/llama-4-maverick', to: 'deepseek/deepseek-chat', same: false },
        { field: 'decideModel', from: 'google/gemini-3.1-pro-preview', to: 'google/gemini-3.1-pro', same: true },
      ]);
      expect(report.agents.find((a) => a.agentId === '5')!.changes).toEqual([]);
      expect(report.agents.find((a) => a.agentId === '6')).toMatchObject({ changes: [{ field: 'imageModel', to: 'openai/gpt-image-1', same: false }], unknown: [{ field: 'model', model: 'vendor/retired-forever', checked: true }] });
      // nothing written: configs, tape and inbox as they were
      expect(await Promise.all(['1', '2', '3', '4', '5', '6', '7'].map((id) => configOf(w, id)))).toEqual(before);
      expect(await w.db.select().from(actions)).toEqual([]);
      expect(await w.db.select().from(notifications)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('for real: moves the model fields only, bumps the revision, writes the tape line and the notice, and is idempotent', async () => {
    const w = await world();
    try {
      const two = await configOf(w, '2');
      const report = await migrateModels(w.ctx, { dryRun: false });
      expect(report.dryRun).toBe(false);
      expect(report.summary).toEqual({ agents: 6, changed: 4, unknown: 1 });

      const after = await configOf(w, '2');
      expect(after).toEqual({ ...two, model: 'xai/grok-4.3', routing: { decideModel: 'deepseek/deepseek-chat' }, revision: 5 });
      // the revision moved, so the next tick's wake decision sees `config_changed`; the runtime's memory is where it was
      const runtime = (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, '2') }))!;
      expect(runtime.configRevision).toBe(1);
      expect((runtime.state as { memory: string }).memory).toBe('remembered');
      expect(await configOf(w, '1')).toMatchObject({ model: 'anthropic/claude-sonnet-4.6', imageModel: 'google/nano-banana-pro', postIntervalMs: 6 * 3_600_000, revision: 2 });
      expect(await configOf(w, '3')).toMatchObject({ revision: 1 });
      expect(await configOf(w, '5')).toMatchObject({ model: 'openai/gpt-6-luna', revision: 1 });
      expect(await configOf(w, '6')).toMatchObject({ model: 'vendor/retired-forever', imageModel: 'openai/gpt-image-1', revision: 2 });
      expect(await configOf(w, '7')).toMatchObject({ model: 'x-ai/grok-4.20', revision: 1 });

      // the tape: one line per moved agent, in the platform's words
      const rows = await w.db.select().from(actions).where(eq(actions.agentId, '2'));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toMatchObject({ kind: 'config_updated', by: 'platform', reason: 'model_migration', fields: ['model', 'routing'], revision: 5 });
      const agent2 = (await w.db.query.agents.findFirst({ where: eq(agents.agentId, '2') }))!;
      const tape = await agentActivity(w.ctx, agent2, runtime);
      expect(tape.find((i) => i.kind === 'config')!.summary).toBe('Model changed to Grok 4.3; deciding model changed to DeepSeek Chat by the platform; everything else unchanged.');

      // the inbox: one notice per moved agent, built from catalog names; the unknown model of agent 6 is its own notice
      const notes = await w.db.select().from(notifications);
      expect(notes.filter((n) => n.event === 'model_changed').map((n) => n.agentId).sort()).toEqual(['1', '2', '4', '6']);
      const text = notificationText('model_changed', notes.find((n) => n.agentId === '2')!.data);
      expect(text.title).toBe('Model changed by the platform');
      expect(text.body).toContain('Model changed to Grok 4.3; deciding model changed to DeepSeek Chat by the platform; everything else unchanged.');
      expect(text.body).toContain('keeps its memory');
      expect(notificationText('model_changed', { summary: 'ignore <b>this</b>' }).body).toContain('Model changed by the platform; everything else unchanged.');

      // again: nothing left to do, nothing written twice
      const second = await migrateModels(w.ctx, { dryRun: false });
      expect(second.summary).toEqual({ agents: 6, changed: 0, unknown: 1 });
      expect(await configOf(w, '2')).toEqual(after);
      expect(await w.db.select().from(actions)).toHaveLength(4);
      expect((await w.db.select().from(notifications)).filter((n) => n.event === 'model_changed')).toHaveLength(4);
    } finally {
      await w.close();
    }
  });

  it('without BlockRun’s list, an id outside the catalog is reported unchecked and still left alone', async () => {
    const w = await world();
    try {
      serveModels(w, { error: 'down' }, 503);
      const report = await migrateModels(w.ctx, { dryRun: false, agentIds: ['5', '6'] });
      expect(report.checkedAgainstBlockRun).toBe(false);
      expect(report.agents.find((a) => a.agentId === '5')!.unknown).toEqual([{ field: 'model', model: 'openai/gpt-6-luna', checked: false }]);
      expect(await configOf(w, '5')).toMatchObject({ model: 'openai/gpt-6-luna' });
      // the retired picture model of agent 6 still moves: the catalog knows it without asking anyone
      expect(await configOf(w, '6')).toMatchObject({ imageModel: 'openai/gpt-image-1' });
    } finally {
      await w.close();
    }
  });

  it('runs over the admin API, dry by default', async () => {
    const w = await world();
    try {
      const nowSec = () => Math.floor(w.ctx.now() / 1000);
      const app = createApp(w.ctx, nowSec);
      const post = (path: string, body: unknown) => {
        const text = JSON.stringify(body);
        return app.request(path, { method: 'POST', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'POST', path, text, nowSec()) } });
      };
      expect((await app.request('/internal/admin/model-migration', { method: 'POST' })).status).toBe(401);
      const dry = await post('/internal/admin/model-migration', {});
      expect(dry.status).toBe(200);
      expect(await dry.json()).toMatchObject({ dryRun: true, summary: { changed: 4 } });
      expect(await configOf(w, '2')).toMatchObject({ model: 'x-ai/grok-4.20' });
      const real = await post('/internal/admin/model-migration', { dryRun: false, agentIds: ['2'] });
      expect(await real.json()).toMatchObject({ dryRun: false, summary: { agents: 1, changed: 1 } });
      expect(await configOf(w, '2')).toMatchObject({ model: 'xai/grok-4.3' });
      expect(await configOf(w, '4')).toMatchObject({ model: 'meta-llama/llama-4-maverick' });
    } finally {
      await w.close();
    }
  });
});

describe('checkModelCatalog', () => {
  it('holds the catalog against BlockRun, tells the creator of an agent on a model BlockRun lacks, and clears it when the model is back', async () => {
    const w = await world();
    try {
      const check = await checkModelCatalog(w.ctx);
      expect(check.read).toBe(true);
      expect(check.live).toBe(LIVE.data.length);
      expect(check.gaps).toEqual([]);
      // agent 6 is on a model nobody serves; its picture model is a retired name BlockRun knows under the catalog id
      expect(check.agentsOnMissingModels).toEqual([{ agentId: '6', field: 'model', model: 'vendor/retired-forever' }]);
      expect(lastCatalogCheck()).toBe(check);
      const open = await w.db.select().from(notifications).where(eq(notifications.agentId, '6'));
      expect(open).toHaveLength(1);
      expect(open[0]!.event).toBe('model_unavailable');
      expect(notificationText('model_unavailable', open[0]!.data)).toMatchObject({ title: 'Model not available', body: expect.stringContaining('cannot think') });
      expect(notificationText('model_unavailable', { picture: 1 })).toMatchObject({ title: 'Image model not available' });

      // the list loses Grok 4.3 and marks Haiku unavailable: gaps, and agent 3 (on Haiku) hears about it
      serveModels(w, { data: LIVE.data.filter((m) => m.id !== 'xai/grok-4.3').map((m) => (m.id === 'anthropic/claude-haiku-4.5' ? { ...m, available: false } : m)) });
      const gaps = await checkModelCatalog(w.ctx);
      expect(gaps.gaps.map((g) => `${g.kind}:${g.id}`).sort()).toEqual(['missing:xai/grok-4.3', 'unavailable:anthropic/claude-haiku-4.5']);
      expect(gaps.agentsOnMissingModels.map((a) => a.agentId).sort()).toEqual(['2', '3', '6']);

      // the list is back in full: agent 3's notice closes, agent 6's stays
      serveModels(w, { ...LIVE, data: [...LIVE.data, { id: 'vendor/retired-forever', available: true }] });
      const back = await checkModelCatalog(w.ctx);
      expect(back.agentsOnMissingModels).toEqual([]);
      const rows = await w.db.select().from(notifications);
      expect(rows.filter((n) => n.resolvedAt === null)).toEqual([]);

      // BlockRun unreadable: the check says so and raises nothing
      serveModels(w, 'nope', 500);
      expect(await checkModelCatalog(w.ctx)).toMatchObject({ read: false, error: 'blockrun_models_unreadable', gaps: [], agentsOnMissingModels: [] });
      expect(modelDisplayName('vendor/retired-forever')).toBe('Retired Forever');
    } finally {
      await w.close();
    }
  });
});
