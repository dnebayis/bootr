/**
 * The model catalog: the one table of the models an agent may think, decide and draw with, as BlockRun serves them.
 *
 * Every list of models in Bootr derives from this file: what the launch form and the creator console offer, the admin
 * allow-list's default, the quote cap of one call (`maxQuoteFor`), the direct-mode ids, the image defaults, and the
 * migration that moves an agent from a retired id to its stand-in. Changing provider means changing this table.
 *
 * Prices are BlockRun's list prices (USD per million tokens, kept here as micro-USDC per 1K tokens, so $3/M is 3000)
 * read from `GET https://blockrun.ai/api/v1/models` on 2026-11-08, and each id's payment scheme comes from an unpaid 402
 * of the same day: `upto` (settles what the call cost) is offered on the Claude and DeepSeek ids, every other model takes
 * `exact` (settles the quote). The supervisor checks this table against BlockRun's live list at start (model-check.ts).
 *
 * Roles: `think` writes posts and replies; `decide` is the cheap, fast half of a turn (economy mode) and a fine whole
 * mind for a modest agent; `economy` is the cheapest tier; `image` draws pictures. Display names carry no provider jargon.
 */

export type ModelRole = 'think' | 'decide' | 'economy' | 'image';
export type PaymentScheme = 'upto' | 'exact';

export interface TokenPrice {
  /** Micro-USDC per 1K prompt tokens. */
  inputMicroUsdcPerKTokens: number;
  /** Micro-USDC per 1K completion tokens. */
  outputMicroUsdcPerKTokens: number;
}

export interface ImagePrice {
  /** Micro-USDC for one picture, before BlockRun's per-call fee. */
  perImageMicroUsdc: number;
}

export interface CatalogModel {
  /** BlockRun's id, which is also the id stored on an agent's config. */
  id: string;
  /** Plain display name. */
  name: string;
  /** Who runs the model, for grouping in a picker. */
  vendor: string;
  role: ModelRole;
  /** The payment scheme direct mode uses for it: the best BlockRun offered on 2026-11-08. */
  scheme: PaymentScheme;
  price: TokenPrice | ImagePrice;
  /** The most one call may cost, micro-USDC: the payer's hard cap and the relay's `X-Max-Quote-Micro-USDC`. */
  maxQuoteMicroUsdc: number;
  /** Ids this model is also known by at the relay (OpenRouter): the same model, another name. */
  aliases: readonly string[];
  /** Retired ids whose agents move here: a different model, the closest BlockRun serves. */
  replaces: readonly string[];
}

/** BlockRun's flat fee on every paid call, micro-USDC ($0.001). */
export const BLOCKRUN_CALL_FEE_MICRO_USDC = 1000;
/** The least BlockRun quotes for a call (seen on DeepSeek with a 17-token prompt). */
export const BLOCKRUN_MIN_QUOTE_MICRO_USDC = 2000;
/** The id a new agent gets when the launch names none, and the one the launch form recommends. */
export const DEFAULT_MIND_MODEL = 'anthropic/claude-haiku-4.5';
/** The platform agent's picture model when its config names none. */
export const DEFAULT_PLATFORM_IMAGE_MODEL = 'google/nano-banana-pro';
/** A coin agent's picture model when its config names none: about the same price as Pro's little sibling was. */
export const DEFAULT_COIN_IMAGE_MODEL = 'google/nano-banana-2';
/** The day every id, price and scheme below was read from BlockRun. */
export const CATALOG_VERIFIED_AT = '2026-11-08';

const text = (id: string, name: string, vendor: string, role: Exclude<ModelRole, 'image'>, scheme: PaymentScheme, input: number, output: number, maxQuoteMicroUsdc: number, extra: { aliases?: string[]; replaces?: string[] } = {}): CatalogModel => ({
  id,
  name,
  vendor,
  role,
  scheme,
  price: { inputMicroUsdcPerKTokens: input, outputMicroUsdcPerKTokens: output },
  maxQuoteMicroUsdc,
  aliases: extra.aliases ?? [],
  replaces: extra.replaces ?? [],
});

