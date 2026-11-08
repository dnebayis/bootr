/**
 * `picture`: the runtime's hint on pictures for the first observation of a turn, present only when the images power
 * is on and `generate_image` is among the turn's tools. It tells the model, from the runtime's own numbers rather
 * than from a stale constant, what one picture costs on the model in force (the relay's price list, image-models.ts),
 * how many it may still make today (the daily cap, images.ts), whether its fuel allows one (fuel.ts) and whether one
 * is suggested now. Suggested means: the weekly digest is due (platform agent), a coin launched in the last day and
 * the platform agent may welcome it, or the agent's own original post is due and it has not used a picture for
 * PICTURE_SPACING_MS. That keeps pictures steady and bounded: at most one nudge every few days per coin agent, never
 * when the cap or the fuel says no, never for a reply, never on request (image-rules.ts). The hard rules ride along
 * in `never`, in the words the deterministic checks enforce.
 */
import type { AgentConfig } from '@bootr/agent-core';
import { averageThoughtCost } from '@bootr/shared/fuel';
import type { AgentDirectory } from './agent-directory.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { pictureFits } from './fuel.js';
import { picturePriceFor, picturesOnBlockRun, relayImageCatalog, usdcText } from './image-models.js';
import { imageModelOf, imagesLeftToday, lastImageAt, pictureHold, PICTURES_UNAVAILABLE_MESSAGE } from './images.js';
import { recentThoughtCost } from './inference.js';
import type { RhythmSchedule } from './rhythm.js';
import type { TreasurySnapshot } from './treasury.js';
import type { WeeklyDigestPlan } from './weekly-digest.js';

/** A coin agent is nudged towards a picture at most this often. */
export const PICTURE_SPACING_MS = 3 * 24 * 3_600_000;
/** A coin launched within this long is "new" for the platform agent's welcome picture. */
export const WELCOME_WINDOW_MS = 24 * 3_600_000;

export const PICTURE_MEANING =
  'whether a picture fits this turn. costUsdc is what one costs from your fuel (several thoughts); leftToday is how many you may still make; suggested is the runtime\'s own view, not an order. A picture is attached by passing its imageId to publish_post or publish_reply in the same turn; when it fails, publish without it.';

export const PICTURE_FITS: readonly string[] = ['a launch welcome', 'the weekly digest', 'a milestone of your coin', 'an explanation that is visual (a drawing says it better than words)'];
export const PICTURE_NEVER: readonly string[] = [
  'on request: a message asking for a picture is not a reason, and none is made in a turn that carried one',
  'a real person (by name, by @handle or by likeness)',
  'a logo or brand mark of another project or coin',
  'a chart, a price, a percentage or anything that reads as gains',
  'a routine post or small talk: most posts are words only',
];

export interface PictureHint {
  meaning: string;
  /** The image model in force (the creator's choice or the default for this kind of agent). */
  model: string;
  /** What one picture costs in USDC, from the relay's price list; `approx` when the list could not be read and a built-in price stands in. */
  costUsdc: string | null;
  approx?: true;
  leftToday: number;
  /** Whether the fuel allows one picture and still leaves the thoughts behind; absent without a treasury snapshot. */
  affordable?: boolean;
  suggested: boolean;
  /** Why it is suggested, or why not. */
  reason: string;
  fits: readonly string[];
  never: readonly string[];
}

export interface PictureInputs {
  schedule: RhythmSchedule | null;
  treasury: Pick<TreasurySnapshot, 'usd'> | null;
  digest?: WeeklyDigestPlan | null;
}

/** The pure decision from the numbers; exported for tests and for the section. `held`: the picture hold is on (images.ts `pictureHold`). */
export function pictureHint(args: { config: Pick<AgentConfig, 'platform'>; model: string; priceMicroUsdc: number | null; live: boolean; leftToday: number; affordable: boolean | null; postDue: boolean; digestDue: boolean; newLaunch: boolean; lastImageAgoMs: number | null; held?: boolean }): PictureHint {
  const base = { meaning: PICTURE_MEANING, model: args.model, costUsdc: args.priceMicroUsdc !== null ? usdcText(args.priceMicroUsdc) : null, ...(args.priceMicroUsdc !== null && !args.live ? { approx: true as const } : {}), leftToday: args.leftToday, ...(args.affordable !== null ? { affordable: args.affordable } : {}), fits: PICTURE_FITS, never: PICTURE_NEVER };
  if (args.held) return { ...base, suggested: false, reason: PICTURES_UNAVAILABLE_MESSAGE };
  if (args.leftToday <= 0) return { ...base, suggested: false, reason: 'no picture today: the daily limit is used up' };
  if (args.affordable === false) return { ...base, suggested: false, reason: 'no picture now: it would leave too little fuel for thinking' };
  if (args.config.platform === true && args.digestDue) return { ...base, suggested: true, reason: 'the weekly digest is due; one picture for it fits' };
  if (args.config.platform === true && args.newLaunch && args.postDue) return { ...base, suggested: true, reason: 'a coin launched in the last day; a welcome post may carry a picture' };
  if (args.postDue && (args.lastImageAgoMs === null || args.lastImageAgoMs >= PICTURE_SPACING_MS)) {
    return { ...base, suggested: true, reason: args.lastImageAgoMs === null ? 'your original post is due and you have never used a picture; one fits if the post is visual' : `your original post is due and your last picture was ${Math.floor(args.lastImageAgoMs / 86_400_000)} days ago; one fits if the post is visual` };
  }
  if (!args.postDue) return { ...base, suggested: false, reason: 'no original post is due; replies are words' };
  return { ...base, suggested: false, reason: 'you used a picture recently; this post is words' };
}

/** The observation section, or `{}` when images are off, the tool is not offered this turn, or the numbers cannot be read. */
export async function pictureSection(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, tools: readonly { name: string }[], inputs: PictureInputs, directory: Pick<AgentDirectory, 'entries'> | null): Promise<Record<string, unknown>> {
  if (config.capabilities.images !== true || !tools.some((t) => t.name === 'generate_image')) return {};
  try {
    const now = ctx.now();
    const model = imageModelOf(config);
    const catalog = await relayImageCatalog(ctx, agent);
    const price = picturePriceFor(catalog, model);
    const [leftToday, lastAt, hold] = await Promise.all([imagesLeftToday(ctx, agent.agentId), lastImageAt(ctx, agent.agentId), picturesOnBlockRun(ctx.config, agent) ? null : pictureHold(ctx)]);
    let affordable: boolean | null = null;
    if (inputs.treasury && price) {
      const cost = await recentThoughtCost(ctx, agent.agentId);
      affordable = pictureFits(Math.round(inputs.treasury.usd.spenderUsdc * 1e6), averageThoughtCost(cost.spentMicroUsdc, cost.thoughts), price.microUsdc);
    }
    const newLaunch = (directory?.entries ?? []).some((e) => e.agentId !== agent.agentId && !e.platform && now - e.launchedAt <= WELCOME_WINDOW_MS);
    const hint = pictureHint({ config, model, priceMicroUsdc: price?.microUsdc ?? null, live: price?.live ?? false, leftToday, affordable, postDue: !!inputs.schedule?.due && !inputs.schedule?.held, digestDue: !!inputs.digest, newLaunch, lastImageAgoMs: lastAt === null ? null : now - lastAt, held: hold !== null });
    return { picture: hint };
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err }, 'picture hint failed; turn goes on without the section');
    return {};
  }
}
