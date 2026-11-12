/**
 * Own agents (docs/design/byo-agent.md section 1.5): a picture the creator's client made and uploaded, in place of the
 * hosted `generate_image`. Nothing is bought. The MCP server on the creator's machine already refused a file outside
 * the pictures folder or of another kind; none of that is trusted here. The server's own checks, each before anything
 * is stored:
 *   - the bytes decode from standard base64 and are at most `PICTURE_MAX_BYTES`;
 *   - the type is read from the first bytes (PNG, JPEG or WebP, the three the sender accepts), never from what the
 *     request says;
 *   - the description and the alt text pass the picture rules a hosted prompt passes (`imagePromptRisk`);
 *   - nobody asked for a picture in a message this turn carries (`pictureRequested`);
 *   - the daily cap, counted on the same `sv_images` rows as hosted pictures, and a daily count of uploads tried
 *     (`OWN_UPLOAD_ATTEMPTS_PER_DAY`), kept or refused, so that refused ones are bounded too;
 *   - the picture's size in pixels is read from its header and is at most 16 megapixels, before anything is unpacked;
 *   - the picture is decoded and written again by `sharp`, which drops every piece of metadata (a photo from a phone
 *     carries where it was taken) and proves the bytes are a picture at all. The format is kept. One picture is
 *     written at a time in the whole process, each within ten seconds: unpacking is the one piece of work here whose
 *     cost the caller chooses, and nothing is paid for it.
 * Stored in `sv_images` with `model: 'upload'` and the upload's action id. What the picture shows is seen by no code,
 * here or on the hosted path; a creator who wants to see pictures before they go out uses approval mode.
 */
import type { AgentConfig } from '@bootr/agent-core';
import { PICTURE_MAX_BYTES, type PictureMime, type UploadedPicture } from '@bootr/shared/own-agent';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import type SharpModule from 'sharp';
import type { AgentRow, SupervisorContext } from '../context.js';
import { actions, images } from '../db/schema.js';
import { imagePromptRisk, pictureRequested, REQUESTED_MESSAGE } from '../image-rules.js';
import { imagesInWindow, MAX_IMAGES_PER_DAY } from '../images.js';
import { ownSetting } from './registry.js';

export const UPLOAD_MODEL = 'upload';
/** What every refusal of an upload ends with: the post goes out in words. */
export const WITHOUT_UPLOAD = 'Publish your post without a picture.';
export const IMAGE_TYPE_REFUSED = `image_type_refused: a picture must be a PNG, JPEG or WebP file, checked by its bytes. ${WITHOUT_UPLOAD}`;
export function imageTooLarge(bytes: number): string {
  return `image_too_large: ${bytes} bytes; a picture is at most 5 MB. ${WITHOUT_UPLOAD}`;
}
/**
 * Pixels a picture may decode to: a small file that unpacks into a huge bitmap is refused before it is unpacked. X
 * shows nothing larger than 4096 pixels a side, so 16 megapixels is every picture worth posting; 64 megapixels, the
 * first limit, was a quarter of a gigabyte of bitmap per upload.
 */
export const MAX_UPLOAD_PIXELS = 16_000_000;
export function imageTooManyPixels(width: number, height: number): string {
  return `image_too_many_pixels: ${width} x ${height} pixels; a picture is at most 16 megapixels. ${WITHOUT_UPLOAD}`;
}
/** How long one picture may take to be written again before it is given up on. */
export const REENCODE_TIMEOUT_SECONDS = 10;
/** Uploads that may wait for the one that is being written, and for how long each waits. */
export const REENCODE_QUEUE_MAX = 3;
export const REENCODE_WAIT_MS = 8_000;
export const IMAGE_BUSY = `image_busy: other pictures are being stored right now and this one was not; send the same upload again in a few seconds, or go on without it. ${WITHOUT_UPLOAD}`;
export function uploadAttemptsDailyCap(limit: number): string {
  return `image_attempts_daily_cap: at most ${limit} picture uploads may be tried per 24 hours, kept or refused; this one was not read. ${WITHOUT_UPLOAD}`;
}
/** The window of the daily count of uploads tried. */
export const UPLOAD_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A hosted refusal text with the way forward for an upload appended, one full stop between them. */
function withoutUpload(error: string): string {
  return `${error.trim().replace(/\.+$/, '')}. ${WITHOUT_UPLOAD}`;
}

