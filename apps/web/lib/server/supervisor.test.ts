import { describe, expect, it } from 'vitest';
import { sanitizeActivity, sanitizeApproval, sanitizeApprovals, sanitizeConfig, sanitizeFuel, validateChanges } from './supervisor';

const KERNEL = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';

describe('validateChanges', () => {
  it('keeps instructions, model and worker fields inside bounds and drops unknown keys', () => {
    const r = validateChanges({
      instructions: '  A patient onchain analyst for small Base coins.​ ',
      model: 'anthropic/claude-haiku-4.5',
      worker: { capabilities: { research: true, images: false, memory: true }, postIntervalMs: 2 * 3600_000, jobLines: ['  watch   the pool ', ''] },
      extra: 1,
    });
    expect(r).toEqual({
      ok: true,
      changes: {
        instructions: 'A patient onchain analyst for small Base coins.',
        model: 'anthropic/claude-haiku-4.5',
        worker: { capabilities: { research: true, images: false, memory: true }, postIntervalMs: 7_200_000, jobLines: ['watch the pool'] },
      },
    });
  });

  it('refuses short instructions, an out-of-range cadence, switching an always-on power off and an empty change', () => {
    expect(validateChanges({ instructions: 'too short' })).toMatchObject({ ok: false });
    expect(validateChanges({ worker: { postIntervalMs: 60_000 } })).toMatchObject({ ok: false });
    expect(validateChanges({ worker: { capabilities: { treasury: false } } })).toMatchObject({ ok: false, message: 'treasury is always on.' });
    expect(validateChanges({ model: 'not a model id!' })).toMatchObject({ ok: false });
    expect(validateChanges({})).toMatchObject({ ok: false });
    expect(validateChanges(null)).toMatchObject({ ok: false });
  });

  it('takes the post review switch as a boolean only', () => {
    expect(validateChanges({ requireApproval: true })).toEqual({ ok: true, changes: { requireApproval: true } });
    expect(validateChanges({ requireApproval: 'yes' })).toMatchObject({ ok: false });
  });

  it('takes economy mode as routing.decideModel: a model id to switch it on, null to switch it off', () => {
    expect(validateChanges({ routing: { decideModel: 'deepseek/deepseek-v3.2' } })).toEqual({ ok: true, changes: { routing: { decideModel: 'deepseek/deepseek-v3.2' } } });
    expect(validateChanges({ routing: { decideModel: null } })).toEqual({ ok: true, changes: { routing: { decideModel: null } } });
    expect(validateChanges({ routing: { decideModel: '' } })).toMatchObject({ ok: false });
    expect(validateChanges({ routing: { decideModel: 'not a model id!' } })).toMatchObject({ ok: false });
    expect(validateChanges({ routing: {} })).toMatchObject({ ok: false });
    expect(validateChanges({ routing: 'deepseek' })).toMatchObject({ ok: false });
    expect(validateChanges({ routing: null })).toMatchObject({ ok: false });
  });
});

describe('sanitizeConfig', () => {
  it('normalises a supervisor config and forces the always-on powers', () => {
    const cfg = sanitizeConfig({
      agentId: 42,
      kernel: KERNEL,
      creator: CREATOR,
      model: 'openai/gpt-4.1-mini',
      instructions: 'hello',
      worker: { kind: 'custom', capabilities: { xRead: true, memory: false }, postIntervalMs: '3600000', jobLines: ['a', 1] },
      workerHash: `0x${'ab'.repeat(32)}`,
      revision: '3',
      updatedAt: 1_700_000_000,
    });
    expect(cfg).toMatchObject({ agentId: '42', model: 'openai/gpt-4.1-mini', revision: 3, worker: { kind: 'custom', postIntervalMs: 3_600_000, jobLines: ['a'] } });
    expect(cfg!.worker.capabilities).toEqual({ xRead: true, xReply: false, xPublish: false, research: false, memory: true, treasury: true, images: false });
    expect(cfg!.updatedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(cfg!.requireApproval).toBe(false);
    expect(cfg!.routing).toEqual({ decideModel: null });
    expect(sanitizeConfig({ agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 }, requireApproval: true })!.requireApproval).toBe(true);
    const minimal = { agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 } };
    expect(sanitizeConfig({ ...minimal, routing: { decideModel: 'deepseek/deepseek-v3.2' } })!.routing).toEqual({ decideModel: 'deepseek/deepseek-v3.2' });
    expect(sanitizeConfig({ ...minimal, routing: { decideModel: 'bad id!' } })!.routing).toEqual({ decideModel: null });
    expect(sanitizeConfig({ ...minimal, routing: 'x' })!.routing).toEqual({ decideModel: null });
  });

  it('returns null without a kernel, creator or worker', () => {
    expect(sanitizeConfig({ agentId: '1', kernel: KERNEL })).toBeNull();
    expect(sanitizeConfig(null)).toBeNull();
  });
});

