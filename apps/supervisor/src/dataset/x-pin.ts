/**
 * How a listed X account gets its id, keeps it and loses it (docs/design/agent-behaviour.md section 6.4, "Sources are
 * held by user id, not by handle"). An account is read by its X user id; the handle in x-sources.ts is a label. On
 * 2026-11-14 the handles @l2beat, @a16zcrypto and @MessariCrypto belonged to strangers with 7, 0 and 535 followers, so
 * an id is only ever trusted after a comparison with the note's row, and stops being trusted when the account changes.
 *
 * A row of `sv_ds_sources` for an X account (`layer = 'c'`) goes through these states:
 *
 *   pending     listed, id not known yet. Its row id is `x:@<handle>`. Nothing is read.
 *   active      its id is pinned: the row id is `x:<user id>`, and reads go to that id.
 *   suspended   a person must look. Nothing is read; the reason is on the row and in the owner's panel.
 *   review      the owner asked for another look (the panel's button): one user read, then active or suspended again.
 *   retired     its handle left x-sources.ts.
 *
 * THE FIRST LOOKUP (`judgeFirstLook`): one user read by handle through the sender (0.01 USD). The id X answers with is
 * pinned only when all of these hold, and otherwise the row is suspended with the reason and no id is kept:
 *   1. X has an account with this handle;
 *   2. X spells the handle exactly as the note does, letter for letter (the note recorded the handle as X spelled it);
 *   3. the account is not protected;
 *   4. it has at least FLOOR_SHARE (half) of the followers the note saw on 2026-11-14.
 * A stranger who took a known name has a handful of followers; no account on the list had fewer than 11,500.
 *
 * THE LOOK AT A PINNED ACCOUNT (`judgeLook`): one user read BY ID every X_LOOK_EVERY_MS (a week), a few accounts a day.
 * The account is suspended when X no longer has it, when its handle changed (a change of capitals only is noted, not
 * punished), when it turned protected, or when its followers fell under COLLAPSE_SHARE (half) of the most it ever had
 * while pinned. An account that is gone or protected also has every sighting of it removed (x-text.ts rule 5).
 *
 * WHAT THE OWNER SEES AND DOES. The panel lists every suspended account with its reason. "Look again" (`review`) is
 * for a false alarm: the account is read once more and must pass the first lookup's four checks against the note's
 * row, as if it were new. A real change (the organisation moved to another handle) is fixed by a commit to
 * x-sources.ts and the note, never by a button.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { dsSources } from '../db/schema.js';
import type { XUser } from './sender-x.js';
import type { SourceRow } from './store.js';
import { sinceIdAt, xSourceId, xSourceName } from './x-build.js';
import { followersOf, listedKey, X_SOURCE_BY_KEY, X_SOURCES, type XSource } from './x-sources.js';

export const FLOOR_SHARE = 0.5;
export const COLLAPSE_SHARE = 0.5;
export const X_LOOK_EVERY_MS = 7 * 86_400_000;
/** How far back the first read of a freshly pinned account goes. */
export const X_FIRST_READ_BACK_MS = 24 * 3_600_000;
const HANDLE = /^\w{1,15}$/;

/** What a layer c row keeps between passes (`sv_ds_sources.state`). */
export interface XState {
  /** The handle the account is listed under in x-sources.ts, in lowercase: what joins a row to the file. */
  listed: string;
  /** What X said when the id was pinned. */
  pinned?: { handle: string; followers: number; at: string };
  /** The most followers seen while pinned: what a collapse is measured against. */
  followersHigh?: number;
  followers?: number;
  /** When the account was last looked at (a user read). */
  lookedAt?: string;
  /** The newest post id seen: the next read asks for posts above it. It never moves backwards. */
  sinceId?: string;
  /** Posts read per UTC day, the last eight days: how often the account posts. */
  days?: Record<string, number>;
  /** Reads in which X had more new posts than one page. */
  truncated?: number;
}

export const stateOf = (row: Pick<SourceRow, 'state'>): XState => {
  const s = (row.state ?? {}) as Partial<XState>;
  return { ...s, listed: typeof s.listed === 'string' ? s.listed : '' };
};

export const pendingId = (handle: string): string => `x:@${listedKey(handle)}`;
const figure = (n: number): string => n.toLocaleString('en-US');

