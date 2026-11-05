/**
 * `generate_image`: one paid picture through the relay (OpenRouter chat completions with
 * `modalities: ["image", "text"]`), paid from the agent's spender exactly like a thought (`relayRequest`, keyed by
 * the action id so a retry never pays twice), decoded from the base64 data URL OpenRouter returns in
 * `message.images[]` and stored inline in `sv_images`. The model gets back an `imageId` it can pass to
 * `publish_post` / `publish_reply`; the broker then hands the bytes to the sender for the X media upload.
 *
 * Every picture looks like the agent's own coin: the config's `imageStyle.reference` (the coin image by default,
 * see onboarding.ts) travels with the prompt as an `image_url` part and the model is told to match its style and
 * palette without copying it; `imageStyle.notes` are the creator's words on top ("flat colours, no text").
 */
import { imageStyleSchema, maxQuoteFor, type AgentConfig, type ImageStyle, type PendingAction, type ToolInput } from '@bootr/agent-core';
import { and, count, eq, gte } from 'drizzle-orm';
import type { AgentRow, SupervisorContext } from './context.js';
import { images } from './db/schema.js';
import { relayRequest } from './inference.js';

/** Relay id of the image model when the agent config names none (`config.imageModel`): Nano Banana Pro. */
export const DEFAULT_IMAGE_MODEL = 'google/gemini-3-pro-image';
export const NO_IMAGE_STYLE: ImageStyle = { reference: null, notes: '' };
/** Pictures one agent may make per rolling day, so a runaway agent cannot drain its fuel on images. */
export const MAX_IMAGES_PER_DAY = 6;
export const IMAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** X accepts photos up to 5 MB; anything larger is refused before it is stored. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Text tokens allowed next to the picture (the relay prices the image itself separately). */
export const IMAGE_TEXT_TOKENS = 256;
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export interface StoredImage {
  id: string;
  alt: string;
  mime: ImageMime;
  bytes: Buffer;
}

/** The image model in force for a parsed or raw stored config. */
export function imageModelOf(config: { imageModel?: unknown }): string {
  return typeof config.imageModel === 'string' && config.imageModel ? config.imageModel : DEFAULT_IMAGE_MODEL;
}

/** The image style in force for a parsed or raw stored config (no reference, no notes when unset or malformed). */
export function imageStyleOf(config: { imageStyle?: unknown }): ImageStyle {
  const parsed = imageStyleSchema.safeParse(config.imageStyle ?? {});
  return parsed.success ? parsed.data : { ...NO_IMAGE_STYLE };
}

const ILLUSTRATOR = 'You are an illustrator. Produce exactly one image for the request. No text in the image unless the request asks for it.';
const MATCH_REFERENCE =
  'A reference picture is attached: it is the look of this account. Match its visual style, palette, mood and level of detail so the new image reads as part of the same set. Do not copy, trace or reproduce the reference, its composition or any text in it; make a new picture for the request.';

/**
 * The relay request for one picture: the prompt and what the picture must convey (its alt text), with the style
 * reference attached as an `image_url` part and the creator's notes in the instructions.
 */
export function imageRequest(model: string, input: ToolInput<'generate_image'>, style: ImageStyle = NO_IMAGE_STYLE): Record<string, unknown> {
  const system = [ILLUSTRATOR, style.reference ? MATCH_REFERENCE : '', style.notes ? `Style notes from the creator: ${style.notes}` : ''].filter(Boolean).join('\n');
  const text = `${input.prompt}\n\nThe image will be described as: ${input.altText}`;
  return {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: style.reference ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: style.reference } }] : text },
    ],
    modalities: ['image', 'text'],
    max_tokens: IMAGE_TEXT_TOKENS,
    stream: false,
  };
}

export type ParsedImage = { ok: true; mime: ImageMime; bytes: Buffer } | { ok: false; error: string };