describe('sanitizeActivity', () => {
  it('keeps well-formed rows, https links and tx hashes only', () => {
    const a = sanitizeActivity({
      items: [
        { at: '2026-11-03T10:00:00.000Z', kind: 'post', summary: 'Posted', url: 'https://x.com/a/status/1' },
        { at: '2026-11-03T09:00:00.000Z', kind: 'fee_claim', summary: 'Claimed', txHash: `0x${'cd'.repeat(32)}`, url: 'javascript:alert(1)' },
        { at: 'nope', kind: 'sleep', summary: 'Sleeping' },
        { at: '2026-11-03T08:00:00.000Z', kind: 'wake' },
      ],
    });
    expect(a.items).toEqual([
      { at: '2026-11-03T10:00:00.000Z', kind: 'post', summary: 'Posted', url: 'https://x.com/a/status/1' },
      { at: '2026-11-03T09:00:00.000Z', kind: 'fee_claim', summary: 'Claimed', txHash: `0x${'cd'.repeat(32)}` },
    ]);
  });
});

describe('sanitizeFuel', () => {
  it('keeps well-formed per-model rows and defaults the window', () => {
    const f = sanitizeFuel({
      days: 7,
      since: '2026-10-28T12:00:00.000Z',
      byModel: [
        { model: 'deepseek/deepseek-v3.2', thoughts: 31, chargedMicroUsdc: '34100' },
        { model: 'anthropic/claude-haiku-4.5', thoughts: 7, chargedMicroUsdc: 65800 },
        { model: 'bad id!', thoughts: 1, chargedMicroUsdc: '1' },
        { model: 'x/y', thoughts: 1.5, chargedMicroUsdc: '1' },
        { model: 'x/y', thoughts: 1, chargedMicroUsdc: '-1' },
      ],
    });
    expect(f).toEqual({
      days: 7,
      since: '2026-10-28T12:00:00.000Z',
      byModel: [
        { model: 'deepseek/deepseek-v3.2', thoughts: 31, chargedMicroUsdc: '34100' },
        { model: 'anthropic/claude-haiku-4.5', thoughts: 7, chargedMicroUsdc: '65800' },
      ],
    });
    expect(sanitizeFuel(null)).toEqual({ days: 7, since: '1970-01-01T00:00:00.000Z', byModel: [] });
  });
});

describe('sanitizeApprovals', () => {
  const PNG = 'iVBORw0KGgo=';
  it('keeps well-formed items, turns image bytes into a data URL and counts the pending ones', () => {
    const a = sanitizeApprovals({
      items: [
        { id: 'act_1', agentId: '7', kind: 'post', text: 'A fox for you all.', inReplyTo: null, image: { id: 'img_1', alt: 'A fox', mime: 'image/png', data: PNG }, status: 'pending_approval', decision: null, decidedBy: null, note: null, postId: null, url: null, createdAt: '2026-11-03T10:00:00.000Z', decidedAt: null, expiresAt: '2026-11-05T10:00:00.000Z' },
        { id: 'act_2', kind: 'reply', text: 'Done.', inReplyTo: '1001', image: { alt: 'x', mime: 'text/html', data: '<b>' }, status: 'approved', decision: 'approve', decidedBy: CREATOR, note: 'ok', url: 'https://x.com/a/status/9', createdAt: '2026-11-03T09:00:00.000Z', decidedAt: '2026-11-03T09:30:00.000Z' },
        { id: 'act_3', kind: 'post', text: 'bad', status: 'wat', createdAt: '2026-11-03T08:00:00.000Z' },
        { id: 'act_4', kind: 'post', text: 'no date', status: 'rejected' },
      ],
      pending: '1',
    });
    expect(a.pending).toBe(1);
    expect(a.items.map((i) => i.id)).toEqual(['act_1', 'act_2']);
    expect(a.items[0]).toMatchObject({ kind: 'post', status: 'pending_approval', image: { alt: 'A fox', dataUrl: `data:image/png;base64,${PNG}` }, expiresAt: '2026-11-05T10:00:00.000Z' });
    expect(a.items[1]).toMatchObject({ kind: 'reply', inReplyTo: '1001', image: { alt: 'x' }, decision: 'approve', url: 'https://x.com/a/status/9', decidedAt: '2026-11-03T09:30:00.000Z' });
    expect(a.items[1]!.image!.dataUrl).toBeUndefined();
    expect(a.items[1]!.expiresAt).toBe('2026-11-05T09:00:00.000Z');
    expect(sanitizeApproval(null)).toBeNull();
    expect(sanitizeApprovals(null)).toEqual({ items: [], pending: 0 });
  });
});