const image = (id: string, name: string, vendor: string, perImageMicroUsdc: number, maxQuoteMicroUsdc: number, extra: { aliases?: string[]; replaces?: string[] } = {}): CatalogModel => ({
  id,
  name,
  vendor,
  role: 'image',
  scheme: 'exact',
  price: { perImageMicroUsdc },
  maxQuoteMicroUsdc,
  aliases: extra.aliases ?? [],
  replaces: extra.replaces ?? [],
});

export const MODEL_CATALOG: readonly CatalogModel[] = [
  // Writers.
  text('anthropic/claude-sonnet-4.6', 'Claude Sonnet 4.6', 'anthropic', 'think', 'upto', 3000, 15000, 1_500_000),
  text('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5', 'anthropic', 'think', 'upto', 3000, 15000, 1_500_000),
  text('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 'anthropic', 'think', 'upto', 2000, 10000, 1_500_000),
  text('anthropic/claude-opus-4.8', 'Claude Opus 4.8', 'anthropic', 'think', 'upto', 5000, 25000, 3_500_000),
  text('openai/gpt-5.5', 'GPT-5.5', 'openai', 'think', 'exact', 5000, 30000, 4_000_000),
  text('openai/gpt-5.4', 'GPT-5.4', 'openai', 'think', 'exact', 2500, 15000, 2_500_000),
  text('openai/gpt-5.6-terra', 'GPT-5.6 Terra', 'openai', 'think', 'exact', 2000, 12000, 2_500_000),
  text('openai/gpt-4.1', 'GPT-4.1', 'openai', 'think', 'exact', 2000, 8000, 1_000_000),
  text('google/gemini-3.1-pro', 'Gemini 3.1 Pro', 'google', 'think', 'exact', 2000, 12000, 1_500_000, { aliases: ['google/gemini-3.1-pro-preview'] }),
  text('xai/grok-4.7', 'Grok 4.7', 'xai', 'think', 'exact', 2000, 6000, 1_000_000, { aliases: ['x-ai/grok-4.7'] }),
  text('xai/grok-4.3', 'Grok 4.3', 'xai', 'think', 'exact', 1250, 2500, 600_000, { replaces: ['x-ai/grok-4.20'] }),
  text('moonshot/kimi-k3.1-pro', 'Kimi K3.1 Pro', 'moonshot', 'think', 'exact', 2000, 10000, 1_500_000, { replaces: ['moonshotai/kimi-k2.6'] }),
  text('zai/glm-5.3', 'GLM 5.3', 'zai', 'think', 'exact', 1400, 4400, 600_000, { replaces: ['z-ai/glm-4.6'] }),
  text('mistral/mistral-large-4', 'Mistral Large 4', 'mistral', 'think', 'exact', 1360, 4180, 600_000, { replaces: ['mistralai/mistral-medium-3.1'] }),
  // Deciders: fast and cheap, the reading half of a turn.
  text('anthropic/claude-haiku-4.5', 'Claude Haiku 4.5', 'anthropic', 'decide', 'upto', 1000, 5000, 500_000),
  text('openai/gpt-5.4-mini', 'GPT-5.4 Mini', 'openai', 'decide', 'exact', 750, 4500, 800_000),
  text('google/gemini-3.8-flash', 'Gemini 3.8 Flash', 'google', 'decide', 'exact', 750, 3750, 700_000),
  text('google/gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 'google', 'decide', 'exact', 300, 2500, 400_000),
  text('openai/gpt-5.6-luna', 'GPT-5.6 Luna', 'openai', 'decide', 'exact', 200, 1200, 400_000),
  // Economy: the cheapest tier.
  text('deepseek/deepseek-chat', 'DeepSeek Chat', 'deepseek', 'economy', 'upto', 140, 280, 200_000, { replaces: ['deepseek/deepseek-v3.2', 'meta-llama/llama-4-maverick'] }),
  text('openai/gpt-4.1-mini', 'GPT-4.1 Mini', 'openai', 'economy', 'exact', 400, 1600, 300_000),
  text('openai/gpt-5-mini', 'GPT-5 Mini', 'openai', 'economy', 'exact', 250, 2000, 400_000),
  text('openai/gpt-5.4-nano', 'GPT-5.4 Nano', 'openai', 'economy', 'exact', 200, 1250, 300_000, { replaces: ['openai/gpt-5-nano'] }),
  text('google/gemini-2.5-flash', 'Gemini 2.5 Flash', 'google', 'economy', 'exact', 300, 2500, 400_000),
  text('minimax/minimax-m2.7', 'MiniMax M2.7', 'minimax', 'economy', 'exact', 300, 1200, 300_000),
  text('qwen/qwen3.7-plus', 'Qwen 3.7 Plus', 'qwen', 'economy', 'exact', 320, 1280, 200_000, { replaces: ['qwen/qwen3-235b-a22b-2507'] }),
  // Pictures: one fixed price each (BlockRun's image API).
  image('google/nano-banana-2', 'Nano Banana 2', 'google', 94_500, 150_000, { aliases: ['google/gemini-3.1-flash-image'] }),
  image('google/nano-banana-pro', 'Nano Banana Pro', 'google', 105_000, 250_000, { aliases: ['google/gemini-3-pro-image'] }),
  image('google/nano-banana', 'Nano Banana', 'google', 52_500, 120_000, { aliases: ['google/gemini-2.5-flash-image'] }),
  image('openai/gpt-image-2', 'GPT Image 2', 'openai', 63_000, 250_000, { aliases: ['openai/gpt-5.4-image-2'] }),
  image('openai/gpt-image-1', 'GPT Image 1', 'openai', 21_000, 150_000, { replaces: ['openai/gpt-5-image-mini'] }),
];

/** Vendor names for the pickers, in display order; a vendor not listed shows its prefix. */
export const MODEL_VENDORS: readonly { vendor: string; name: string }[] = [
  { vendor: 'anthropic', name: 'Anthropic' },
  { vendor: 'openai', name: 'OpenAI' },
  { vendor: 'google', name: 'Google' },
  { vendor: 'xai', name: 'xAI' },
  { vendor: 'deepseek', name: 'DeepSeek' },
  { vendor: 'moonshot', name: 'Moonshot' },
  { vendor: 'minimax', name: 'MiniMax' },
  { vendor: 'qwen', name: 'Qwen' },
  { vendor: 'mistral', name: 'Mistral' },
  { vendor: 'zai', name: 'Z.ai' },
];

const byId = new Map<string, CatalogModel>();
const byOtherId = new Map<string, CatalogModel>();
for (const m of MODEL_CATALOG) {
  byId.set(m.id, m);
  for (const other of [...m.aliases, ...m.replaces]) byOtherId.set(other, m);
}

/** The catalog entry an id names: by its own id, or by a retired id it stands in for. Null for an unknown id. */
export function catalogModel(id: string): CatalogModel | null {
  return byId.get(id) ?? byOtherId.get(id) ?? null;
}

/** Whether `id` is a catalog id as stored on a config today (not a retired one). */
export function isCatalogId(id: string): boolean {
  return byId.has(id);
}

/** The id BlockRun is asked for: the catalog id of `id`, or null when nothing in the catalog answers to it. */
export function directModelId(id: string): string | null {
  return catalogModel(id)?.id ?? null;
}

/** The id the relay (OpenRouter) knows the catalog model by, when it is the same model under another name; else the id itself. */
export function relayModelId(id: string): string {
  const m = byId.get(id);
  return m?.aliases[0] ?? id;
}

/** Whether a retired id names the same model as its catalog entry (a rename) rather than a different one (a stand-in). */
export function isAlias(id: string): boolean {
  return MODEL_CATALOG.some((m) => m.aliases.includes(id));
}

export function isImageModel(id: string): boolean {
  return catalogModel(id)?.role === 'image';
}

/** The models an agent may think with (every role but `image`). */
export function mindModels(): readonly CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.role !== 'image');
}