/** The picture type the first bytes say, or null: PNG's eight-byte signature, JPEG's start-of-image marker, a RIFF container that holds WEBP. */
export function sniffPicture(bytes: Uint8Array): PictureMime | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** The bytes of a standard base64 string, or null when it is not one (Node's decoder would skip what it does not know). */
export function decodeBase64(data: unknown): Buffer | null {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  return Buffer.from(data, 'base64');
}

let sharpLoading: Promise<typeof SharpModule> | null = null;

/**
 * `sharp` is a native module, so it is loaded on the first upload and not when this file is: a binary that cannot load
 * then fails that upload (and is tried again on the next one), instead of stopping the supervisor at start and every
 * hosted agent with it. The image build proves the binary loads (apps/supervisor/Dockerfile).
 */
async function loadSharp(): Promise<typeof SharpModule> {
  sharpLoading ??= import('sharp').then((m) => m.default);
  try {
    return await sharpLoading;
  } catch (err) {
    sharpLoading = null;
    throw err;
  }
}

/**
 * The width and height the picture's header states, read without unpacking a pixel; null when the bytes have no
 * header `sharp` can read. An animated WebP states the size of one frame: only its first frame is ever unpacked
 * (`animated: false` below), so the number of frames adds no work and is not a reason to refuse it.
 */
export async function pictureSize(bytes: Buffer): Promise<{ width: number; height: number } | null> {
  // Outside the `try`: a library that cannot load is an error of ours, not "this is not a picture".
  const sharp = await loadSharp();
  try {
    const meta = await sharp(bytes, { failOn: 'error', limitInputPixels: false, animated: false }).metadata();
    const width = meta.width ?? 0;
    const height = meta.pageHeight ?? meta.height ?? 0;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

let encoding = false;
const encodeWaiters: ((granted: boolean) => void)[] = [];

/**
 * Runs `work` when no other picture is being written in this process. At most `maxWaiting` callers wait, each for at
 * most `waitMs`; one that finds the queue full, or waits that long, is answered `busy` and `work` never starts.
 */
export async function oneAtATime<T>(work: () => Promise<T>, opts: { waitMs?: number; maxWaiting?: number } = {}): Promise<T | 'busy'> {
  const waitMs = opts.waitMs ?? REENCODE_WAIT_MS;
  const maxWaiting = opts.maxWaiting ?? REENCODE_QUEUE_MAX;
  if (encoding) {
    if (encodeWaiters.length >= maxWaiting) return 'busy';
    const granted = await new Promise<boolean>((resolve) => {
      const waiter = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        const i = encodeWaiters.indexOf(waiter);
        if (i >= 0) encodeWaiters.splice(i, 1);
        resolve(false);
      }, waitMs);
      encodeWaiters.push(waiter);
    });
    if (!granted) return 'busy';
  }
  encoding = true;
  try {
    return await work();
  } finally {
    // The slot goes straight to the next in line, so a newcomer cannot slip in ahead of it.
    const next = encodeWaiters.shift();
    if (next) next(true);
    else encoding = false;
  }
}

/**
 * The picture written again in its own format with nothing but its pixels: no EXIF (location, device, time), no XMP,
 * no colour profile, no comment. A JPEG's EXIF orientation is applied to the pixels first, so the picture keeps the way
 * it looks. An animated WebP keeps its first frame. Throws when the bytes are not a picture `sharp` can read, or when
 * writing it takes longer than `REENCODE_TIMEOUT_SECONDS`.
 */
export async function reencodePicture(bytes: Buffer, mime: PictureMime): Promise<Buffer> {
  const sharp = await loadSharp();
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_UPLOAD_PIXELS, animated: false }).rotate().timeout({ seconds: REENCODE_TIMEOUT_SECONDS });
  if (mime === 'image/png') return image.png({ compressionLevel: 9 }).toBuffer();
  if (mime === 'image/jpeg') return image.jpeg({ quality: 92 }).toBuffer();
  return image.webp({ quality: 92 }).toBuffer();
}

export type UploadOutcome = { kind: 'completed'; result: UploadedPicture } | { kind: 'failed'; error: string };

export interface UploadInput {
  /** The action id of this upload (`sv_actions`), which keys the stored picture. */
  actionId: string;
  dataBase64: unknown;
  alt: string;
  description: string;
  /** Texts of the messages this turn carries: a picture is never made because somebody asked for one. */
  receivedTexts: Iterable<string>;
}

