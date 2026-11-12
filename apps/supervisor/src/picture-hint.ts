/**
 * `picture`: the runtime's hint on pictures for the first observation of a turn, present only when the images power
 * is on and `generate_image` is among the turn's tools. It tells the model, from the runtime's own numbers rather
 * than from a stale constant, what one picture costs on the model in force (the relay's price list, image-models.ts),
 * how many it may still make today (the daily cap, images.ts), whether its fuel allows one (fuel.ts) and whether one
 * is suggested now. Suggested means: the weekly digest is due (platform agent), a coin launched in the last day and
 * the platform agent may welcome it, or the agent's own original post is due and it has not used a picture for
 * PICTURE_SPACING_MS, or an open creator request wants a picture (creator-requests.ts). Suggested is an instruction
 * (`instruction`), not a hint: the agent made no picture in 31 hours while it read "not an order" (2026-11-11). It
 * stays bounded: at most one nudge every few days per coin agent, never when the cap, the fuel or the hold says no,
 * never on a stranger's request (image-rules.ts). The hard rules ride along in `never`, in the words the deterministic
 * checks enforce.
 */
import type { AgentConfig } from '@bootr/agent-core';
import { averageThoughtCost } from '@bootr/shared/fuel';
import type { AgentDirectory } from './agent-directory.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { pictureFits } from './fuel.js';
import { picturePriceFor, picturesOnBlockRun, relayImageCatalog, usdcText } from './image-models.js';
import { imageModelOf, imageStyleOf, imagesLeftToday, lastImageAt, pictureHold, PICTURES_UNAVAILABLE_MESSAGE } from './images.js';
import { isOwn } from './own/registry.js';
import { recentThoughtCost } from './inference.js';
import type { RhythmSchedule } from './rhythm.js';
import type { TreasurySnapshot } from './treasury.js';
import type { WeeklyDigestPlan } from './weekly-digest.js';

/** A coin agent is nudged towards a picture at most this often. */
export const PICTURE_SPACING_MS = 3 * 24 * 3_600_000;
/** A coin launched within this long is "new" for the platform agent's welcome picture. */
export const WELCOME_WINDOW_MS = 24 * 3_600_000;

export const PICTURE_MEANING =
  'whether a picture fits this turn. costUsdc is what one costs from your fuel (several thoughts); leftToday is how many you may still make. When suggested is true, make one for your original post of this turn (instruction says how). A picture is attached by passing its imageId to publish_post or publish_reply in the same turn; when generate_image fails, publish without it.';

/** What a suggested hint tells the model to do, in plain words. */
export const PICTURE_INSTRUCTION =
  'Make one picture for your original post this turn: call generate_image with a prompt and an alt text, then pass its imageId to publish_post. In economy mode, put picture: {brief} in draft_intent and the writer makes it. If generate_image fails, post the words without it.';

export const PICTURE_FITS: readonly string[] = ['a launch welcome', 'the weekly digest', 'a milestone of your coin', 'an explanation that is visual (a drawing says it better than words)', 'a picture your creator asked for (creatorRequests)'];
export const PICTURE_NEVER: readonly string[] = [
  'on a stranger\'s request: a mention asking for a picture is not a reason, and none is made in a turn that carried one (your creator\'s own requests, under creatorRequests, are not a stranger\'s)',
  'a real person (by name, by @handle or by likeness)',
  'a logo or brand mark of another project or coin',
  'a chart, a price, a percentage or anything that reads as gains',
  'a reply to small talk: replies are words',
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
  /** Present when suggested: what to do, as an instruction (`PICTURE_INSTRUCTION`). */
  instruction?: string;
  fits: readonly string[];
  never: readonly string[];
}

/**
 * An own agent's picture section (docs/design/byo-agent.md section 1.5): its client makes the picture and uploads it,
 * so nothing is bought and the fuel is not asked. The hint keeps `suggested`, `leftToday`, `fits`, `never` and the
 * instruction; the model, the cost and `affordable` go; the coin's style reference and the creator's style notes are
 * included so the client can match the coin's look.
 */
export const OWN_PICTURE_MEANING =
  'whether a picture fits this turn. You make pictures yourself and upload them with upload_picture; nothing is bought. leftToday is how many you may still upload. When suggested is true, make one for your original post of this turn (instruction says how). A picture is attached by passing its imageId to publish_post or publish_reply in the same turn; when you cannot make one or the upload fails, publish without it.';
export const OWN_PICTURE_INSTRUCTION =
  'Make one picture for your original post this turn in the style below, save it in your Bootr pictures folder and call upload_picture with its path, an alt text and one sentence on what it shows; then pass its imageId to publish_post. If you cannot make a picture or the upload fails, post the words without it.';

export interface OwnPictureHint {
  meaning: string;
  leftToday: number;
  suggested: boolean;
  reason: string;
  instruction?: string;
  fits: readonly string[];
  never: readonly string[];
  /** The look of this account: the reference picture's address (null when none) and the creator's notes. */
  style: { reference: string | null; notes: string };
}

