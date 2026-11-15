/**
 * What the X layer may spend in a day, and how the day is shared out (docs/design/agent-behaviour.md sections 6.4 and
 * 7). Pure: layer-c.ts asks these functions before every call it makes.
 *
 * The owner pays X for every read: 0.005 USD a post, 0.01 USD a user. So the day has a cap in UNITS of one post read:
 * a post returned is one unit, a post checked is one unit, a user read is two. `DATASET_X_POSTS_PER_DAY` is that cap.
 *
 *   0 (the default)   the layer is off: nothing is read, nothing is spent           0.00 USD a day
 *   250               what the owner starts with                                    1.25 USD a day at most
 *   700               the hard ceiling: a higher setting is 700                     3.50 USD a day at most
 *
 * The sender enforces the cap where the money is spent (apps/sender/src/dataset-x.ts: units are claimed before each
 * call). This file is the planner on the asking side, and holds the same ceiling again, so that neither side has to
 * trust the other's arithmetic.
 *
 * How the day is spread:
 *
 *  - Duties come first and are never paced: confirming that a post whose words are kept is still on X (x-text.ts), the
 *    first lookup of a listed account and the weekly look at a pinned one (x-pin.ts). What they will still need today
 *    is set aside (`reserve`) before any post is read.
 *  - Reading is paced: by any moment of the UTC day, no more posts have been read than that share of the day's reading
 *    budget, three hours ahead (X_PACE_HEAD_MS), so a loud morning cannot leave the evening unread.
 *  - Over the accounts by how often each posts: an account's share of the day is its measured posts a day (the mean of
 *    the full days seen, the note's estimate of 4 before any) times the weight of its cluster (home 3, near 2, far 1),
 *    as a part of the whole, never under X_SHARE_MIN and never over a quarter of the day. The share is also the most
 *    one account may add to the dataset in a day, so one account, flooded or taken over, cannot take the day.
 *  - A read asks X for no more posts than its account's share, the pace and the cap have left, and never for fewer
 *    than X_PAGE_MIN: X returns up to five whatever is asked, so with fewer than five units left nothing is read.
 */

export const X_UNIT_USD = 0.005;
export const X_HARD_CEILING = 700;
export const X_USER_READ_UNITS = 2;
/** X's smallest page: a read can return this many whatever is asked. */
export const X_PAGE_MIN = 5;
/** The most one read asks for: an account is read every 20 minutes, and ten originals in that time is a flood. */
export const X_PAGE_MAX = 10;
/** Posts a day an account is taken to write before a full day of it was seen: the note's estimate. */
export const X_DEFAULT_RATE = 4;
export const X_SHARE_MIN = 3;
export const X_SHARE_MAX_PART = 0.25;
export const X_PACE_HEAD_MS = 3 * 3_600_000;
export const DAY_MS = 86_400_000;

/** The cap in force for a setting: a whole number of units from 0 to the ceiling; anything else is 0, which is off. */
export function capOf(setting: unknown): number {
  const n = typeof setting === 'number' ? setting : typeof setting === 'string' && /^\d{1,6}$/.test(setting.trim()) ? Number(setting.trim()) : 0;
  return Number.isInteger(n) && n > 0 ? Math.min(n, X_HARD_CEILING) : 0;
}

/** What a day costs at the very most with this setting: every unit of the cap spent. */
export function worstDayUsd(setting: unknown): number {
  return Math.round(capOf(setting) * X_UNIT_USD * 100) / 100;
}

export const usdOf = (units: number): number => Math.round(Math.max(0, units) * X_UNIT_USD * 1000) / 1000;

/** How many posts a day an account writes: the mean of the full UTC days seen (today is not full), else the estimate. */
export function rateOf(days: Record<string, number> | undefined, today: string): number {
  const full = Object.entries(days ?? {}).filter(([day, n]) => day < today && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(n) && n >= 0);
  if (!full.length) return X_DEFAULT_RATE;
  return full.reduce((sum, [, n]) => sum + n, 0) / full.length;
}

/**
 * Each account's share of a day's reading budget, in posts. A quiet account still gets X_SHARE_MIN (it may have a day
 * that matters); no account gets more than a quarter of the day. The shares are ceilings, not promises: together they
 * may come to more than the budget, and the cap is what holds.
 */
export function sharesOf(accounts: readonly { id: string; weight: number; rate: number }[], budget: number): Map<string, number> {
  const out = new Map<string, number>();
  if (budget <= 0 || !accounts.length) return out;
  // A silent account weighs a little, so it is never shared out of the day altogether.
  const pull = (a: { weight: number; rate: number }) => Math.max(1, a.weight) * Math.max(0.25, a.rate);
  const total = accounts.reduce((sum, a) => sum + pull(a), 0);
  const most = Math.max(X_PAGE_MIN, Math.floor(budget * X_SHARE_MAX_PART));
  for (const a of accounts) out.set(a.id, Math.min(most, Math.max(X_SHARE_MIN, Math.round((budget * pull(a)) / total))));
  return out;
}

export interface DayState {
  /** The cap in force, already the smaller of the two sides' and never above the ceiling. */
  limit: number;
  /** Units spent today, every kind. */
  units: number;
  /** Posts read today. */
  posts: number;
  /** Units the day's duties will still need: set aside before any post is read. */
  reserve: number;
  /** Milliseconds since the UTC day began. */
  msIntoDay: number;
}

/** Posts that may still be read at this moment of the day: what the cap and the reserve leave, and what the pace has released. */
export function postsLeft(day: DayState): number {
  const limit = Math.min(Math.max(0, day.limit), X_HARD_CEILING);
  const left = limit - day.units - Math.max(0, day.reserve);
  const duties = Math.max(0, day.units - day.posts);
  const reading = Math.max(0, limit - duties - Math.max(0, day.reserve));
  const released = Math.floor(reading * Math.min(1, (Math.max(0, day.msIntoDay) + X_PACE_HEAD_MS) / DAY_MS));
  return Math.max(0, Math.min(left, released - day.posts));
}

/** What a duty may still spend: everything the cap has left. Duties are neither paced nor held back by the reserve. */
export function unitsLeft(day: Pick<DayState, 'limit' | 'units'>): number {
  return Math.max(0, Math.min(Math.max(0, day.limit), X_HARD_CEILING) - day.units);
}

/**
 * How many posts one read asks for: what the account's share and the day have left, between X_PAGE_MIN and
 * X_PAGE_MAX, or 0 when the read must not be made. A share with something left always allows one smallest page.
 */
export function askFor(shareLeft: number, dayLeft: number): number {
  if (shareLeft <= 0 || dayLeft < X_PAGE_MIN) return 0;
  return Math.min(X_PAGE_MAX, Math.max(X_PAGE_MIN, Math.floor(shareLeft)), Math.floor(dayLeft));
}