/** The floor a first lookup compares against: half of the note's figure. */
export function followerFloor(listed: XSource): number {
  return Math.floor((followersOf(listed.followers) ?? Number.POSITIVE_INFINITY) * FLOOR_SHARE);
}

export type Verdict = { ok: true; handle: string; followers: number } | { ok: false; reason: string; /** The account is gone or protected: what was stored of it goes too. */ gone?: boolean };

/** The first lookup: is the account X answers with the one the note opened on 2026-11-14? */
export function judgeFirstLook(listed: XSource, user: XUser | null): Verdict {
  if (!user) return { ok: false, reason: `X has no account with the handle ${listed.handle}` };
  if (!HANDLE.test(user.username)) return { ok: false, reason: 'X answered with a handle that is not one' };
  if (user.username !== listed.handle) return { ok: false, reason: `X spells the handle ${user.username}; the note has ${listed.handle}` };
  if (user.protected) return { ok: false, reason: 'the account is protected', gone: true };
  const floor = followerFloor(listed);
  if (user.followers === null) return { ok: false, reason: 'X did not say how many followers the account has' };
  if (user.followers < floor) return { ok: false, reason: `${figure(user.followers)} followers; the note saw ${listed.followers} on 2026-11-14 and the floor is ${figure(floor)}` };
  return { ok: true, handle: user.username, followers: user.followers };
}

/** The look at a pinned account: is it still the account that was pinned? `handle` is how X spells it now. */
export function judgeLook(state: XState, user: XUser | null): Verdict {
  const was = state.pinned?.handle ?? state.listed;
  if (!user) return { ok: false, reason: 'X no longer has this account', gone: true };
  if (!HANDLE.test(user.username)) return { ok: false, reason: 'X answered with a handle that is not one' };
  if (user.username.toLowerCase() !== was.toLowerCase()) return { ok: false, reason: `its handle changed from ${was} to ${user.username}` };
  if (user.protected) return { ok: false, reason: 'the account turned protected', gone: true };
  if (user.followers === null) return { ok: false, reason: 'X did not say how many followers the account has' };
  const high = Math.max(state.followersHigh ?? 0, state.pinned?.followers ?? 0);
  if (high > 0 && user.followers < high * COLLAPSE_SHARE) return { ok: false, reason: `its followers fell from ${figure(high)} to ${figure(user.followers)}` };
  return { ok: true, handle: user.username, followers: user.followers };
}

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

const columnsOf = (listed: XSource) => ({ layer: 'c', kind: 'x', cluster: listed.cluster as string, groupId: listed.group, officialFor: [...listed.officialFor], tier: listed.tier });

/**
 * Brings the layer c rows in line with x-sources.ts: a newly listed account gets a `pending` row, a listed one its
 * cluster, group and what it is official for as the file now has them, and a row whose handle left the file is
 * `retired`. A pinned id, a suspension and everything a row remembers are never touched here. Reads nothing from X and
 * costs nothing, so it runs with the layer on or off: the owner sees the list before the first cent is spent.
 */
export async function syncXSources(db: Db, now: Date): Promise<{ added: number; retired: number }> {
  const rows = await db.select().from(dsSources).where(eq(dsSources.layer, 'c'));
  const byListed = new Map(rows.map((r) => [stateOf(r).listed, r]));
  let added = 0;
  for (const listed of X_SOURCES) {
    const key = listedKey(listed.handle);
    const row = byListed.get(key);
    if (!row) {
      await db
        .insert(dsSources)
        .values({ id: pendingId(listed.handle), ...columnsOf(listed), name: xSourceName(listed.handle), url: null, xUserId: null, xHandle: listed.handle, status: 'pending', statusReason: 'listed; its id is looked up at the first read', state: { listed: key }, createdAt: now, updatedAt: now })
        .onConflictDoNothing();
      added++;
    } else {
      // Back in the list: an account whose id is still pinned reads again, one without an id is looked up again.
      const status = row.status === 'retired' ? (row.xUserId ? 'active' : 'pending') : row.status;
      await db
        .update(dsSources)
        .set({ ...columnsOf(listed), status, ...(status !== row.status ? { statusReason: null } : {}), updatedAt: now })
        .where(eq(dsSources.id, row.id));
    }
  }
  const gone = rows.filter((r) => !X_SOURCE_BY_KEY.has(stateOf(r).listed) && r.status !== 'retired').map((r) => r.id);
  if (gone.length) await db.update(dsSources).set({ status: 'retired', statusReason: 'left the source list', updatedAt: now }).where(inArray(dsSources.id, gone));
  return { added, retired: gone.length };
}

