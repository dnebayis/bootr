import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { THREAD_MAX_LINK_PARTS, THREAD_MAX_PARTS, THREAD_PART_MAX_CHARS, WHAT_WORKS_NOTE_MAX_CHARS } from '@bootr/agent-core';
import { describe, expect, it } from 'vitest';
import { ROUND } from '@/components/docs/content';
import { pageToMarkdown } from './markdown';

/**
 * The numbers the docs give for threads, comments, mentions, links, posts written ahead and the learning facts, held
 * to the defaults in the code that enforces them. The web does not depend on the agent service or the posting service,
 * so the defaults of those two are read from their source files as text (the docs keep a copy in `ROUND`,
 * components/docs/content.ts); the limits that live in `@bootr/agent-core` are imported. A default that changes in
 * either service fails this test until the docs say the new number. Where the web is built without the two services
 * beside it the source files are not there, and those checks are skipped.
 */
const apps = path.resolve(import.meta.dirname, '../../..');
const files = {
  supervisor: path.join(apps, 'supervisor/src/config.ts'),
  scheduled: path.join(apps, 'supervisor/src/scheduled.ts'),
  sender: path.join(apps, 'sender/src/config.ts'),
};
const present = Object.values(files).every((f) => existsSync(f));
const read = (f: string) => (present ? readFileSync(f, 'utf8') : '');
const supervisor = read(files.supervisor);
const scheduled = read(files.scheduled);
const sender = read(files.sender);

/** A number as a config file writes it: `4`, `1.5`, `600_000`, `72 * 3_600_000`. */
function numberOf(expr: string): number {
  const clean = expr.replace(/_/g, '').trim();
  if (!/^[\d.\s*]+$/.test(clean)) throw new Error(`not a number: ${expr}`);
  return clean.split('*').reduce((product, factor) => product * Number(factor.trim()), 1);
}

/** The default of one setting of the agent service: `NAME: int(<default>, <min>)`, `num(…)`, or a `z.preprocess` that falls back to a literal. */
function supervisorDefault(name: string): string {
  const helper = new RegExp(`\\n\\s*${name}: (?:int|num|bool)\\(([^,)]+)[,)]`).exec(supervisor);
  if (helper) return helper[1]!.trim();
  const fallback = new RegExp(`\\n\\s*${name}: z\\.preprocess\\(\\(v\\) => \\(v === '' \\|\\| v === undefined \\? ([^:]+?) : v\\)`).exec(supervisor);
  if (fallback) return fallback[1]!.trim();
  throw new Error(`${name} is not in apps/supervisor/src/config.ts in a form this test reads`);
}

