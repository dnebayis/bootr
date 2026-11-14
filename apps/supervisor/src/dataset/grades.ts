/**
 * How a record is sourced, as one of five steps (docs/design/agent-behaviour.md section 6.4). A grade describes
 * sourcing, never truth: it counts who carried the event, not whether it happened.
 *
 *   1  a single source, however often it repeated itself
 *   2  repeated by a second source of the same group, with nothing cited
 *   3  two independent groups, or two sources and a cited outside page
 *   4  an official source of one of the record's entities
 *   5  an official source and two more independent groups
 *
 * "Independent" is counted by group, the organisation behind a source (sources.ts): the Base blog and the Base status
 * page are one voice. One source alone never passes grade 1 unless it is official for an entity of the record, so one
 * account, one feed or one desk cannot lift a record to where every agent would see it (the note's defence against a
 * poisoned record); what lifts it is an official source or a second group, and both lists change only by a commit.
 */
import type { EventPrecision, Grade, RecordKind, RecordSource } from './types.js';

export interface Sourcing {
  grade: Grade;
  /** How many independent groups carried it. */
  groups: number;
}

/** `sources` holds one entry per source; `cited` says a sighting pointed at a page of another listed source. */
export function gradeOf(sources: readonly RecordSource[], cited: boolean): Sourcing {
  const groups = new Set(sources.map((s) => s.group));
  const officialGroups = new Set(sources.filter((s) => s.official).map((s) => s.group));
  if (officialGroups.size) {
    const others = [...groups].filter((g) => !officialGroups.has(g)).length;
    return { grade: others >= 2 ? 5 : 4, groups: groups.size };
  }
  if (groups.size >= 2) return { grade: 3, groups: groups.size };
  if (sources.length >= 2) return { grade: cited ? 3 : 2, groups: groups.size };
  return { grade: 1, groups: groups.size };
}

/** Clusters whose sources count as security sources for an incident. */
const SECURITY_CLUSTERS: ReadonlySet<string> = new Set(['security']);

/**
 * The note's rule for an incident or a loss of funds (R5): it needs an official source, or a security source and one
 * more independent group. A later stage reads this before an incident record is shown as more than a report.
 */
export function incidentSourced(sources: readonly RecordSource[]): boolean {
  if (sources.some((s) => s.official)) return true;
  const security = sources.filter((s) => SECURITY_CLUSTERS.has(s.cluster));
  return security.some((s) => sources.some((other) => other.group !== s.group));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * When a record stops being offered, by kind: a metric 48 hours, an incident or an outage 72 hours past its last
 * sighting, a release, a launch, a product change, a governance item or a piece of research 7 days, a rule 14 days, a
 * plain statement 72 hours, and a planned event a day past the time it is planned for.
 */
export function expiryOf(kind: RecordKind, firstSeenAt: Date, lastReinforcedAt: Date, eventTime: Date | null, precision: EventPrecision): Date {
  if (precision === 'planned' && eventTime && eventTime.getTime() > firstSeenAt.getTime()) return new Date(eventTime.getTime() + DAY);
  const first = firstSeenAt.getTime();
  switch (kind) {
    case 'metric':
      return new Date(first + 48 * HOUR);
    case 'incident':
    case 'outage':
      return new Date(lastReinforcedAt.getTime() + 72 * HOUR);
    case 'regulation':
      return new Date(first + 14 * DAY);
    case 'statement':
      return new Date(first + 72 * HOUR);
    default:
      return new Date(first + 7 * DAY);
  }
}
