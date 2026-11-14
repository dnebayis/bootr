/**
 * The checked-in source list (src/dataset/sources.ts) against the note's section 6.7: all 72 rows, each with a group
 * and a reader that exists, official only for entities of the entity list, and a schedule whose cost is known.
 */
import { describe, expect, it } from 'vitest';
import { ENTITIES, ENTITY_IDS } from '../src/dataset/entities.js';
import { isJsonReader } from '../src/dataset/readers/json.js';
import { CHAIN_SOURCES, LINK_HOSTS, OPEN_SOURCES } from '../src/dataset/sources.js';
import { CLUSTERS, RECORD_KINDS } from '../src/dataset/types.js';

describe('the open sources of section 6.7', () => {
  it('lists every row of the note once, by number and by id', () => {
    expect(OPEN_SOURCES.map((s) => s.n)).toEqual(Array.from({ length: 72 }, (_, i) => i + 1));
    expect(new Set(OPEN_SOURCES.map((s) => s.id)).size).toBe(72);
    expect(new Set(OPEN_SOURCES.map((s) => s.url)).size).toBe(72);
    for (const s of OPEN_SOURCES) {
      expect(s.id, s.name).toMatch(/^b:[a-z0-9-]+$/);
      expect(new URL(s.url).protocol, s.name).toBe('https:');
      expect(s.group, s.name).toMatch(/^[a-z0-9-]+$/);
      expect(Object.keys(CLUSTERS), s.name).toContain(s.cluster);
      expect(RECORD_KINDS, s.name).toContain(s.defaultKind);
      expect(s.maxBytes, s.name).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
  });

  it('reads 69 of them, each by a reader that exists, and says why it does not read the other three', () => {
    const read = OPEN_SOURCES.filter((s) => s.read);
    expect(read).toHaveLength(69);
    expect(OPEN_SOURCES.filter((s) => !s.read).map((s) => [s.n, !!s.reason])).toEqual([
      [9, true],
      [62, true],
      [72, true],
    ]);
    expect({ feed: read.filter((s) => s.kind === 'feed').length, json: read.filter((s) => s.kind === 'json').length, html: read.filter((s) => s.kind === 'html').length }).toEqual({ feed: 44, json: 9, html: 16 });
    for (const s of read) {
      if (s.kind === 'json') expect(isJsonReader(s.reader), s.name).toBe(true);
      if (s.kind === 'html') expect(['links', 'watch'], s.name).toContain(s.reader);
      if (s.kind === 'json' && s.defaultKind === 'metric') expect(s.page, s.name).toBeTruthy();
    }
  });

  it('a source is official only for entities of the list, a news desk for none, and a group counts once', () => {
    for (const s of [...OPEN_SOURCES, ...CHAIN_SOURCES]) {
      for (const e of s.officialFor) expect(ENTITY_IDS.has(e), `${s.name}: ${e}`).toBe(true);
      for (const e of ('entities' in s ? s.entities : undefined) ?? []) expect(ENTITY_IDS.has(e), `${s.name}: ${e}`).toBe(true);
    }
    expect(OPEN_SOURCES.filter((s) => s.cluster === 'news').every((s) => s.officialFor.length === 0 && s.needsTopic)).toBe(true);
    // Base's blog, docs, status page and node releases, the x402 repo and site, AgentKit and the CDP docs are one voice
    expect(OPEN_SOURCES.filter((s) => s.group === 'coinbase').map((s) => s.n)).toEqual([8, 10, 11, 12, 13, 15, 16, 17, 18]);
    expect(new Set(OPEN_SOURCES.filter((s) => s.cluster === 'news').map((s) => s.group)).size).toBe(8);
    expect(new Set(ENTITIES.map((e) => e.id)).size).toBe(ENTITIES.length);
  });

  it('the schedule: the home cluster every 15 minutes, the rest hourly, the JSON APIs every 6 hours, about 2,400 requests a day', () => {
    const read = OPEN_SOURCES.filter((s) => s.read);
    expect(read.filter((s) => s.kind === 'json').every((s) => s.everyMin === 360)).toBe(true);
    expect(read.filter((s) => s.kind !== 'json').every((s) => s.everyMin === 15 || s.everyMin === 60)).toBe(true);
    expect(read.find((s) => s.id === 'b:base-status')!.everyMin).toBe(15);
    expect(read.find((s) => s.id === 'b:coindesk')!.everyMin).toBe(60);
    const perDay = read.reduce((n, s) => n + (24 * 60) / s.everyMin, 0);
    expect(perDay).toBe(2412);
  });

  it('a link may only be on a host of the list', () => {
    for (const host of ['blog.base.org', 'base-l2.statuspage.io', 'github.com', 'defillama.com', 'l2beat.com', 'sec.gov', 'www.sec.gov', 'bootr.fun']) expect(LINK_HOSTS.has(host), host).toBe(true);
    for (const host of ['x.com', 'twitter.com', 't.co', 'bit.ly', 'evil.example', 'localhost']) expect(LINK_HOSTS.has(host), host).toBe(false);
  });
});
