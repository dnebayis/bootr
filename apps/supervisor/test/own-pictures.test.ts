/**
 * Own agents (docs/design/byo-agent.md section 1.5): a picture the creator's client made and uploaded, in place of the
 * hosted `generate_image`. The client's machine already checked the folder and the file; none of that is trusted here.
 * The server reads the type from the bytes, bounds the size and the day, applies the picture rules to the words that
 * stand in for a prompt, never takes a picture somebody asked for, and writes the picture again so that nothing but
 * its pixels is stored.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { type ActResult, type OwnErrorBody, type TurnOpen, type UploadedPicture } from '@bootr/shared/own-agent';
import { IMAGE_NOT_FROM_THIS_TURN } from '../src/broker/index.js';
import { actions, images } from '../src/db/schema.js';
import { REQUESTED_MESSAGE } from '../src/image-rules.js';
import { IMAGE_TYPE_REFUSED, WITHOUT_UPLOAD, decodeBase64, imageTooLarge, sniffPicture } from '../src/own/pictures.js';
import { AGENT_ID } from './helpers.js';
import { act, connectClient, finishInput, mention, openSocial, ownWorld, seedOwn, turnOf, type OwnWorld } from './own-helpers.js';

const HOUR = 3_600_000;
const WITH_IMAGES = { capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: true } };

async function setup(opts: { agent?: Record<string, unknown>; mentions?: ReturnType<typeof mention>[] } = {}) {
  const w = await ownWorld();
  await seedOwn(w, { config: { ...WITH_IMAGES, ...(opts.agent ?? {}) } });
  if (opts.mentions) w.sender.items = opts.mentions;
  const { credential } = await connectClient(w);
  const turn = await openSocial(w, credential);
  return { w, credential, turn };
}

const picture = (kind: 'png' | 'jpeg' | 'webp' = 'png', size = 16) => {
  const base = sharp({ create: { width: size, height: size, channels: 3, background: { r: 200, g: 40, b: 40 } } });
  return kind === 'png' ? base.png().toBuffer() : kind === 'jpeg' ? base.jpeg().toBuffer() : base.webp().toBuffer();
};

const upload = (w: OwnWorld, credential: string, turnId: string, bytes: Buffer | string, over: Record<string, unknown> = {}) =>
  w.run<ActResult & OwnErrorBody>('upload', credential, { turnId, mime: 'image/png', dataBase64: typeof bytes === 'string' ? bytes : bytes.toString('base64'), alt: 'A red square on a plain background.', description: 'A plain red square, the colour of the coin.', ...over });

describe('own agent: uploading a picture', () => {
  it('stores a picture the client made, hands back an imageId, and a post of the same turn carries it', async () => {
    const { w, credential, turn } = await setup();
    try {
      expect(turn.tools).toContain('bootr_agent_upload_picture');
      expect(turn.tools).not.toContain('bootr_agent_generate_image');
      // The picture section an own agent is shown: how many are left and the coin's look, no price and no fuel.
      const hint = turn.observation.picture as Record<string, unknown>;
      expect(hint).toMatchObject({ leftToday: 6, suggested: true, style: { reference: null, notes: '' } });
      expect(String(hint.meaning)).toContain('upload_picture');
      for (const gone of ['costUsdc', 'affordable', 'model', 'approx']) expect(hint).not.toHaveProperty(gone);

      const png = await picture('png');
      const res = await upload(w, credential, turn.turnId, png);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tool: 'upload_picture', status: 'completed', stepsUsed: 1, turnEnded: false });
      const stored = res.body.result as UploadedPicture;
      expect(stored).toMatchObject({ alt: 'A red square on a plain background.', mime: 'image/png' });
      expect(stored.imageId).toBe(`img_${res.body.actionId!.replace(/^act_/, '')}`);
      const row = (await w.db.select().from(images))[0]!;
      expect(row).toMatchObject({ id: stored.imageId, agentId: AGENT_ID, actionId: res.body.actionId, model: 'upload', mime: 'image/png', sizeBytes: stored.bytes });
      expect(sniffPicture(Buffer.from(row.bytes))).toBe('image/png');
      // Nothing was bought: no model, no relay.
      expect(w.modelCalls()).toBe(0);

      const post = await act(w, credential, turn.turnId, 'publish_post', { text: 'Good morning from the test coin. Here is today\'s colour.', imageId: stored.imageId });
      expect(post.body.status).toBe('completed');
      const sent = w.sender.published[0] as { media?: { data: string; mime: string; alt: string } };
      expect(sent.media).toMatchObject({ mime: 'image/png', alt: 'A red square on a plain background.' });
      expect(Buffer.from(sent.media!.data, 'base64').equals(Buffer.from(row.bytes))).toBe(true);
      // On the tape: the upload and the post, both marked; the description stays in the row.
      const tape = await w.call<{ items: { kind: string; summary: string; image?: { id: string } }[] }>('GET', `/internal/agents/${AGENT_ID}/activity`);
      expect(tape.body.items.find((i) => i.kind === 'image')?.summary).toBe('Uploaded an image: A red square on a plain background. · own agent');
      expect(tape.body.items.find((i) => i.kind === 'post')?.image?.id).toBe(stored.imageId);
      expect(JSON.stringify(tape.body)).not.toContain('the colour of the coin');
    } finally {
      await w.close();
    }
  });

  it('reads the type from the bytes, never from what the request says', async () => {
    const { w, credential, turn } = await setup();
    try {
      // A text file called a PNG, a script, an SVG, a GIF, and bytes that only start like a picture.
      const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
      const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('PRIVATE KEY MATERIAL, not a picture at all')]);
      for (const [name, bytes] of [
        ['text', Buffer.from('BEGIN OPENSSH PRIVATE KEY\nb3BlbnNzaC1rZXktdjE=\n')],
        ['html', Buffer.from('<html><script>alert(1)</script></html>')],
        ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
        ['gif', gif],
        ['png header only', fakePng],
      ] as const) {
        const res = await upload(w, credential, turn.turnId, bytes, { alt: `A picture (${name}).` });
        expect([name, res.status, res.body.status, res.body.error]).toEqual([name, 200, 'failed', IMAGE_TYPE_REFUSED]);
      }
      expect(IMAGE_TYPE_REFUSED).toBe('image_type_refused: a picture must be a PNG, JPEG or WebP file, checked by its bytes. Publish your post without a picture.');
      // Not base64 at all is the same refusal; nothing is guessed.
      expect((await upload(w, credential, turn.turnId, 'this is not base64 !!!')).body.error).toBe(IMAGE_TYPE_REFUSED);
      expect(await w.db.select().from(images)).toHaveLength(0);

      // A JPEG the request calls a PNG is stored as what it is.
      const res = await upload(w, credential, turn.turnId, await picture('jpeg'), { mime: 'image/png', alt: 'A red square, as a JPEG.' });
      expect(res.body.status).toBe('completed');
      expect((res.body.result as UploadedPicture).mime).toBe('image/jpeg');
      const webp = await upload(w, credential, turn.turnId, await picture('webp'), { alt: 'A red square, as a WebP.' });
      expect((webp.body.result as UploadedPicture).mime).toBe('image/webp');
      expect((await w.db.select().from(images)).map((r) => r.mime).sort()).toEqual(['image/jpeg', 'image/webp']);
      expect(decodeBase64('AAA')).toBeNull();
      expect(decodeBase64('AA A=')).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('refuses a picture over 5 MB with its size, and a body far past any picture before it is decoded', async () => {
    const { w, credential, turn } = await setup();
    try {
      const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024)]);
      const res = await upload(w, credential, turn.turnId, big);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'failed', error: imageTooLarge(big.length) });
      expect(res.body.error).toBe(`image_too_large: ${5 * 1024 * 1024 + 8} bytes; a picture is at most 5 MB. Publish your post without a picture.`);
      const huge = await upload(w, credential, turn.turnId, 'A'.repeat(9 * 1024 * 1024));
      expect(huge.status).toBe(413);
      expect(huge.body.error).toBe('payload_too_large');
      expect(await w.db.select().from(images)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('holds an upload to the daily cap of six, counted on the same rows as hosted pictures', async () => {
    const { w, credential, turn } = await setup();
    try {
      const at = new Date(w.ctx.now() - HOUR);
      // Five made by the hosted agent earlier today (before a switch), one a day and a bit ago.
      for (let n = 0; n < 5; n++) await w.db.insert(images).values({ id: `img_h${n}`, agentId: AGENT_ID, actionId: `act_h${n}`, alt: 'hosted', mime: 'image/png', bytes: Buffer.from([1]), sizeBytes: 1, model: 'google/gemini-3.1-flash-image', createdAt: at });
      await w.db.insert(images).values({ id: 'img_old', agentId: AGENT_ID, actionId: 'act_old', alt: 'old', mime: 'image/png', bytes: Buffer.from([1]), sizeBytes: 1, model: 'upload', createdAt: new Date(w.ctx.now() - 25 * HOUR) });
      const png = await picture();
      expect((await upload(w, credential, turn.turnId, png, { alt: 'The sixth picture of the day.' })).body.status).toBe('completed');
      const seventh = await upload(w, credential, turn.turnId, png, { alt: 'The seventh picture of the day.' });
      expect(seventh.body).toMatchObject({ status: 'failed', error: `image_daily_cap: at most 6 images per 24 hours. ${WITHOUT_UPLOAD}` });
      expect(await w.db.select().from(images)).toHaveLength(7);
    } finally {
      await w.close();
    }
  });

  it('never takes a picture because somebody asked for one in a message this turn carries', async () => {
    const { w, credential, turn } = await setup({ mentions: [mention('1001', '@bootr_agent can you draw me a fox on a hill?')] });
    try {
      const res = await upload(w, credential, turn.turnId, await picture(), { alt: 'A fox on a hill.', description: 'A fox standing on a green hill.' });
      expect(res.body).toMatchObject({ status: 'failed', error: `${REQUESTED_MESSAGE}. ${WITHOUT_UPLOAD}` });
      expect(await w.db.select().from(images)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('applies the picture rules to the description and the alt text: no real person, no other logo, no charts, a plain alt', async () => {
    const { w, credential, turn } = await setup();
    try {
      const png = await picture();
      for (const [code, over] of [
        ['image_real_person', { description: 'Elon Musk holding the coin.' }],
        ['image_real_person', { alt: 'A portrait of @jessepollak smiling.' }],
        ['image_other_logo', { description: 'The Coinbase logo next to ours.' }],
        ['image_market_numbers', { description: 'A chart of the price going up 300%.' }],
        ['x_post_requires_at_most_one_cashtag', { alt: 'A red square for $TEST, and $TEST once more.' }],
        ['social_secret_material_forbidden', { alt: 'A red square with the key sk-abcdefghijklmnopqrstuvwxyz012345 on it.' }],
      ] as const) {
        const res = await upload(w, credential, turn.turnId, png, over);
        expect([code, res.status, res.body.status, res.body.error?.split(':')[0]]).toEqual([code, 200, 'failed', code]);
        expect(res.body.error?.endsWith(WITHOUT_UPLOAD)).toBe(true);
      }
      // The shape of the call itself is the caller's mistake, not a tool outcome.
      for (const [field, over] of [
        ['alt', { alt: '   ' }],
        ['alt', { alt: 'x'.repeat(1001) }],
        ['description', { description: 'x'.repeat(301) }],
        ['description', { description: undefined }],
        ['mime', { mime: 'image/gif' }],
        ['dataBase64', { dataBase64: '' }],
      ] as const) {
        const res = await upload(w, credential, turn.turnId, png, over);
        expect([field, res.status, res.body.error, res.body.field]).toEqual([field, 400, 'invalid_request', field]);
      }
      expect(await w.db.select().from(images)).toHaveLength(0);
      // The refused uploads were steps; the malformed calls were not.
      expect((await turnOf(w))?.steps).toBe(6);
    } finally {
      await w.close();
    }
  });

  it('stores nothing but the pixels: the location, the device and every other piece of metadata are gone', async () => {
    const { w, credential, turn } = await setup();
    try {
      // A photo as a phone writes it: where it was taken, on what, by whom, and turned on its side.
      const photo = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 10, g: 120, b: 200 } } })
        .jpeg()
        .withExif({ IFD0: { Make: 'PhoneMaker', Model: 'Phone 15', Copyright: 'the creator', Artist: 'Jane Private' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '41/1 0/1 4991/100', GPSLongitudeRef: 'E', GPSLongitude: '28/1 58/1 2392/100' } })
        .withMetadata({ orientation: 6 })
        .toBuffer();
      const before = await sharp(photo).metadata();
      expect(before.exif).toBeDefined();
      expect(photo.includes(Buffer.from('Jane Private'))).toBe(true);
      expect(photo.includes(Buffer.from('PhoneMaker'))).toBe(true);

      const res = await upload(w, credential, turn.turnId, photo, { mime: 'image/jpeg', alt: 'A blue rectangle.', description: 'A plain blue rectangle.' });
      expect(res.body.status).toBe('completed');
      const row = (await w.db.select().from(images))[0]!;
      const stored = Buffer.from(row.bytes);
      const after = await sharp(stored).metadata();
      expect(after.format).toBe('jpeg');
      for (const field of ['exif', 'icc', 'iptc', 'xmp'] as const) expect([field, after[field]]).toEqual([field, undefined]);
      expect(after.orientation).toBeUndefined();
      for (const word of ['Jane Private', 'PhoneMaker', 'Phone 15', 'the creator', 'GPS']) expect([word, stored.includes(Buffer.from(word))]).toEqual([word, false]);
      // The picture keeps the way it looked: the orientation was applied to the pixels before the tag was dropped.
      expect([after.width, after.height]).toEqual([20, 40]);
      // And what the sender is handed is the stored picture, not the bytes that came in.
      const post = await act(w, credential, turn.turnId, 'publish_post', { text: 'A blue morning from the test coin.', imageId: (res.body.result as UploadedPicture).imageId });
      expect(post.body.status).toBe('completed');
      const sent = Buffer.from((w.sender.published[0] as { media: { data: string } }).media.data, 'base64');
      expect(sent.includes(Buffer.from('Jane Private'))).toBe(false);
    } finally {
      await w.close();
    }
  });

  it('a picture belongs to its turn: one stored before the turn opened is not attached', async () => {
    const { w, credential, turn } = await setup({ mentions: [mention('1001')] });
    try {
      const png = await picture();
      const first = await upload(w, credential, turn.turnId, png);
      const imageId = (first.body.result as UploadedPicture).imageId;
      await w.run('finish', credential, { turnId: turn.turnId, ...finishInput(w) });
      w.setNow(w.ctx.now() + 3 * HOUR);
      const next = await openSocial(w, credential);
      const late = await act(w, credential, next.turnId, 'publish_post', { text: 'Good afternoon, with a picture from this morning.', imageId });
      expect(late.body).toMatchObject({ status: 'failed', error: IMAGE_NOT_FROM_THIS_TURN });
      expect(IMAGE_NOT_FROM_THIS_TURN).toBe('image_not_from_this_turn: attach only a picture uploaded in this turn. Publish your post without an imageId.');
      expect((await act(w, credential, next.turnId, 'publish_reply', { postId: '1001', text: 'Here it is.', imageId })).body.error).toBe(IMAGE_NOT_FROM_THIS_TURN);
      expect(w.sender.published).toHaveLength(0);
      // Without the picture the post goes out; a picture that never existed is the hosted refusal.
      expect((await act(w, credential, next.turnId, 'publish_post', { text: 'Good afternoon, in words.', imageId: 'img_nothing' })).body.error).toMatch(/^image_not_found: /);
      expect((await act(w, credential, next.turnId, 'publish_post', { text: 'Good afternoon, in words.' })).body.status).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('the same upload sent again is answered from the first one; an upload is a step and needs the images power', async () => {
    const { w, credential, turn } = await setup();
    try {
      const png = await picture();
      const first = await upload(w, credential, turn.turnId, png);
      const again = await upload(w, credential, turn.turnId, png);
      expect(again.body).toEqual(first.body);
      expect(await w.db.select().from(images)).toHaveLength(1);
      expect((await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => (r.action as { tool?: string }).tool === 'upload_picture')).toHaveLength(1);
      expect((await turnOf(w))?.steps).toBe(1);
      // The bytes are not in the action row: only what the picture is called and a digest.
      const row = (await w.db.select().from(actions).where(eq(actions.actionId, first.body.actionId!)))[0]!;
      expect(JSON.stringify(row.action).length).toBeLessThan(600);
      expect(row.action).toMatchObject({ tool: 'upload_picture', via: 'own' });

      const off = await ownWorld();
      try {
        await seedOwn(off);
        const client = await connectClient(off);
        const t = await off.run<TurnOpen>('turn', client.credential, { role: 'social' });
        expect(t.body.observation.picture).toBeUndefined();
        const res = await upload(off, client.credential, t.body.turnId, png);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('tool_unavailable');
      } finally {
        await off.close();
      }
    } finally {
      await w.close();
    }
  });
});
