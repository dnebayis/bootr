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
 *
 * Before any money moves, in this order, each free: the hard rules on the prompt and alt text (image-rules.ts), the
 * "never on request" rule against the messages received this turn, the daily cap, and the fuel check (a picture must
 * leave the agent its thoughts, fuel.ts). Every failure is logged with its reason, without the picture bytes, so an
 * operator sees in the log why a picture did not happen; the model gets the same reason and what to do instead.
 */
import { DEFAULT_COIN_IMAGE_MODEL as CATALOG_COIN_IMAGE_MODEL, DEFAULT_PLATFORM_IMAGE_MODEL, imageStyleSchema, maxQuoteFor, relayModelId, type AgentConfig, type ImageStyle, type PendingAction, type ToolInput } from '@bootr/agent-core';
import { and, count, desc, eq, gte, like, ne, sql } from 'drizzle-orm';
import type { AgentRow, SupervisorContext } from './context.js';
import { images, inference } from './db/schema.js';
import { pictureFuelCheck } from './fuel.js';
import { imageTokensPerImage, picturePriceFor, relayImageCatalog } from './image-models.js';
import { imagePromptRisk, pictureRequested, REQUESTED_MESSAGE } from './image-rules.js';
import { relayRequest } from './inference.js';

/** The platform agent's image model when its config names none (`config.imageModel`): Nano Banana Pro, by its catalog id. */
export const DEFAULT_IMAGE_MODEL = DEFAULT_PLATFORM_IMAGE_MODEL;
/** A coin agent's image model when its config names none: Nano Banana 2 (the relay knows it as `google/gemini-3.1-flash-image`). */
export const DEFAULT_COIN_IMAGE_MODEL = CATALOG_COIN_IMAGE_MODEL;
export const NO_IMAGE_STYLE: ImageStyle = { reference: null, notes: '' };
/** Pictures one agent may make per rolling day, so a runaway agent cannot drain its fuel on images. */
export const MAX_IMAGES_PER_DAY = 6;
export const IMAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** X accepts photos up to 5 MB; anything larger is refused before it is stored. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * Text tokens allowed next to the picture, on top of the picture's own output tokens. OpenRouter counts a generated
 * picture as completion tokens (`usage.completion_tokens_details.image_tokens`: 1120 for a 1K Gemini 3 picture, 1290
 * for Gemini 2.5 Flash Image, up to 4160 for a GPT image at high quality), so `max_tokens` must hold the picture and
 * the words. A ceiling of 256 (what this sent until 2026-11-08) cannot contain a 1120-token picture; a model boxed in
 * that way answers with text or nothing, paid, and the step fails as `image_not_generated`.
 */
export const IMAGE_TEXT_TOKENS = 1024;
/**
 * Output tokens one picture is billed as, per relay model id, for when the relay's own listing is not at hand
 * (`image_output_tokens_per_image` in `GET /v1/models`, apps/inference/src/pricing.ts). The largest known value is
 * the fallback for an unlisted model, so `max_tokens` never undershoots a picture.
 */
export const IMAGE_TOKENS_PER_IMAGE: Readonly<Record<string, number>> = {
  'google/gemini-2.5-flash-image': 1290,
  'google/gemini-3.1-flash-image': 1120,
  'google/gemini-3-pro-image': 1120,
  'openai/gpt-5-image-mini': 4160,
  'openai/gpt-5.4-image-2': 4160,
};
export const MAX_KNOWN_IMAGE_TOKENS = Math.max(...Object.values(IMAGE_TOKENS_PER_IMAGE));
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

export interface StoredImage {
  id: string;
  alt: string;
  mime: ImageMime;
  bytes: Buffer;
}

/**
 * The image model in force for a parsed or raw stored config: the creator's choice, else the platform agent's default
 * (Nano Banana Pro) for the launchpad's own account and the cheaper default (Nano Banana 2) for every coin agent.
 */
export function imageModelOf(config: { imageModel?: unknown; platform?: unknown }): string {
  if (typeof config.imageModel === 'string' && config.imageModel) return config.imageModel;
  return config.platform === true ? DEFAULT_IMAGE_MODEL : DEFAULT_COIN_IMAGE_MODEL;
}

/** The image style in force for a parsed or raw stored config (no reference, no notes when unset or malformed). */
export function imageStyleOf(config: { imageStyle?: unknown }): ImageStyle {
  const parsed = imageStyleSchema.safeParse(config.imageStyle ?? {});
  return parsed.success ? parsed.data : { ...NO_IMAGE_STYLE };
}

/** `max_tokens` for one picture on `model`: its tokens per image (the relay's figure when given) plus the text headroom. */
export function imageMaxTokens(model: string, tokensPerImage: number | null = null): number {
  const perImage = tokensPerImage ?? IMAGE_TOKENS_PER_IMAGE[model] ?? IMAGE_TOKENS_PER_IMAGE[relayModelId(model)] ?? MAX_KNOWN_IMAGE_TOKENS;
  return perImage + IMAGE_TEXT_TOKENS;
}