/** The listed account a row stands for, or null when it left the file. */
export const listedOf = (row: Pick<SourceRow, 'state'>): XSource | null => X_SOURCE_BY_KEY.get(stateOf(row).listed) ?? null;

export async function suspendX(db: Db, id: string, reason: string, now: Date): Promise<void> {
  await db.update(dsSources).set({ status: 'suspended', statusReason: reason.slice(0, 300), nextFetchAt: null, updatedAt: now }).where(eq(dsSources.id, id));
}

/**
 * Pins the id X answered with: the row becomes `x:<user id>`, active, and remembers what X said. A row that had another
 * id (a pending row, or the same account pinned before) is replaced in one transaction. Returns the new row id, or
 * null when that id is already pinned under another listed handle (two rows of the file, one account): the row is
 * suspended instead.
 */
export async function pinX(db: Db, row: SourceRow, listed: XSource, user: { id: string; handle: string; followers: number }, now: Date): Promise<string | null> {
  const id = xSourceId(user.id);
  const key = listedKey(listed.handle);
  const [taken] = await db.select({ id: dsSources.id, state: dsSources.state, status: dsSources.status }).from(dsSources).where(eq(dsSources.xUserId, user.id)).limit(1);
  if (taken && taken.id !== row.id && taken.status !== 'retired' && stateOf(taken).listed !== key) {
    await suspendX(db, row.id, `X answers with an account that is already pinned as ${stateOf(taken).listed}`, now);
    return null;
  }
  const before = stateOf(row);
  const kept = taken ? stateOf(taken) : before;
  const state: XState = {
    listed: key,
    pinned: { handle: user.handle, followers: user.followers, at: now.toISOString() },
    followersHigh: user.followers,
    followers: user.followers,
    lookedAt: now.toISOString(),
    // An account that was read before goes on from where it was; a new one starts a day back.
    sinceId: kept.sinceId ?? sinceIdAt(new Date(now.getTime() - X_FIRST_READ_BACK_MS)),
    ...(kept.days ? { days: kept.days } : {}),
  };
  const values = { ...columnsOf(listed), name: xSourceName(user.handle), url: `https://x.com/i/user/${user.id}`, xUserId: user.id, xHandle: user.handle, status: 'active', statusReason: null, state: state as unknown as Record<string, unknown>, failures: 0, lastError: null, nextFetchAt: null, updatedAt: now };
  await db.transaction(async (tx) => {
    if (row.id !== id) await tx.delete(dsSources).where(eq(dsSources.id, row.id));
    await tx
      .insert(dsSources)
      .values({ id, ...values, createdAt: row.createdAt })
      .onConflictDoUpdate({ target: dsSources.id, set: values });
  });
  return id;
}

/** What a passed look writes: the follower count, the highest seen, the time, and the handle's capitals as X has them now. */
export async function notedLook(db: Db, row: SourceRow, seen: { handle: string; followers: number }, now: Date): Promise<void> {
  const state = stateOf(row);
  const next: XState = { ...state, followers: seen.followers, followersHigh: Math.max(state.followersHigh ?? 0, seen.followers), lookedAt: now.toISOString() };
  await db
    .update(dsSources)
    .set({ xHandle: seen.handle, name: xSourceName(seen.handle), state: next as unknown as Record<string, unknown>, updatedAt: now })
    .where(eq(dsSources.id, row.id));
}

/**
 * The owner's "look again": a suspended X account goes to `review`, and the dataset process reads it once more at its
 * next pass. One statement, so the supervisor's API (which only ever reads the dataset otherwise) cannot overwrite
 * what the dataset process keeps on the row. False when the row is not a suspended X account.
 */
export async function askReview(db: Db, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(dsSources)
    .set({ status: 'review', updatedAt: now })
    .where(and(eq(dsSources.id, id), eq(dsSources.layer, 'c'), eq(dsSources.status, 'suspended'), sql`${dsSources.state} ->> 'listed' is not null`))
    .returning({ id: dsSources.id });
  return rows.length > 0;
}
