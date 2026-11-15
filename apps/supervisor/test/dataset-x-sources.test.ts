/**
 * The X source list (src/dataset/x-sources.ts) against the note it was taken from: every tier 1 row of
 * docs/design/agent-behaviour.md section 6.6, with its handle, its "Official for", its group and its follower figure
 * exactly as the table has them. No handle in the file may come from anywhere else: 18 of 175 handles written from
 * memory were wrong, and three belonged to strangers.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DATASET_X_HANDLES } from '@bootr/agent-core';
import { ENTITIES } from '../src/dataset/entities.js';
import { OPEN_SOURCES } from '../src/dataset/sources.js';
import { CLUSTERS } from '../src/dataset/types.js';
import { followerFloor } from '../src/dataset/x-pin.js';
import { followersOf, X_SOURCES } from '../src/dataset/x-sources.js';

const NOTE = readFileSync(fileURLToPath(new URL('../../../docs/design/agent-behaviour.md', import.meta.url)), 'utf8');

/** The rows of section 6.6's tables, read by their header: handle, official for, group, followers, tier. */
function noteRows(): { handle: string; officialFor: string; group: string; followers: string; tier: string }[] {
  const section = NOTE.slice(NOTE.indexOf('### 6.6 The wide list: X accounts'), NOTE.indexOf('### 6.7'));
  const rows: { handle: string; officialFor: string; group: string; followers: string; tier: string }[] = [];
  let header: string[] | null = null;
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells[0] === 'Handle') {
      header = cells;
      continue;
    }
    if (!header || /^-+$/.test(cells[0] ?? '')) continue;
    const at = (name: string) => (header!.includes(name) ? cells[header!.indexOf(name)]! : null);
    rows.push({ handle: cells[0]!.replace(/^@/, ''), officialFor: at('Official for') ?? '', group: at('Group') ?? '–', followers: at('Followers') ?? '', tier: at('T') ?? '' });
  }
  return rows;
}

describe('the X source list', () => {
  const tier1 = noteRows().filter((r) => r.tier === '1');

  it("is the same list, handle for handle, as the one the sender's dataset door reads and nothing else (agent-core)", () => {
    expect(X_SOURCES.map((s) => s.handle)).toEqual([...DATASET_X_HANDLES]);
  });

  it('holds the 41 tier 1 rows of the note and nothing else', () => {
    expect(tier1).toHaveLength(41);
    expect(X_SOURCES.map((s) => s.handle).sort()).toEqual(tier1.map((r) => r.handle).sort());
  });

  it('takes each handle, follower figure, group and "official for" cell exactly as the note wrote it', () => {
    for (const r of tier1) {
      const s = X_SOURCES.find((x) => x.handle === r.handle)!;
      expect({ handle: s.handle, followers: s.followers, group: s.noteGroup, officialFor: s.noteOfficialFor }).toEqual({ handle: r.handle, followers: r.followers, group: r.group, officialFor: r.officialFor });
    }
  });

  it('has a follower floor for every row, and the floor is far above what the strangers holding known names had', () => {
    for (const s of X_SOURCES) {
      expect(followersOf(s.followers)).toBeGreaterThan(0);
      // @l2beat, @a16zcrypto and @MessariCrypto had 7, 0 and 535 followers on 2026-11-14.
      expect(followerFloor(s)).toBeGreaterThan(535);
    }
    expect(followersOf('1.5M')).toBe(1_500_000);
    expect(followersOf('610.5K')).toBe(610_500);
    expect(followersOf('4,870')).toBe(4_870);
    expect(followersOf('lots')).toBeNull();
  });

  it('names only entities and clusters that exist, and makes no person official for anything', () => {
    const ids = new Set(ENTITIES.map((e) => e.id));
    for (const s of X_SOURCES) {
      for (const e of [...s.officialFor, ...s.entities]) expect(ids.has(e), `${s.handle}: ${e}`).toBe(true);
      expect(Object.keys(CLUSTERS)).toContain(s.cluster);
      if (s.person) expect(s.officialFor).toEqual([]);
      if (/\(person\)/.test(s.noteOfficialFor)) expect(s.person).toBe(true);
      expect(s.tier).toBe(1);
    }
  });

  it("puts an account in the same group as the same organisation's listed pages, so the two are never independent", () => {
    // The note's short group names are the ids sources.ts uses, except two spelled out there.
    const renamed: Record<string, string> = { ef: 'ethereum-foundation', llama: 'defillama' };
    const pageGroups = new Set(OPEN_SOURCES.map((s) => s.group));
    for (const s of X_SOURCES) {
      if (s.noteGroup !== '–') expect(s.group).toBe(renamed[s.noteGroup] ?? s.noteGroup);
      for (const e of s.officialFor) {
        const page = OPEN_SOURCES.find((p) => !p.open && p.officialFor.includes(e));
        if (page) expect(s.group, `${s.handle} and ${page.id}`).toBe(page.group);
      }
    }
    expect(pageGroups.has('coinbase')).toBe(true);
  });
});