const ILLUSTRATOR = 'You are an illustrator. Produce exactly one image for the request. No text in the image unless the request asks for it.';
const MATCH_REFERENCE =
  'A reference picture is attached: it is the look of this account. Match its visual style, palette, mood and level of detail so the new image reads as part of the same set. Do not copy, trace or reproduce the reference, its composition or any text in it; make a new picture for the request.';

/**
 * The relay request for one picture: the prompt and what the picture must convey (its alt text), with the style
 * reference attached as an `image_url` part and the creator's notes in the instructions. `max_tokens` holds the
 * picture's own tokens (`tokensPerImage`, the relay's figure for the model when known) plus the text headroom.
 */
export function imageRequest(model: string, input: ToolInput<'generate_image'>, style: ImageStyle = NO_IMAGE_STYLE, tokensPerImage: number | null = null): Record<string, unknown> {
  const system = [ILLUSTRATOR, style.reference ? MATCH_REFERENCE : '', style.notes ? `Style notes from the creator: ${style.notes}` : ''].filter(Boolean).join('\n');
  const text = `${input.prompt}\n\nThe image will be described as: ${input.altText}`;
  return {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: style.reference ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: style.reference } }] : text },
    ],
    modalities: ['image', 'text'],
    max_tokens: imageMaxTokens(model, tokensPerImage),
    stream: false,
  };
}

export type ParsedImage = { ok: true; mime: ImageMime; bytes: Buffer } | { ok: false; error: string; finishReason: string | null };

/** The first image of an OpenRouter completion (`choices[0].message.images[].image_url.url`, a base64 data URL). */
export function parseImageResponse(body: Record<string, unknown>): ParsedImage {
  const choice = (body.choices as { message?: Record<string, unknown>; finish_reason?: unknown }[] | undefined)?.[0];
  const msg = choice?.message ?? {};
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  const list = (msg.images as { image_url?: { url?: unknown } }[] | undefined) ?? [];
  const url = list.map((i) => i?.image_url?.url).find((u): u is string => typeof u === 'string');
  if (!url) {
    const text = typeof msg.content === 'string' ? msg.content.trim().slice(0, 200) : '';
    // `length` means the output ceiling was hit before a picture fit: the ceiling, not the prompt, is the problem.
    const why = finishReason === 'length' ? ' (the model ran out of output tokens before a picture fit)' : '';
    return { ok: false, finishReason, error: `image_not_generated${why}${text ? `: ${text}` : ''}` };
  }
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)(;[^,]*)?,(.*)$/is.exec(url);
  if (!m) return { ok: false, finishReason, error: 'image_unreadable: not a data URL' };
  const mime = m[1]!.toLowerCase() as ImageMime;
  if (!(IMAGE_MIMES as readonly string[]).includes(mime)) return { ok: false, finishReason, error: `image_unreadable: unsupported type ${mime}` };
  if (!/;base64/i.test(m[2] ?? '')) return { ok: false, finishReason, error: 'image_unreadable: not base64' };
  const bytes = Buffer.from(m[3]!, 'base64');
  if (bytes.length === 0) return { ok: false, finishReason, error: 'image_unreadable: empty' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, finishReason, error: `image_too_large: ${bytes.length} bytes` };
  return { ok: true, mime, bytes };
}

export async function imagesInWindow(ctx: SupervisorContext, agentId: string): Promise<number> {
  const since = new Date(ctx.now() - IMAGE_WINDOW_MS);
  const [row] = await ctx.db.select({ n: count() }).from(images).where(and(eq(images.agentId, agentId), gte(images.createdAt, since)));
  return row?.n ?? 0;
}

/** Image calls a payment was signed for in the window, failed ones included; each new action is a new key and a new payment. */
async function paidImageAttempts(ctx: SupervisorContext, agentId: string, exceptKey: string): Promise<number> {
  const since = new Date(ctx.now() - IMAGE_WINDOW_MS);
  const [row] = await ctx.db
    .select({ n: count() })
    .from(inference)
    .where(and(eq(inference.agentId, agentId), like(inference.idempotencyKey, 'image:%'), ne(inference.idempotencyKey, exceptKey), gte(inference.createdAt, since), sql`${inference.receipt}->'payment' is not null`));
  return row?.n ?? 0;
}

/** Pictures the agent may still make in the current rolling day (paid attempts count, failed ones included). */
export async function imagesLeftToday(ctx: SupervisorContext, agentId: string): Promise<number> {
  const made = Math.max(await imagesInWindow(ctx, agentId), await paidImageAttempts(ctx, agentId, ''));
  return Math.max(0, MAX_IMAGES_PER_DAY - made);
}

/** When the agent last stored a picture, or null. */
export async function lastImageAt(ctx: Pick<SupervisorContext, 'db'>, agentId: string): Promise<number | null> {
  const row = await ctx.db.select({ at: images.createdAt }).from(images).where(eq(images.agentId, agentId)).orderBy(desc(images.createdAt)).limit(1);
  return row[0]?.at.getTime() ?? null;
}

