/**
 * Own agents, after the security review of the engine (docs/design/byo-agent.md "Limits added after review"): what an
 * uploaded picture may cost the server. Unpacking a picture is the one piece of work whose size the caller chooses and
 * nobody pays for, so it is bounded by the pixels the header states, by time, to one at a time, and per day by the
 * uploads tried, kept or not.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { type ActResult, type OwnErrorBody } from '@bootr/shared/own-agent';
import { images } from '../src/db/schema.js';
import { IMAGE_BUSY, IMAGE_TYPE_REFUSED, MAX_UPLOAD_PIXELS, REENCODE_QUEUE_MAX, imageTooManyPixels, oneAtATime, pictureSize, uploadAttemptsDailyCap } from '../src/own/pictures.js';
import { connectClient, openSocial, ownWorld, seedOwn, type OwnWorld } from './own-helpers.js';

const WITH_IMAGES = { capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: true } };

async function setup(config: Record<string, string> = {}) {
  const w = await ownWorld({ config });
  await seedOwn(w, { config: WITH_IMAGES });
  const { credential } = await connectClient(w);
  const turn = await openSocial(w, credential);
  return { w, credential, turn };
}
const flat = (width: number, height: number, kind: 'png' | 'webp' = 'png') => {
  const base = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } }, limitInputPixels: false });
  return kind === 'png' ? base.png().toBuffer() : base.webp().toBuffer();
};
const upload = (w: OwnWorld, credential: string, turnId: string, bytes: Buffer, n = 0) =>
  w.run<ActResult & OwnErrorBody>('upload', credential, { turnId, mime: 'image/png', dataBase64: bytes.toString('base64'), alt: `A red field on a plain background, number ${n}.`, description: 'A plain red field, the colour of the coin.' });

describe('own agent: what an upload may cost', () => {
  it('a picture over 16 megapixels is refused by its header, however small its file; one just under is stored', async () => {
    const { w, credential, turn } = await setup();
    try {
      expect(MAX_UPLOAD_PIXELS).toBe(16_000_000);
      // 20 megapixels of one colour: a file of a few hundred kilobytes that unpacks to 60 MB of bitmap.
      const huge = await flat(5000, 4000);
      expect(huge.length).toBeLessThan(500_000);
      expect(await pictureSize(huge)).toEqual({ width: 5000, height: 4000 });
      const refused = await upload(w, credential, turn.turnId, huge, 1);
      expect(refused.body).toMatchObject({ status: 'failed', error: imageTooManyPixels(5000, 4000) });
      expect(await w.db.select().from(images)).toHaveLength(0);
      const fits = await upload(w, credential, turn.turnId, await flat(4000, 4000), 2);
      expect(fits.body.status).toBe('completed');
      expect(await w.db.select().from(images)).toHaveLength(1);
    } finally {
      await w.close();
    }
  }, 60_000);

  it('counts the uploads tried in a day, the refused ones too', async () => {
    const { w, credential, turn } = await setup({ OWN_UPLOAD_ATTEMPTS_PER_DAY: '2' });
    try {
      // The eight bytes of a PNG and nothing a decoder can read after them: the type passes, the picture does not.
      const broken = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, n)]);
      expect((await upload(w, credential, turn.turnId, broken(1), 1)).body).toMatchObject({ status: 'failed', error: IMAGE_TYPE_REFUSED });
      expect((await upload(w, credential, turn.turnId, broken(2), 2)).body).toMatchObject({ status: 'failed', error: IMAGE_TYPE_REFUSED });
      // The day's two tries are used: a real picture is not even read.
      const third = await upload(w, credential, turn.turnId, await flat(16, 16), 3);
      expect(third.body).toMatchObject({ status: 'failed', error: uploadAttemptsDailyCap(2) });
      expect(await w.db.select().from(images)).toHaveLength(0);
      // A day on, the count has moved past them.
      w.setNow(w.ctx.now() + 25 * 3_600_000);
      const next = await openSocial(w, credential, { reason: 'creator_asked' });
      expect((await upload(w, credential, next.turnId, await flat(16, 16), 4)).body.status).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('writes one picture at a time: a few wait their turn in order, the rest and the ones that wait too long are told it is busy', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const first = oneAtATime(async () => {
      order.push('first starts');
      await held;
      return 'first';
    });
    const waiting = Array.from({ length: REENCODE_QUEUE_MAX }, (_, i) => oneAtATime(async () => (order.push(`waiter ${i}`), `waiter ${i}`), { waitMs: 5_000 }));
    // The queue is full: the next one is answered at once and its work never starts.
    expect(await oneAtATime(async () => (order.push('overflow'), 'overflow'), { waitMs: 5_000 })).toBe('busy');
    expect(order).toEqual(['first starts']);
    release();
    expect(await first).toBe('first');
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: REENCODE_QUEUE_MAX }, (_, i) => `waiter ${i}`));
    expect(order).toEqual(['first starts', ...Array.from({ length: REENCODE_QUEUE_MAX }, (_, i) => `waiter ${i}`)]);

    // One that waits past its bound gives up, and the slot is free again once the holder is done.
    let releaseAgain!: () => void;
    const heldAgain = new Promise<void>((resolve) => (releaseAgain = resolve));
    const holder = oneAtATime(() => heldAgain);
    expect(await oneAtATime(async () => 'late', { waitMs: 20 })).toBe('busy');
    releaseAgain();
    await holder;
    expect(await oneAtATime(async () => 'free again')).toBe('free again');
    expect(IMAGE_BUSY).toMatch(/^image_busy: /);
  });
});
