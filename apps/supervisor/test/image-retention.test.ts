import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, images as imagesTable, inference as inferenceTable } from '../src/db/schema.js';
import { IMAGE_RETENTION_MS, RESPONSE_RETENTION_MS, SWEEP_EVERY_MS, SWEPT_RESPONSE, resetImageSweep, sweepImages } from '../src/image-retention.js';
import { DEFAULT_COIN_IMAGE_MODEL, parseImageResponse } from '../src/images.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const H = 3_600_000;
const D = 24 * H;

async function imageRow(w: TestWorld, id: string, ageMs: number) {
  const at = new Date(w.ctx.now() - ageMs);
  await w.db.insert(imagesTable).values({ id, agentId: AGENT_ID, actionId: `act_${id}`, alt: `alt ${id}`, mime: 'image/png', bytes: PNG_BYTES, sizeBytes: PNG_BYTES.length, model: DEFAULT_COIN_IMAGE_MODEL, createdAt: at });
}

async function inferenceRow(w: TestWorld, key: string, ageMs: number, over: { status?: 'succeeded' | 'failed'; response?: Record<string, unknown> | null } = {}) {
  const at = new Date(w.ctx.now() - ageMs);
  const response = over.response === undefined ? { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,AAAA' } }] } }] } : over.response;
  await w.db.insert(inferenceTable).values({ idempotencyKey: key, agentId: AGENT_ID, cycle: 1, requestHash: 'h', request: { model: DEFAULT_COIN_IMAGE_MODEL, modalities: ['image', 'text'] }, status: over.status ?? 'succeeded', response, receipt: { payment: { x: 1 }, relay: { chargedMicroUsdc: '80000' } }, createdAt: at, updatedAt: at });
}

describe('image retention', () => {
  it('empties day-old relay answers of image calls, keeps their rows and receipts, and leaves thoughts alone', async () => {
    const w = await makeWorld();
    try {
      await inferenceRow(w, 'image:act_old', 2 * D);
      await inferenceRow(w, 'image:act_oldfailed', 2 * D, { status: 'failed', response: { choices: [{ message: { content: 'no' } }] } });
      await inferenceRow(w, 'image:act_fresh', H);
      await inferenceRow(w, 'inference:thought', 2 * D, { response: { choices: [{ message: { content: 'a thought' } }] } });
      const report = await sweepImages(w.ctx, { force: true });
      expect(report).toEqual({ responsesEmptied: 2, imagesDeleted: 0 });
      const rows = Object.fromEntries((await w.db.select().from(inferenceTable)).map((r) => [r.idempotencyKey, r]));
      expect(rows['image:act_old']!.response).toEqual(SWEPT_RESPONSE);
      expect(rows['image:act_oldfailed']!.response).toEqual(SWEPT_RESPONSE);
      expect(rows['image:act_fresh']!.response).toMatchObject({ choices: expect.any(Array) });
      expect((rows['image:act_fresh']!.response as { choices: unknown[] }).choices).toHaveLength(1);
      expect(rows['inference:thought']!.response).toEqual({ choices: [{ message: { content: 'a thought' } }] });
      // the receipt, status and charge stay: metering and the daily cap count rows
      expect(rows['image:act_old']).toMatchObject({ status: 'succeeded', receipt: { payment: { x: 1 }, relay: { chargedMicroUsdc: '80000' } } });
      // a replay that reaches a swept row finds no picture, never a half one
      expect(parseImageResponse(SWEPT_RESPONSE as unknown as Record<string, unknown>)).toMatchObject({ ok: false, error: expect.stringMatching(/^image_not_generated/) });
      // a second sweep has nothing to do
      expect(await sweepImages(w.ctx, { force: true })).toEqual({ responsesEmptied: 0, imagesDeleted: 0 });
    } finally {
      await w.close();
    }
  });

  it('deletes month-old pictures unless a pending review item still refers to them', async () => {
    const w = await makeWorld();
    try {
      await imageRow(w, 'img_ancient', IMAGE_RETENTION_MS + D);
      await imageRow(w, 'img_pending', IMAGE_RETENTION_MS + D);
      await imageRow(w, 'img_rejected', IMAGE_RETENTION_MS + D);
      await imageRow(w, 'img_recent', 2 * D);
      const at = new Date(w.ctx.now() - IMAGE_RETENTION_MS - D);
      await w.db.insert(approvals).values({ id: 'act_q1', agentId: AGENT_ID, kind: 'post', text: 'a', textHash: 'h1', imageId: 'img_pending', status: 'pending_approval', createdAt: at });
      await w.db.insert(approvals).values({ id: 'act_q2', agentId: AGENT_ID, kind: 'post', text: 'b', textHash: 'h2', imageId: 'img_rejected', status: 'rejected', createdAt: at });
      const report = await sweepImages(w.ctx, { force: true });
      expect(report).toEqual({ responsesEmptied: 0, imagesDeleted: 2 });
      const left = (await w.db.select({ id: imagesTable.id }).from(imagesTable)).map((r) => r.id).sort();
      expect(left).toEqual(['img_pending', 'img_recent']);
    } finally {
      await w.close();
    }
  });

  it('runs from the tick at most once an hour', async () => {
    const start = Date.parse('2026-10-24T12:00:00Z');
    const w = await makeWorld({ script: [finishResponse(start + 3 * H)] });
    try {
      await seedAgent(w);
      await inferenceRow(w, 'image:act_old', 2 * D);
      await tick(w.ctx);
      expect((await w.db.select().from(inferenceTable).where(eq(inferenceTable.idempotencyKey, 'image:act_old')))[0]!.response).toEqual(SWEPT_RESPONSE);
      // within the hour the sweep is skipped: a new old row waits
      await inferenceRow(w, 'image:act_old2', 2 * D);
      w.setNow(start + SWEEP_EVERY_MS / 2);
      expect(await sweepImages(w.ctx)).toEqual({ responsesEmptied: 0, imagesDeleted: 0 });
      expect((await w.db.select().from(inferenceTable).where(eq(inferenceTable.idempotencyKey, 'image:act_old2')))[0]!.response).not.toEqual(SWEPT_RESPONSE);
      w.setNow(start + SWEEP_EVERY_MS + 1);
      expect(await sweepImages(w.ctx)).toEqual({ responsesEmptied: 1, imagesDeleted: 0 });
      resetImageSweep(w.ctx.config);
      expect(await sweepImages(w.ctx)).toEqual({ responsesEmptied: 0, imagesDeleted: 0 });
      expect(RESPONSE_RETENTION_MS).toBeLessThan(IMAGE_RETENTION_MS);
    } finally {
      await w.close();
    }
  });
});
