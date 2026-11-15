/**
 * Posts of an execution account the dataset read (the security review of 2026-11-15, finding M4). @bankrbot and
 * @clanker_world are read sources of layer c (x-sources.ts): what they announce is news. But they act on what they are
 * tagged in or linked to, and on X a link to a post quotes it and notifies its author as an @ does. A record built from
 * their post carried `https://x.com/i/status/<id>` (x-build.ts `xPostLink`), a link that does not show whose post it is,
 * so the gate could not see it was theirs.
 *
 * Two things close it:
 *  - a record's link that one of these accounts gave it is not served (serve.ts `recordsFor`, by `executionSource`);
 *  - before a send, the ids of the X posts the text links are looked up among the sightings of these accounts, and
 *    one found is refused by the gate's own rule (agent-core `executionPostFinding`, the same code and words as a link
 *    to the account itself).
 *
 * Why the sightings are enough, with no table of their own: a link reaches an agent from the dataset only as a record's
 * link, and a record's link is always one of its sightings' links. A sighting of an X post lives 30 days, or until X
 * no longer shows the post (a link to a post that is gone quotes nothing and notifies nobody). Its id is the hash of the
 * source and the post id (store.ts `sightingIdOf`), so the lookup is by primary key: one read of the few layer-c source
 * rows and one of at most a few dozen keys, and only for a text that links a post on X at all.
 */
import { executionAccount, executionPostFinding, gateRefusal, xStatusIds } from '@bootr/agent-core';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { dsSightings, dsSources } from '../db/schema.js';
import { sightingIdOf } from './store.js';
import { xSourceId } from './x-build.js';

/** Post ids looked up for one send at most: a text links a handful of posts. */
const IDS_MAX = 20;

/** Whether a source row is an execution account's on X (its pinned handle, or the handle of a row not pinned yet). */
export function executionSource(row: { id: string; xHandle?: string | null }): boolean {
  const handle = row.xHandle ?? (row.id.startsWith('x:@') ? row.id.slice(3) : null);
  return !!handle && executionAccount(handle);
}

/** Of the X posts `texts` link, the ids the dataset read from an execution account. */
export async function executionPostIds(ctx: { db: Db }, texts: readonly string[]): Promise<string[]> {
  const ids = [...new Set(texts.flatMap((t) => xStatusIds(t)))].slice(0, IDS_MAX);
  if (!ids.length) return [];
  const rows = await ctx.db.select({ id: dsSources.id, xHandle: dsSources.xHandle, xUserId: dsSources.xUserId }).from(dsSources).where(and(eq(dsSources.layer, 'c'), isNotNull(dsSources.xUserId)));
  const keys = rows.filter(executionSource).flatMap((s) => ids.map((id) => sightingIdOf(xSourceId(s.xUserId!), id)));
  if (!keys.length) return [];
  const seen = await ctx.db.select({ externalId: dsSightings.externalId }).from(dsSightings).where(inArray(dsSightings.id, keys));
  return [...new Set(seen.map((r) => r.externalId))];
}

/**
 * The refusal of a send whose text (or one part of a thread) links a post the dataset read from an execution account,
 * in the gate's words; null when it links none.
 */
export async function executionPostRefusal(ctx: { db: Db }, texts: readonly string[]): Promise<string | null> {
  const known = await executionPostIds(ctx, texts);
  if (!known.length) return null;
  for (const [i, text] of texts.entries()) {
    const finding = executionPostFinding(text, known);
    if (finding) return texts.length > 1 ? gateRefusal(finding).replace(/^([a-z_]+): /, `$1: part ${i + 1} of the thread: `) : gateRefusal(finding);
  }
  return null;
}
