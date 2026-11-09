/**
 * Plain words for the Bounties card on the coin page and the payment item in the console (components/token/BountiesCard.tsx,
 * ApprovalQueue.tsx): status labels, the reasons an entry was not judged, the closing time, the amount. Pure, so the copy
 * is testable. The public name of the power is Bounties: "the agent pays small bounties for work it asks for".
 */
import type { BountyJob, BountyStatus, CriterionMark } from './types';

export const BOUNTY_STATUS_LABEL: Record<BountyStatus, string> = {
  open: 'Taking entries',
  judging: 'Judging',
  proposed: 'Payment proposed',
  paid: 'Paid',
  no_winner: 'No winner',
  cancelled: 'Cancelled',
  expired: 'Expired unpaid',
  failed: 'Failed',
};

/** The one-line outcome under a closed job; null while it is open or being judged. */
export function outcomeLine(job: Pick<BountyJob, 'status'>): string | null {
  switch (job.status) {
    case 'proposed':
      return 'The judge picked a winner; the creator pays from their own wallet. Nothing is paid until they say yes.';
    case 'no_winner':
      return 'No entry met the job; nothing paid.';
    case 'cancelled':
      return 'Cancelled; nothing paid.';
    case 'expired':
      return 'Expired unpaid: the payment window passed.';
    case 'failed':
      return 'Failed: the post or the payment did not go through; nothing paid.';
    default:
      return null;
  }
}

/** The reasons the agent service gives for an entry it did not judge, in plain words; an unknown key is spelled out. */
const INELIGIBLE: Record<string, string> = {
  no_artefact: 'nothing attached',
  no_image: 'no picture',
  no_link: 'no link',
  no_address: 'no address',
  two_addresses: 'more than one address',
  young_account: 'account under 30 days old',
  own_account: 'the agent or its creator',
  shared_address: 'address used by another entry',
  duplicate_media: 'same picture as an earlier entry',
  repeat_author: 'a second entry from the same account',
  blocked_address: 'an address the job cannot pay',
  cooldown: 'paid within the cooldown',
  over_limit: 'after the first 12',
  not_considered: 'after the first 12',
};

export function ineligibleLabel(reason: string): string {
  return INELIGIBLE[reason] ?? reason.replace(/_/g, ' ');
}

/** "7 entries, 4 could be judged (2 without an address, 1 same picture as an earlier entry)" or "No entries yet". */
export function entriesLine(entries: BountyJob['entries']): string {
  if (entries.received === 0) return 'No entries yet';
  const reasons = Object.entries(entries.ineligible)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${ineligibleLabel(reason)}`);
  const judged = entries.considered < entries.eligible ? `, ${entries.considered} judged` : '';
  return `${entries.received} ${entries.received === 1 ? 'entry' : 'entries'}, ${entries.eligible} could be judged${reasons.length ? ` (${reasons.join(', ')})` : ''}${judged}`;
}

/** "0.50 USDC" from a decimal string of micro-USDC. */
export function usdcLabel(micro: string | number): string {
  return `${(Number(micro) / 1_000_000).toFixed(2)} USDC`;
}

/** "9 Nov 2026, 16:00 UTC". */
export function utcLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** "closes in 4 h", "closes in 35 min", "closed 2 d ago": the relative form; `utcLabel` gives the absolute one. */
export function closesLabel(closesAt: string, now = Date.now()): string {
  const ms = Date.parse(closesAt) - now;
  if (!Number.isFinite(ms)) return '—';
  const span = (abs: number) => {
    const min = Math.round(abs / 60_000);
    if (min < 60) return `${Math.max(1, min)} min`;
    const h = Math.round(abs / 3_600_000);
    if (h < 48) return `${h} h`;
    return `${Math.round(abs / 86_400_000)} d`;
  };
  return ms > 0 ? `closes in ${span(ms)}` : `closed ${span(-ms)} ago`;
}

export const MARK_LABEL: Record<CriterionMark, string> = { pass: 'met', fail: 'not met', insufficient_evidence: 'could not tell' };

/** The winner's marks, one per criterion, or null when there is no winner. */
export function winnerMarks(job: Pick<BountyJob, 'verdict' | 'criteria'>): CriterionMark[] | null {
  const v = job.verdict;
  if (!v || v.winnerEntry === null) return null;
  const marks = v.perCriterion[String(v.winnerEntry)];
  return marks ? job.criteria.map((_, i) => marks[i] ?? 'insufficient_evidence') : null;
}

/** The element id a job post on X links to: `#bounty-<jobId>`. */
export function bountyAnchor(jobId: string): string {
  return `bounty-${jobId.toLowerCase()}`;
}