/** The first image of an OpenRouter completion (`choices[0].message.images[].image_url.url`, a base64 data URL). */
export function parseImageResponse(body: Record<string, unknown>): ParsedImage {
  const choice = (body.choices as { message?: Record<string, unknown> }[] | undefined)?.[0];
  const msg = choice?.message ?? {};
  const list = (msg.images as { image_url?: { url?: unknown } }[] | undefined) ?? [];
  const url = list.map((i) => i?.image_url?.url).find((u): u is string => typeof u === 'string');
  if (!url) {
    const text = typeof msg.content === 'string' ? msg.content.trim().slice(0, 200) : '';
    return { ok: false, error: `image_not_generated${text ? `: ${text}` : ''}` };
  }
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)(;[^,]*)?,(.*)$/is.exec(url);
  if (!m) return { ok: false, error: 'image_unreadable: not a data URL' };
  const mime = m[1]!.toLowerCase() as ImageMime;
  if (!(IMAGE_MIMES as readonly string[]).includes(mime)) return { ok: false, error: `image_unreadable: unsupported type ${mime}` };
  if (!/;base64/i.test(m[2] ?? '')) return { ok: false, error: 'image_unreadable: not base64' };
  const bytes = Buffer.from(m[3]!, 'base64');
  if (bytes.length === 0) return { ok: false, error: 'image_unreadable: empty' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `image_too_large: ${bytes.length} bytes` };
  return { ok: true, mime, bytes };
}

export async function imagesInWindow(ctx: SupervisorContext, agentId: string): Promise<number> {
  const since = new Date(ctx.now() - IMAGE_WINDOW_MS);
  const [row] = await ctx.db.select({ n: count() }).from(images).where(and(eq(images.agentId, agentId), gte(images.createdAt, since)));
  return row?.n ?? 0;
}

export type GenerateImageOutcome = { kind: 'completed'; result: { imageId: string; alt: string; mime: string; bytes: number } } | { kind: 'failed'; error: string } | { kind: 'unknown'; error: string };

/**
 * Executes `generate_image` for a bound action. Idempotent per `pending.id`: an image already stored for the
 * action is returned again, and the relay call is keyed by the action so an interrupted attempt is reconciled,
 * never re-bought. The daily cap counts stored images (paid, successful ones).
 */
export async function generateImage(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, pending: PendingAction, input: ToolInput<'generate_image'>, cycle = 0): Promise<GenerateImageOutcome> {
  const existing = await ctx.db.query.images.findFirst({ where: eq(images.actionId, pending.id) });
  if (existing) return { kind: 'completed', result: { imageId: existing.id, alt: existing.alt, mime: existing.mime, bytes: existing.sizeBytes } };

  const made = await imagesInWindow(ctx, agent.agentId);
  if (made >= MAX_IMAGES_PER_DAY) return { kind: 'failed', error: `image_daily_cap: at most ${MAX_IMAGES_PER_DAY} images per 24 hours` };

  const model = imageModelOf(config);
  const res = await relayRequest(ctx, agent, { key: `image:${pending.id}`, cycle, request: imageRequest(model, input, imageStyleOf(config)), maxQuoteMicroUsdc: BigInt(maxQuoteFor(model)) });
  // A credit is resumed like an unknown outcome: the same action, so the same key and no second payment.
  if (res.kind === 'unknown' || res.kind === 'credit') return { kind: 'unknown', error: res.error };
  if (res.kind === 'failed') return { kind: 'failed', error: `image_failed: ${res.error}` };

  const parsed = parseImageResponse(res.body);
  if (!parsed.ok) return { kind: 'failed', error: parsed.error };
  const id = `img_${pending.id.replace(/^act_/, '')}`;
  await ctx.db
    .insert(images)
    .values({ id, agentId: agent.agentId, actionId: pending.id, alt: input.altText, mime: parsed.mime, bytes: parsed.bytes, sizeBytes: parsed.bytes.length, model, createdAt: new Date(ctx.now()) })
    .onConflictDoNothing();
  ctx.log.info({ agentId: agent.agentId, imageId: id, model, bytes: parsed.bytes.length, replayed: res.replayed }, 'image generated');
  return { kind: 'completed', result: { imageId: id, alt: input.altText, mime: parsed.mime, bytes: parsed.bytes.length } };
}

/** An agent's own stored image, or null (another agent's image is invisible). */
export async function loadImage(ctx: SupervisorContext, agentId: string, imageId: string): Promise<StoredImage | null> {
  const row = await ctx.db.query.images.findFirst({ where: and(eq(images.id, imageId), eq(images.agentId, agentId)) });
  if (!row) return null;
  return { id: row.id, alt: row.alt, mime: row.mime as ImageMime, bytes: Buffer.from(row.bytes) };
}

/** The `media` field of the sender's publish body for a stored image (bytes as base64 over the HMAC channel). */
export function mediaFor(image: StoredImage): { data: string; mime: string; alt: string } {
  return { data: image.bytes.toString('base64'), mime: image.mime, alt: image.alt };
}
