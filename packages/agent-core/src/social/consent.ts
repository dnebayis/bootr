export type ConsentCommand = 'stop' | 'resume';

const STOP = /^(?:stop|unsubscribe|(?:please\s+)?stop\s+replying(?:\s+to\s+me)?|do\s+not\s+reply(?:\s+to\s+me)?|don'?t\s+reply(?:\s+to\s+me)?|leave\s+me\s+alone)$/;
const RESUME = /^(?:resume|reply\s+again|you\s+can\s+reply\s+again|unmute)$/;

/** Detects a bare stop/resume request once handles and trailing punctuation are removed. */
export function consentCommand(text: string | null | undefined): ConsentCommand | null {
  const bare = String(text ?? '')
    .replace(/@[a-z0-9_]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .toLowerCase();
  if (STOP.test(bare)) return 'stop';
  if (RESUME.test(bare)) return 'resume';
  return null;
}

export interface OptOutRecord {
  authorId: string;
  /** The post that last changed the state; only a newer post may change it again. */
  postId: string;
  enabled: boolean;
}

export type OptOutLedger = Readonly<Record<string, OptOutRecord>>;

/**
 * Apply a consent command to the ledger. Posts are compared numerically so an
 * older "resume" replayed after a newer "stop" cannot re-enable replies.
 */
export function applyConsent(ledger: OptOutLedger, authorId: string, postId: string, command: ConsentCommand): OptOutLedger {
  const current = ledger[authorId];
  if (current && BigInt(postId) <= BigInt(current.postId)) return ledger;
  return { ...ledger, [authorId]: { authorId, postId, enabled: command === 'stop' } };
}

export function optedOut(ledger: OptOutLedger, authorId: string): boolean {
  return ledger[authorId]?.enabled === true;
}