/** The default of one setting of the posting service: `NAME: num(<schema>, <default>),`. */
function senderDefault(name: string): number {
  const m = new RegExp(`\\n\\s*${name}: num\\([^\\n]*,\\s*([\\d_]+)\\),`).exec(sender);
  if (!m) throw new Error(`${name} is not in apps/sender/src/config.ts in a form this test reads`);
  return numberOf(m[1]!);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('the limits the docs name, against agent-core', () => {
  it('a thread: how many posts, how long each, how many may carry a link', () => {
    expect(ROUND.threadParts).toBe(THREAD_MAX_PARTS);
    const agents = pageToMarkdown('agents');
    expect(agents).toContain(`up to ${THREAD_MAX_PARTS - 1} more connected under it, each of at most ${THREAD_PART_MAX_CHARS} characters`);
    expect(THREAD_MAX_LINK_PARTS).toBe(1);
    expect(agents).toContain('At most one post of a thread carries a link');
    expect(agents).toContain(`at most ${WHAT_WORKS_NOTE_MAX_CHARS} characters`);
  });
});

describe.skipIf(!present)('the limits the docs name, against the defaults of the two services', () => {
  it('threads, comments, mentions and replies (apps/supervisor/src/config.ts)', () => {
    expect(numberOf(supervisorDefault('THREAD_MAX_PARTS'))).toBe(ROUND.threadParts);
    expect(numberOf(supervisorDefault('THREAD_PART_MAX_CHARS'))).toBe(THREAD_PART_MAX_CHARS);
    expect(numberOf(supervisorDefault('THREAD_MAX_LINK_PARTS'))).toBe(THREAD_MAX_LINK_PARTS);
    expect(numberOf(supervisorDefault('THREADS_PER_DAY'))).toBe(ROUND.threadsPerDay);
    expect(numberOf(supervisorDefault('COMMENT_POSTS_PER_DAY'))).toBe(ROUND.commentsPerDay);
    expect(numberOf(supervisorDefault('COMMENT_PER_AUTHOR_PER_DAY'))).toBe(ROUND.commentsPerAuthorPerDay);
    expect(numberOf(supervisorDefault('COMMENT_PER_AUTHOR_PER_WEEK'))).toBe(ROUND.commentsPerAuthorPerWeek);
    expect(numberOf(supervisorDefault('COMMENT_SOURCE_MAX_AGE_MS')) / HOUR).toBe(ROUND.commentSourceMaxHours);
    expect(numberOf(supervisorDefault('ENGAGED_WINDOW_MS')) / DAY).toBe(ROUND.engagedDays);
    expect(numberOf(supervisorDefault('OPEN_REPLIES_PER_DAY'))).toBe(ROUND.openRepliesPerDay);
    // the docs say a question from anyone is answered, and a creator may also open the replies under the agent's own posts
    expect(supervisorDefault('REPLY_QUESTIONS_FROM_ANYONE')).toBe("'true'");
    expect(supervisor).toMatch(/\n\s*REPLY_AUDIENCE_DEFAULT: z\.preprocess\(\(v\) => \(v === '' \|\| v === undefined \? 'verified' : v\)/);
    expect(numberOf(supervisorDefault('ADDRESS_POSTS_PER_DAY'))).toBe(ROUND.addressPostsPerDay);
    // the docs say a comment never links its source and an original post names with an @ only who wrote to the agent
    expect(supervisorDefault('COMMENT_LINK')).toBe("'false'");
    expect(supervisorDefault('MENTION_AUDIENCE')).toBe("'engaged'");
  });

  it('posts written ahead (apps/supervisor/src/config.ts and scheduled.ts)', () => {
    expect(numberOf(supervisorDefault('SCHEDULED_MAX_WAITING'))).toBe(ROUND.scheduledWaiting);
    expect(numberOf(supervisorDefault('SCHEDULE_MIN_AHEAD_MS')) / MINUTE).toBe(ROUND.scheduleMinMinutes);
    expect(numberOf(supervisorDefault('SCHEDULE_MAX_AHEAD_MS')) / HOUR).toBe(ROUND.scheduleMaxHours);
    expect(numberOf(supervisorDefault('SCHEDULE_GRACE_MS')) / MINUTE).toBe(ROUND.scheduleGraceMinutes);
    expect(supervisorDefault('SCHEDULED_POSTS_HOSTED')).toBe("'true'");
    const perDay = /export const SCHEDULE_CREATED_PER_DAY = (\d+);/.exec(scheduled);
    expect(perDay, 'SCHEDULE_CREATED_PER_DAY in scheduled.ts').not.toBeNull();
    expect(Number(perDay![1])).toBe(ROUND.scheduleCreatedPerDay);
    const unknownBound = /export const SCHEDULED_UNKNOWN_BOUND_MS = ([\d_ *]+);/.exec(scheduled);
    expect(unknownBound, 'SCHEDULED_UNKNOWN_BOUND_MS in scheduled.ts').not.toBeNull();
    expect(numberOf(unknownBound![1]!) / MINUTE).toBe(ROUND.scheduleUnknownMinutes);
  });

  it('the facts and the note (apps/supervisor/src/config.ts)', () => {
    expect(numberOf(supervisorDefault('LEARN_WINDOW_DAYS'))).toBe(ROUND.learnDays);
    expect(numberOf(supervisorDefault('LEARN_MIN_POSTS'))).toBe(ROUND.learnMinPosts);
    expect(numberOf(supervisorDefault('LEARN_MIN_SAMPLE'))).toBe(ROUND.learnMinSample);
    expect(numberOf(supervisorDefault('LEARN_MIN_RATIO'))).toBe(ROUND.learnMinRatio);
    expect(numberOf(supervisorDefault('WHAT_WORKS_MAX_CHARS'))).toBe(WHAT_WORKS_NOTE_MAX_CHARS);
    expect(numberOf(supervisorDefault('WHAT_WORKS_MIN_INTERVAL_MS')) / DAY).toBe(ROUND.noteEveryDays);
    expect(numberOf(supervisorDefault('WHAT_WORKS_MIN_NEW_POSTS'))).toBe(ROUND.noteNewPosts);
    expect(numberOf(supervisorDefault('WHAT_WORKS_KEEP'))).toBe(ROUND.noteVersions);
  });

  it('posts with a link, and the thread limits once more (apps/sender/src/config.ts)', () => {
    expect(senderDefault('LINK_POSTS_PER_DAY')).toBe(ROUND.linkPostsPerDay);
    expect(senderDefault('LINK_POSTS_PER_DAY_PLATFORM')).toBe(ROUND.linkPostsPerDayPlatform);
    expect(senderDefault('THREAD_MAX_PARTS')).toBe(ROUND.threadParts);
    expect(senderDefault('THREAD_PART_MAX_CHARS')).toBe(THREAD_PART_MAX_CHARS);
  });

  it('reads the forms the two files are written in', () => {
    expect(numberOf('72 * 3_600_000')).toBe(72 * HOUR);
    expect(numberOf('1.5')).toBe(1.5);
    expect(() => numberOf('process.exit(1)')).toThrow();
    expect(() => supervisorDefault('NO_SUCH_SETTING')).toThrow();
  });
});