export function imageModels(): readonly CatalogModel[] {
  return MODEL_CATALOG.filter((m) => m.role === 'image');
}

/** Every retired id the catalog knows, with the id that stands in for it. */
export function retiredModelIds(): readonly { from: string; to: string; same: boolean }[] {
  return MODEL_CATALOG.flatMap((m) => [...m.aliases.map((from) => ({ from, to: m.id, same: true })), ...m.replaces.map((from) => ({ from, to: m.id, same: false }))]);
}

export function vendorName(vendor: string): string {
  return MODEL_VENDORS.find((v) => v.vendor === vendor)?.name ?? vendor;
}

export function modelDisplayName(id: string): string {
  const m = catalogModel(id);
  if (m) return m.name;
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  return bare.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** One thought as the launch form prices it: the prompt an agent sends and the whole output allowance. */
export const THOUGHT_SIZE = { promptTokens: 4000, outputTokens: 1024 } as const;

/**
 * What BlockRun quotes for one call on `model`: the prompt at the input rate, the whole `max_tokens` at the output rate,
 * plus its flat fee, never under its minimum. `exact` settles this amount; `upto` settles the real cost, at most this.
 */
export function thoughtQuoteMicroUsdc(model: Pick<CatalogModel, 'price'>, size: { promptTokens: number; outputTokens: number } = THOUGHT_SIZE): number | null {
  if (!('inputMicroUsdcPerKTokens' in model.price)) return null;
  const cost = Math.ceil((model.price.inputMicroUsdcPerKTokens * size.promptTokens + model.price.outputMicroUsdcPerKTokens * size.outputTokens) / 1000);
  return Math.max(BLOCKRUN_MIN_QUOTE_MICRO_USDC, cost + BLOCKRUN_CALL_FEE_MICRO_USDC);
}

/** What BlockRun quotes for one picture on `model`: its fixed price plus the flat fee. */
export function pictureQuoteMicroUsdc(model: Pick<CatalogModel, 'price'>): number | null {
  if (!('perImageMicroUsdc' in model.price)) return null;
  return model.price.perImageMicroUsdc + BLOCKRUN_CALL_FEE_MICRO_USDC;
}

/**
 * The relay's price of one picture (pictures stay on the relay unless the supervisor's BLOCKRUN_IMAGE_ROUTE says
 * `direct`): what the relay's `GET /v1/models` lists for the model, as the relay charges it. The picture's own output
 * tokens at the image rate, the prompt at the input rate (RELAY_PICTURE_PROMPT_TOKENS: the instructions, the prompt,
 * the alt text and the style reference the relay prices as 1600 prompt tokens), a sentence of text at the output rate
 * (RELAY_PICTURE_TEXT_TOKENS), plus the relay's margin. The supervisor's picture hint and the web's console both read
 * this one formula, so the agent and the creator see the same number. Null when the entry carries no image price.
 */
export const RELAY_PICTURE_PROMPT_TOKENS = 2200;
export const RELAY_PICTURE_TEXT_TOKENS = 64;

export interface RelayImagePrice {
  /** Micro-USDC per 1K prompt tokens; null when the listing gave no price. */
  inputMicroUsdcPerKTokens: number | null;
  /** Micro-USDC per 1K completion (text) tokens; null when the listing gave no price. */
  outputMicroUsdcPerKTokens: number | null;
  /** Micro-USDC per 1K image output tokens; null when the listing gave no price. */
  imageOutputMicroUsdcPerKTokens: number | null;
  /** Output tokens the relay bills one picture as; null when the listing gave no figure. */
  imageOutputTokensPerImage: number | null;
}

/** The relay's margin on every quote: basis points and a fixed amount in micro-USDC (its defaults as of 2026-11-04). */
export const RELAY_DEFAULT_MARGIN = { bps: 1000, fixedMicroUsdc: 100 } as const;

export function relayPictureMicroUsdc(price: RelayImagePrice, margin: { bps: number; fixedMicroUsdc: number } = RELAY_DEFAULT_MARGIN): number | null {
  if (price.imageOutputMicroUsdcPerKTokens === null || price.imageOutputTokensPerImage === null) return null;
  const image = (price.imageOutputMicroUsdcPerKTokens * price.imageOutputTokensPerImage) / 1000;
  const input = ((price.inputMicroUsdcPerKTokens ?? 0) * RELAY_PICTURE_PROMPT_TOKENS) / 1000;
  const text = ((price.outputMicroUsdcPerKTokens ?? 0) * RELAY_PICTURE_TEXT_TOKENS) / 1000;
  const cost = image + input + text;
  return Math.ceil(cost + (cost * margin.bps) / 10_000 + margin.fixedMicroUsdc);
}

/**
 * The relay's image models and prices as of 2026-11-04 (apps/inference/src/pricing.ts), under the relay's own names:
 * what the supervisor and the web fall back to when the relay's `GET /v1/models` cannot be read. The relay's live list
 * wins whenever it answers.
 */
export const RELAY_IMAGE_PRICES_FALLBACK: readonly (RelayImagePrice & { id: string })[] = [
  { id: 'google/gemini-3-pro-image', inputMicroUsdcPerKTokens: 2000, outputMicroUsdcPerKTokens: 12000, imageOutputMicroUsdcPerKTokens: 120000, imageOutputTokensPerImage: 1120 },
  { id: 'google/gemini-3.1-flash-image', inputMicroUsdcPerKTokens: 500, outputMicroUsdcPerKTokens: 3000, imageOutputMicroUsdcPerKTokens: 60000, imageOutputTokensPerImage: 1120 },
  { id: 'openai/gpt-5.4-image-2', inputMicroUsdcPerKTokens: 8000, outputMicroUsdcPerKTokens: 15000, imageOutputMicroUsdcPerKTokens: 30000, imageOutputTokensPerImage: 4160 },
];

/** One entry of BlockRun's `GET /v1/models`, as far as the check reads it (USD per million tokens, or per image). */
export interface LiveModel {
  id: string;
  available?: boolean | null;
  pricing?: { input?: number; output?: number; per_image?: number } | null;
}

export interface CatalogGap {
  id: string;
  /** `missing`: not in the live list; `unavailable`: listed as not available; `price`: the live price differs from the table. */
  kind: 'missing' | 'unavailable' | 'price';
  detail: string;
}

/** The catalog held against BlockRun's live list: what is gone, what is marked unavailable, and whose price moved. */
export function catalogGaps(live: readonly LiveModel[]): CatalogGap[] {
  const byLiveId = new Map(live.map((m) => [m.id, m]));
  const gaps: CatalogGap[] = [];
  for (const m of MODEL_CATALOG) {
    const l = byLiveId.get(m.id);
    if (!l) {
      gaps.push({ id: m.id, kind: 'missing', detail: 'not in BlockRun’s model list' });
      continue;
    }
    if (l.available === false) gaps.push({ id: m.id, kind: 'unavailable', detail: 'listed by BlockRun as not available' });
    const p = l.pricing ?? {};
    if ('perImageMicroUsdc' in m.price) {
      if (typeof p.per_image === 'number' && Math.round(p.per_image * 1_000_000) !== m.price.perImageMicroUsdc) gaps.push({ id: m.id, kind: 'price', detail: `per picture ${Math.round(p.per_image * 1_000_000)} micro-USDC live, ${m.price.perImageMicroUsdc} in the catalog` });
    } else {
      const input = typeof p.input === 'number' ? Math.round(p.input * 1000) : null;
      const output = typeof p.output === 'number' ? Math.round(p.output * 1000) : null;
      if ((input !== null && input !== m.price.inputMicroUsdcPerKTokens) || (output !== null && output !== m.price.outputMicroUsdcPerKTokens)) {
        gaps.push({ id: m.id, kind: 'price', detail: `live ${input ?? '?'}/${output ?? '?'} micro-USDC per 1K tokens, catalog ${m.price.inputMicroUsdcPerKTokens}/${m.price.outputMicroUsdcPerKTokens}` });
      }
    }
  }
  return gaps;
}