export type GenerateImageOutcome = { kind: 'completed'; result: { imageId: string; alt: string; mime: string; bytes: number } } | { kind: 'failed'; error: string } | { kind: 'unknown'; error: string };

/** What the model is told after a failed picture, whatever the reason: the post goes out without one. */
export const WITHOUT_PICTURE = 'Publish your post without an imageId; do not call generate_image again this turn.';
/** A failure message with the way forward appended, one full stop between them. */
export function withoutPicture(error: string): string {
  return `${error.trim().replace(/\.+$/, '')}. ${WITHOUT_PICTURE}`;
}

export interface GenerateImageOptions {
  /** The runtime cycle (bookkeeping for the paid call). */
  cycle?: number;
  /** Texts of the messages received this turn: a picture is never made on request (image-rules.ts). */
  receivedTexts?: Iterable<string>;
}

/**
 * Executes `generate_image` for a bound action. Idempotent per `pending.id`: an image already stored for the
 * action is returned again, and the relay call is keyed by the action so an interrupted attempt is reconciled,
 * never re-bought. The daily cap counts every paid attempt, so a provider that keeps failing cannot drain the agent.
 */
export async function generateImage(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, pending: PendingAction, input: ToolInput<'generate_image'>, options: GenerateImageOptions | number = {}): Promise<GenerateImageOutcome> {
  const opts: GenerateImageOptions = typeof options === 'number' ? { cycle: options } : options;
  const log = ctx.log.child({ agentId: agent.agentId, actionId: pending.id });
  const existing = await ctx.db.query.images.findFirst({ where: eq(images.actionId, pending.id) });
  if (existing) return { kind: 'completed', result: { imageId: existing.id, alt: existing.alt, mime: existing.mime, bytes: existing.sizeBytes } };

  const refuse = (error: string): GenerateImageOutcome => {
    log.warn({ error: error.slice(0, 300) }, 'picture refused before any payment');
    return { kind: 'failed', error: withoutPicture(error) };
  };
  // The hard rules, in code and free: the prompt and the alt text, then "never on request".
  const own = (config as { token?: { name?: unknown; symbol?: unknown } }).token;
  const risk = imagePromptRisk(input, { platform: config.platform === true, ownNames: [own?.name, own?.symbol].filter((n): n is string => typeof n === 'string' && n.length > 0) });
  if (risk) return refuse(risk.message);
  if (opts.receivedTexts && pictureRequested(opts.receivedTexts)) return refuse(REQUESTED_MESSAGE);

  // The action's own key is left out: resuming it costs nothing, so the cap must not strand a credit.
  const key = `image:${pending.id}`;
  const made = Math.max(await imagesInWindow(ctx, agent.agentId), await paidImageAttempts(ctx, agent.agentId, key));
  if (made >= MAX_IMAGES_PER_DAY) return refuse(`image_daily_cap: at most ${MAX_IMAGES_PER_DAY} images per 24 hours`);

  const model = imageModelOf(config);
  const catalog = await relayImageCatalog(ctx, agent);
  const price = picturePriceFor(catalog, model);
  if (price) {
    const fuel = await pictureFuelCheck(ctx, agent, price.microUsdc);
    if (!fuel.ok) return refuse(fuel.error);
  }

  const request = imageRequest(model, input, imageStyleOf(config), imageTokensPerImage(catalog, model));
  const res = await relayRequest(ctx, agent, { key, cycle: opts.cycle ?? 0, request, maxQuoteMicroUsdc: BigInt(maxQuoteFor(model)) });
  // A credit is resumed like an unknown outcome: the same action, so the same key and no second payment.
  if (res.kind === 'unknown' || res.kind === 'credit') return { kind: 'unknown', error: res.error };
  if (res.kind === 'failed') {
    log.warn({ model, key, error: res.error.slice(0, 300) }, 'picture failed at the relay');
    return { kind: 'failed', error: withoutPicture(`image_failed: ${res.error}`) };
  }

  const parsed = parseImageResponse(res.body);
  if (!parsed.ok) {
    const usage = (res.body.usage ?? null) as { completion_tokens?: unknown; completion_tokens_details?: { image_tokens?: unknown } } | null;
    log.warn({ model, key, error: parsed.error.slice(0, 300), finishReason: parsed.finishReason, maxTokens: request.max_tokens, completionTokens: usage?.completion_tokens ?? null, imageTokens: usage?.completion_tokens_details?.image_tokens ?? null, replayed: res.replayed }, 'picture paid for but not usable');
    return { kind: 'failed', error: withoutPicture(parsed.error) };
  }
  const id = `img_${pending.id.replace(/^act_/, '')}`;
  await ctx.db
    .insert(images)
    .values({ id, agentId: agent.agentId, actionId: pending.id, alt: input.altText, mime: parsed.mime, bytes: parsed.bytes, sizeBytes: parsed.bytes.length, model, createdAt: new Date(ctx.now()) })
    .onConflictDoNothing();
  log.info({ imageId: id, model, bytes: parsed.bytes.length, priceMicroUsdc: price?.microUsdc ?? null, replayed: res.replayed }, 'image generated');
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