/**
 * Checks one upload and stores it. Never throws for a bad picture: every refusal is a `failed` outcome in the words the
 * client's model reads. Idempotent on the action id: a picture already stored for it is returned again.
 */
export async function storeUpload(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, input: UploadInput): Promise<UploadOutcome> {
  const log = ctx.log.child({ agentId: agent.agentId, actionId: input.actionId });
  const existing = await ctx.db.query.images.findFirst({ where: eq(images.actionId, input.actionId) });
  if (existing) return { kind: 'completed', result: { imageId: existing.id, alt: existing.alt, mime: existing.mime as PictureMime, bytes: existing.sizeBytes } };
  const refuse = (error: string): UploadOutcome => {
    log.info({ code: error.split(':')[0] }, 'own agent: upload refused');
    return { kind: 'failed', error };
  };

  // Uploads tried in the last 24 hours, whatever became of them: a refused one cost the same work as a kept one.
  const attemptLimit = Math.floor(ownSetting(ctx, 'OWN_UPLOAD_ATTEMPTS_PER_DAY'));
  const [tried] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .where(and(eq(actions.agentId, agent.agentId), gt(actions.createdAt, new Date(ctx.now() - UPLOAD_ATTEMPT_WINDOW_MS)), ne(actions.actionId, input.actionId), sql`${actions.action}->>'tool' = 'upload_picture'`));
  if (Number(tried?.n ?? 0) >= attemptLimit) return refuse(uploadAttemptsDailyCap(attemptLimit));

  const raw = decodeBase64(input.dataBase64);
  if (!raw || raw.length === 0) return refuse(IMAGE_TYPE_REFUSED);
  if (raw.length > PICTURE_MAX_BYTES) return refuse(imageTooLarge(raw.length));
  const mime = sniffPicture(raw);
  if (!mime) return refuse(IMAGE_TYPE_REFUSED);

  // The hard rules of a hosted picture, on the words that stand in for its prompt: the description and the alt text.
  const own = config.token;
  const risk = imagePromptRisk({ prompt: input.description, altText: input.alt }, { platform: config.platform === true, ownNames: [own.name, own.symbol].filter((n) => typeof n === 'string' && n.length > 0) });
  if (risk) return refuse(withoutUpload(risk.message));
  if (pictureRequested(input.receivedTexts)) return refuse(withoutUpload(REQUESTED_MESSAGE));
  if ((await imagesInWindow(ctx, agent.agentId)) >= MAX_IMAGES_PER_DAY) return refuse(withoutUpload(`image_daily_cap: at most ${MAX_IMAGES_PER_DAY} images per 24 hours`));

  // The header first: how large the picture would unpack is known before a pixel is unpacked.
  const size = await pictureSize(raw);
  if (!size) return refuse(IMAGE_TYPE_REFUSED);
  if (size.width * size.height > MAX_UPLOAD_PIXELS) return refuse(imageTooManyPixels(size.width, size.height));

  let clean: Buffer | 'busy';
  try {
    clean = await oneAtATime(() => reencodePicture(raw, mime));
  } catch (err) {
    log.info({ err: err instanceof Error ? err.message.slice(0, 200) : String(err) }, 'own agent: the uploaded bytes could not be read as a picture');
    return refuse(IMAGE_TYPE_REFUSED);
  }
  if (clean === 'busy') return refuse(IMAGE_BUSY);
  // Writing a picture again can make it larger than it came; the sender's limit is on what is stored.
  if (clean.length > PICTURE_MAX_BYTES) return refuse(imageTooLarge(clean.length));
  if (sniffPicture(clean) !== mime) return refuse(IMAGE_TYPE_REFUSED);

  const id = `img_${input.actionId.replace(/^act_/, '')}`;
  await ctx.db
    .insert(images)
    .values({ id, agentId: agent.agentId, actionId: input.actionId, alt: input.alt, mime, bytes: clean, sizeBytes: clean.length, model: UPLOAD_MODEL, createdAt: new Date(ctx.now()) })
    .onConflictDoNothing();
  log.info({ imageId: id, mime, bytes: clean.length, receivedBytes: raw.length }, 'own agent: picture uploaded');
  return { kind: 'completed', result: { imageId: id, alt: input.alt, mime, bytes: clean.length } };
}