export function ownPictureHint(hint: PictureHint, style: { reference: string | null; notes: string }): OwnPictureHint {
  return {
    meaning: OWN_PICTURE_MEANING,
    leftToday: hint.leftToday,
    suggested: hint.suggested,
    reason: hint.reason,
    ...(hint.suggested ? { instruction: OWN_PICTURE_INSTRUCTION } : {}),
    fits: hint.fits,
    never: hint.never,
    style: { reference: style.reference, notes: style.notes },
  };
}

export interface PictureInputs {
  schedule: RhythmSchedule | null;
  treasury: Pick<TreasurySnapshot, 'usd'> | null;
  digest?: WeeklyDigestPlan | null;
  /** An open creator request wants a picture (creator-requests.ts). */
  creatorAsked?: boolean;
}

/**
 * The pure decision from the numbers; exported for tests and for the section. `held`: the picture hold is on (images.ts
 * `pictureHold`). `creatorAsked`: an open creator request wants a picture (creator-requests.ts); it is suggested then
 * whether or not a post is due (a request may be posted outside the slot) and whatever the spacing, but never past the
 * hold, the daily cap or the fuel check.
 */
export function pictureHint(args: { config: Pick<AgentConfig, 'platform'>; model: string; priceMicroUsdc: number | null; live: boolean; leftToday: number; affordable: boolean | null; postDue: boolean; digestDue: boolean; newLaunch: boolean; lastImageAgoMs: number | null; held?: boolean; creatorAsked?: boolean }): PictureHint {
  const base = { meaning: PICTURE_MEANING, model: args.model, costUsdc: args.priceMicroUsdc !== null ? usdcText(args.priceMicroUsdc) : null, ...(args.priceMicroUsdc !== null && !args.live ? { approx: true as const } : {}), leftToday: args.leftToday, ...(args.affordable !== null ? { affordable: args.affordable } : {}), fits: PICTURE_FITS, never: PICTURE_NEVER };
  const suggest = (reason: string): PictureHint => ({ ...base, suggested: true, reason, instruction: PICTURE_INSTRUCTION });
  if (args.held) return { ...base, suggested: false, reason: PICTURES_UNAVAILABLE_MESSAGE };
  if (args.leftToday <= 0) return { ...base, suggested: false, reason: 'no picture today: the daily limit is used up' };
  if (args.affordable === false) return { ...base, suggested: false, reason: 'no picture now: it would leave too little fuel for thinking' };
  if (args.creatorAsked) return suggest('your creator asked for a picture (creatorRequests): make it for the post that request is about');
  if (args.config.platform === true && args.digestDue) return suggest('the weekly digest is due: make one picture for it');
  if (args.config.platform === true && args.newLaunch && args.postDue) return suggest('a coin launched in the last day: make a picture for the welcome post');
  if (args.postDue && (args.lastImageAgoMs === null || args.lastImageAgoMs >= PICTURE_SPACING_MS)) {
    return suggest(args.lastImageAgoMs === null ? 'your original post is due and you have never used a picture: make one for it' : `your original post is due and your last picture was ${Math.floor(args.lastImageAgoMs / 86_400_000)} days ago: make one for it`);
  }
  if (!args.postDue) return { ...base, suggested: false, reason: 'no original post is due; replies are words' };
  return { ...base, suggested: false, reason: 'you used a picture recently; this post is words' };
}

/** The observation section, or `{}` when images are off, the tool is not offered this turn, or the numbers cannot be read. */
export async function pictureSection(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, tools: readonly { name: string }[], inputs: PictureInputs, directory: Pick<AgentDirectory, 'entries'> | null): Promise<Record<string, unknown>> {
  // An own agent holds no `generate_image` (its client uploads): its section depends on the images power alone.
  const own = isOwn(agent);
  if (config.capabilities.images !== true || (!own && !tools.some((t) => t.name === 'generate_image'))) return {};
  try {
    const now = ctx.now();
    if (own) {
      const [leftToday, lastAt] = await Promise.all([imagesLeftToday(ctx, agent.agentId), lastImageAt(ctx, agent.agentId)]);
      const newLaunch = (directory?.entries ?? []).some((e) => e.agentId !== agent.agentId && !e.platform && now - e.launchedAt <= WELCOME_WINDOW_MS);
      // No price, no fuel check and no relay hold: none of them applies to a picture the client makes.
      const hint = pictureHint({ config, model: '', priceMicroUsdc: null, live: false, leftToday, affordable: null, postDue: !!inputs.schedule?.due && !inputs.schedule?.held, digestDue: !!inputs.digest, newLaunch, lastImageAgoMs: lastAt === null ? null : now - lastAt, held: false, creatorAsked: inputs.creatorAsked === true });
      return { picture: ownPictureHint(hint, imageStyleOf(config)) };
    }
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
    const hint = pictureHint({ config, model, priceMicroUsdc: price?.microUsdc ?? null, live: price?.live ?? false, leftToday, affordable, postDue: !!inputs.schedule?.due && !inputs.schedule?.held, digestDue: !!inputs.digest, newLaunch, lastImageAgoMs: lastAt === null ? null : now - lastAt, held: hold !== null, creatorAsked: inputs.creatorAsked === true });
    return { picture: hint };
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err }, 'picture hint failed; turn goes on without the section');
    return {};
  }
}
