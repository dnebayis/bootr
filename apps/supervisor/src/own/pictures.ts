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
 *   - the daily cap, counted on the same `sv_images` rows as hosted pictures;
 *   - the picture is decoded and written again by `sharp`, which drops every piece of metadata (a photo from a phone
 *     carries where it was taken) and proves the bytes are a picture at all. The format is kept.
 * Stored in `sv_images` with `model: 'upload'` and the upload's action id. What the picture shows is seen by no code,
 * here or on the hosted path; a creator who wants to see pictures before they go out uses approval mode.
 */
import type { AgentConfig } from '@bootr/agent-core';
import { PICTURE_MAX_BYTES, type PictureMime, type UploadedPicture } from '@bootr/shared/own-agent';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { AgentRow, SupervisorContext } from '../context.js';
import { images } from '../db/schema.js';
import { imagePromptRisk, pictureRequested, REQUESTED_MESSAGE } from '../image-rules.js';
import { imagesInWindow, MAX_IMAGES_PER_DAY } from '../images.js';

export const UPLOAD_MODEL = 'upload';
/** What every refusal of an upload ends with: the post goes out in words. */
export const WITHOUT_UPLOAD = 'Publish your post without a picture.';
export const IMAGE_TYPE_REFUSED = `image_type_refused: a picture must be a PNG, JPEG or WebP file, checked by its bytes. ${WITHOUT_UPLOAD}`;
export function imageTooLarge(bytes: number): string {
  return `image_too_large: ${bytes} bytes; a picture is at most 5 MB. ${WITHOUT_UPLOAD}`;
}
/** Pixels a picture may decode to: a small file that unpacks into a huge bitmap is refused before it is unpacked. */
export const MAX_UPLOAD_PIXELS = 64_000_000;

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

/**
 * The picture written again in its own format with nothing but its pixels: no EXIF (location, device, time), no XMP,
 * no colour profile, no comment. A JPEG's EXIF orientation is applied to the pixels first, so the picture keeps the way
 * it looks. An animated WebP keeps its first frame. Throws when the bytes are not a picture `sharp` can read.
 */
export async function reencodePicture(bytes: Buffer, mime: PictureMime): Promise<Buffer> {
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_UPLOAD_PIXELS, animated: false }).rotate();
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

  let clean: Buffer;
  try {
    clean = await reencodePicture(raw, mime);
  } catch (err) {
    log.info({ err: err instanceof Error ? err.message.slice(0, 200) : String(err) }, 'own agent: the uploaded bytes could not be read as a picture');
    return refuse(IMAGE_TYPE_REFUSED);
  }
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
