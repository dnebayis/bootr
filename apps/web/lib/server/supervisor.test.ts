import { describe, expect, it } from 'vitest';
import { sanitizeActivity, sanitizeConfig, validateChanges } from './supervisor';

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
