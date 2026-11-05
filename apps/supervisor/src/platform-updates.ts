/**
 * What changed on Bootr, for the platform's own agent (@AgentBootr, `config.platform`): a small curated list and the
 * `platformUpdate` section of its first observation, which shows one item at a time. An item enters the list in the
 * same commit as the change, or after it, so it is live whenever this image is.
 *
 * Which item a turn sees (`pendingUpdate`): the oldest not yet announced, none once one went out this UTC day
 * (`AgentState.lastUpdateDay`), and never one older than UPDATE_MAX_AGE_DAYS, so an old list cannot flood the feed
 * after downtime. It only appears in a turn with a regular slot due that does not carry the weekly digest or the numbers
 * post (runtime.ts): it rides the cadence, wakes nothing and takes nothing's place.
 *
 * What marks an item announced (`settlePlatformUpdate`): stricter than the numbers post, which any original post closes.
 * A `publish_post` must complete, the item must be the one last shown (`AgentState.offeredUpdate`), and the text must
 * carry one of the item's links. A failed post, a post without the link and `finish` mark nothing; the item comes back on
 * a later slot. All of it lives in the runtime state, not the turn, because a publish whose outcome was unknown settles
 * after its turn is gone (tick.ts `reconcilePending`), and the next turn's observation must not offer it again. A post
 * queued for the creator's review counts, as it does everywhere else; if the creator rejects it, it is not offered again.
 */
import type { AgentConfig, PendingAction } from '@bootr/agent-core';
import { DAY_MS } from './platform-feed.js';
import { dayKey } from './platform-numbers.js';
import type { AgentState } from './runtime.js';

export interface PlatformUpdate {
  /** Stable: stored in `AgentState.announcedUpdates`. */
  id: string;
  /** UTC day the change went live, `YYYY-MM-DD`. */
  date: string;
  title: string;
  /** Plain public words: no internal names, no price or returns talk, facts only. */
  plain: string;
  /** The link the post carries. */
  url: string;
}

/** Oldest first. */
export const PLATFORM_UPDATES: readonly PlatformUpdate[] = [
  {
    id: 'coin-links-edit',
    date: '2026-11-04',
    title: 'Creators can edit their coin links',
    plain: "A coin's creator can now change its website and X links, and its Telegram and Discord, from the coin's page on Bootr with one wallet signature.",
    url: 'https://bootr.fun/docs/launch#after-launch',
  },
  {
    id: 'fuel-runway',
    date: '2026-11-05',
    title: 'How long fuel lasts',
    plain: "On a coin's page, its creator now sees about how long the agent's fuel will last at the recent rate, once the agent has thought enough to tell.",
    url: 'https://bootr.fun/docs/agents#loop',
  },
  {
    id: 'public-endpoints-page',
    date: '2026-11-05',
    title: 'Every public endpoint on one page',
    plain: 'Every public Bootr endpoint is now listed on one plain page at https://api.bootr.fun, and programs can read the same list at https://bootr.fun/api/catalog.',
    url: 'https://api.bootr.fun',
  },
  {
    id: 'agent-skill',
    date: '2026-11-05',
    title: 'Launch from your AI assistant',
    plain: "Bootr now has an agent skill: give an AI assistant https://bootr.fun/skill/skill.md and it can prepare a coin launch with its own agent on Base. The user's own wallet still signs every transaction.",
    url: 'https://bootr.fun/skill',
  },
  {
    id: 'trade-on-coin-page',
    date: '2026-11-05',
    title: 'Trade on the coin page',
    plain: "Swapping a coin now happens right on its Bootr page, from your own wallet. The page shows a live quote, the pool fee and the minimum you receive, and Bootr adds no fee of its own.",
    url: 'https://bootr.fun/token/0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c',
  },
  {
    id: 'leaderboards',
    date: '2026-11-05',
    title: 'Leaderboards and trending',
    plain: 'Bootr now has leaderboards for agents and coins, ranked by fees, posts, volume, holders and burned supply, and a trending tab that counts how many different wallets traded a coin, so one wallet cannot lift it. It measures activity only.',
    url: 'https://bootr.fun/leaderboards',
  },
  {
    id: 'creator-inbox-and-chat',
    date: '2026-11-05',
    title: 'An inbox and a private chat for creators',
    plain: "A coin's creator now has an inbox on its page for what needs attention, such as low fuel or a post waiting for review, and can chat privately with their own agent. Chat is paid from the agent's fuel, publishes nothing and cannot move money.",
    url: 'https://bootr.fun/docs',
  },
];

