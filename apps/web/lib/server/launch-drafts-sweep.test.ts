import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countDrafts, DRAFT_TTL_S, MAX_DRAFTS, saveDraftIdentity, sweepDrafts } from './launch-drafts';

/**
 * Drafts used to live for ever: one file per launch draft id, never pruned, no cap. The store now holds at most
 * MAX_DRAFTS and a sweep removes drafts that never launched a day after their last write, only on a definite no
 * from the indexer: a launched coin's agent card and contract URI read its draft for good.
 */

const TEXT = 'A patient onchain analyst for small Base coins. Short, plain, no hype.';
const ids = ['0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f', '3b241101-e2bb-4255-8caf-4136c566a962', '7c9e6679-7425-40de-944b-e07fc1f90ae7', 'd9428888-122b-4f15-8f38-3c4a2a9d4c15'] as const;
const NOW = 1_800_000_000;

describe('sweepDrafts', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bootr-draft-sweep-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes a draft and dates its file `ageS` seconds before NOW. */
  async function draft(id: string, ageS: number) {
    const saved = await saveDraftIdentity(id, TEXT, null, { dir, now: NOW - ageS });
    if (!saved.ok) throw new Error('save failed');
    const at = new Date((NOW - ageS) * 1000);
    await utimes(path.join(dir, `${id}.json`), at, at);
  }

  it('removes a stale draft no coin carries, keeps a launched one and a fresh one, and stale temp files go too', async () => {
    const [stale, launched, fresh, other] = ids;
    await draft(stale, DRAFT_TTL_S + 60);
    await draft(launched, 3 * DRAFT_TTL_S);
    await draft(fresh, DRAFT_TTL_S - 60);
    await draft(other, DRAFT_TTL_S + 1);
    const tmp = path.join(dir, `${stale}.json.123.abcd.tmp`);
    await writeFile(tmp, '{}');
    await utimes(tmp, new Date((NOW - 2 * 3600) * 1000), new Date((NOW - 2 * 3600) * 1000));
    const asked: string[] = [];
    const result = await sweepDrafts(
      async (id) => {
        asked.push(id);
        return id === launched;
      },
      { dir, now: NOW },
    );
    expect(result.stopped).toBe(false);
    expect(result.checked).toBe(3); // the fresh one is not looked up
    expect(asked.sort()).toEqual([stale, launched, other].sort());
    expect(result.removed.sort()).toEqual([stale, other, path.basename(tmp)].sort());
    expect((await readdir(dir)).sort()).toEqual([`${fresh}.json`, `${launched}.json`].sort());
  });

  it('stops and keeps everything when the indexer cannot say, and looks up at most `limit` drafts a sweep', async () => {
    for (const id of ids) await draft(id, DRAFT_TTL_S + 60);
    const unknown = await sweepDrafts(async () => null, { dir, now: NOW });
    expect(unknown).toEqual({ removed: [], checked: 1, stopped: true });
    const thrown = await sweepDrafts(async () => Promise.reject(new Error('indexer down')), { dir, now: NOW });
    expect(thrown.stopped).toBe(true);
    expect(await countDrafts({ dir })).toBe(4);
    const limited = await sweepDrafts(async () => false, { dir, now: NOW, limit: 2 });
    expect(limited.checked).toBe(2);
    expect(limited.removed).toHaveLength(2);
    expect(await countDrafts({ dir })).toBe(2);
  });

  it('refuses a new draft id once the store is at its cap, and still lets an existing draft be updated', async () => {
    expect(MAX_DRAFTS).toBe(5000);
    const [a, b, c] = ids;
    const first = await saveDraftIdentity(a, TEXT, null, { dir, now: NOW, cap: 2 });
    expect(first.ok).toBe(true);
    expect((await saveDraftIdentity(b, TEXT, null, { dir, now: NOW, cap: 2 })).ok).toBe(true);
    expect(await saveDraftIdentity(c, TEXT, null, { dir, now: NOW, cap: 2 })).toEqual({ ok: false, reason: 'full' });
    if (!first.ok) throw new Error('unreachable');
    expect((await saveDraftIdentity(a, 'The owner changed their mind about the persona.', first.ownerTag, { dir, now: NOW + 1, cap: 2 })).ok).toBe(true);
    expect(await countDrafts({ dir })).toBe(2);
    expect(await countDrafts({ dir: path.join(dir, 'missing') })).toBe(0);
  });
});
