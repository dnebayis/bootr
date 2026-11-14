/** Shared pieces of the dataset tests: fixture sightings built through the real cleaning path, and a quiet log. */
import { buildSighting, type RawItem } from '../src/dataset/build.js';
import { SOURCE_BY_ID, type OpenSource } from '../src/dataset/sources.js';
import type { SourceInfo } from '../src/dataset/store.js';
import type { Sighting } from '../src/dataset/types.js';

export const NOW = new Date('2026-11-15T12:00:00Z');
export const H = 3_600_000;
export const D = 24 * H;
export const quietLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function source(id: string): OpenSource {
  const s = SOURCE_BY_ID.get(id);
  if (!s) throw new Error(`no such source: ${id}`);
  return s;
}

export function infoOf(id: string): SourceInfo {
  const s = source(id);
  return { id: s.id, name: s.name, cluster: s.cluster, group: s.group, officialFor: s.officialFor };
}

/** A sighting of `sourceId` as the readers would build it; throws when the item would have been dropped. */
export function sighting(sourceId: string, item: Partial<RawItem> & { title: string }, now: Date = NOW): Sighting {
  const built = buildSighting(source(sourceId), { id: item.id ?? item.link ?? item.title, published: now.toISOString(), ...item }, now);
  if (!('sighting' in built)) throw new Error(`dropped (${built.dropped}): ${item.title}`);
  return built.sighting;
}