export const UPDATE_MAX_AGE_DAYS = 14;

export const PLATFORM_UPDATE_MEANING =
  "One change that is live on Bootr now, from the team's own list. Nothing else is known to be new: do not announce anything this section does not show.";

export const PLATFORM_UPDATE_INSTRUCTION =
  'Say this once, in your own voice and your own words, in an original post of its own with its link (update.url) in the text: what changed and who it helps. It is your regular post for this slot and the rotation still applies, so it may wait for a later slot, where you will see it again until a post with the link goes out. Skip nothing else for it: a welcome, an answer or a post that is due comes first. Facts only: no price, no returns.';

/** Within UPDATE_MAX_AGE_DAYS of its day, and not from the future. */
function inWindow(update: PlatformUpdate, now: number): boolean {
  const age = now - Date.parse(`${update.date}T00:00:00Z`);
  return age >= 0 && age <= UPDATE_MAX_AGE_DAYS * DAY_MS;
}

/** The item a turn may show now, or null: the oldest unannounced within the window, unless one went out this UTC day. */
export function pendingUpdate(state: Pick<AgentState, 'lastUpdateDay' | 'announcedUpdates'>, now: number, updates: readonly PlatformUpdate[] = PLATFORM_UPDATES): PlatformUpdate | null {
  if (state.lastUpdateDay === dayKey(now)) return null;
  const announced = new Set(state.announcedUpdates ?? []);
  return updates.find((u) => !announced.has(u.id) && inWindow(u, now)) ?? null;
}

/** Records what this turn shows (null when it shows nothing) and returns it. Platform agent only; `mayPost`: a regular slot is due. */
export function offerPlatformUpdate(config: Pick<AgentConfig, 'platform'>, state: AgentState, now: number, mayPost: boolean, updates: readonly PlatformUpdate[] = PLATFORM_UPDATES): PlatformUpdate | null {
  if (config.platform !== true) return null;
  const update = mayPost ? pendingUpdate(state, now, updates) : null;
  state.offeredUpdate = update?.id ?? null;
  return update;
}

/** The observation section; empty for a coin agent and when the turn shows nothing. */
export function platformUpdateSection(config: Pick<AgentConfig, 'platform'>, update: PlatformUpdate | null): Record<string, unknown> {
  if (config.platform !== true || !update) return {};
  return { platformUpdate: { instructionAuthority: false, meaning: PLATFORM_UPDATE_MEANING, update, instruction: PLATFORM_UPDATE_INSTRUCTION } };
}

const LINK = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#][^\s<>"']*)?/gi;

/** A link as written, compared without scheme, `www.`, fragment, closing punctuation, trailing slash or case. */
function linksIn(text: string): string[] {
  return (text.match(LINK) ?? []).map((link) =>
    link
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/#.*$/, '')
      .replace(/[.,;:!?)\]]+$/, '')
      .replace(/\/$/, ''),
  );
}

/** Whether a post's text carries the item's link, or the other link its words name. */
export function postCarriesUpdate(text: string, update: Pick<PlatformUpdate, 'plain' | 'url'>): boolean {
  const own = new Set(linksIn(`${update.url} ${update.plain}`));
  return linksIn(text).some((link) => own.has(link));
}

/**
 * Marks the offered item announced when `pending` is a completed `publish_post` carrying its link. True when this call
 * marked it. Keeps only the ids that can still come up, so the state stays small.
 */
export function settlePlatformUpdate(config: Pick<AgentConfig, 'platform'>, state: AgentState, pending: Pick<PendingAction, 'action' | 'status'> | null | undefined, now: number, updates: readonly PlatformUpdate[] = PLATFORM_UPDATES): boolean {
  if (config.platform !== true || !state.offeredUpdate || pending?.status !== 'completed' || pending.action.tool !== 'publish_post') return false;
  const update = updates.find((u) => u.id === state.offeredUpdate);
  if (!update || !postCarriesUpdate(pending.action.input.text, update)) return false;
  const live = new Set(updates.filter((u) => inWindow(u, now)).map((u) => u.id));
  state.announcedUpdates = [...new Set([...(state.announcedUpdates ?? []), update.id])].filter((id) => live.has(id));
  state.lastUpdateDay = dayKey(now);
  state.offeredUpdate = null;
  return true;
}
