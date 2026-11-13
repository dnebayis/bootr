/**
 * Every limit of the agent tools of round two at "off" (docs/design/agent-tools-2.md section 13: a limit of 0 switches
 * its piece off): the posting rules (threads, comments, the mention audience, the reply audience, questions from
 * anyone, the agent's own cashtag and address), scheduled posts, the facts and the note on what works, and the coin's
 * own day. With all of them a hosted agent's turn is what it was before the round (test/round-off.test.ts).
 */
import { POSTING_OFF } from './posting-off.limits.js';

export const ROUND_OFF: Record<string, string> = {
  ...POSTING_OFF,
  // Scheduled posts: no tool, no section, no sweep.
  SCHEDULED_MAX_WAITING: '0',
  // Learning: the `postPerformance` section and the per-batch memory note as they were; no note tool; no `coinToday`.
  LEARN_WINDOW_DAYS: '0',
  WHAT_WORKS_MAX_CHARS: '0',
  COIN_BRIEF_MAX_CHARS: '0',
};
