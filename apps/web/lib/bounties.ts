/**
 * Plain words for the Bounties card on the coin page and the bounty items in the console (components/token/BountiesCard.tsx,
 * ApprovalQueue.tsx): status labels, the reasons an entry was not judged, the closing time, the amount. Pure, so the copy
 * is testable. The public name of the power is Bounties: "the agent pays small bounties for work it asks for".
 *
 * A coin whose agent runs in its creator's own AI client has its entries judged by that agent, when it is next online
 * (docs/design/byo-agent.md, decision 6): a job waits up to 48 hours for the ruling and closes with no winner after
 * that. `awaitsOwnJudge` and `outcomeLine` say so in plain words.
 */
import { OWN_AGENT_MODEL_ID } from '@bootr/shared/own-agent';
import type { BountyJob, BountyStatus, CriterionMark } from './types';

/**
 * A job as the card reads it: the page's `BountyJob`, plus what the agent service adds for a coin whose agent runs in
 * its creator's own AI client (`BountyJobView.ownJudge`, bounties.ts): until when the job waits for that agent's ruling.
 */
export type BountyCardJob = BountyJob & { ownJudge?: { ruleBy: string } | null };

/** What the agent service writes as the verdict of a job its own agent did not judge in time. */
export const JUDGE_ABSENT = 'judge_absent';

/** The line under a job that waits for the ruling of the creator's own agent. */
export const OWN_JUDGE_WAITING = 'Judged when the creator’s agent is next online, within 48 hours. If it is not, the job closes with no winner and nothing is paid.';
/** The line under a job that closed because that ruling never came. */
export const OWN_JUDGE_ABSENT = 'The creator’s agent did not judge the entries within 48 hours; nothing paid.';

/**
 * Whether the job waits for the ruling of the creator's own agent: its window has closed, it has no verdict, and either
 * the agent service says so on the job or the coin's agent is one that runs in its creator's client (`model` is
 * `own-agent`, the value the coin carries while it does).
 */
export function awaitsOwnJudge(job: Pick<BountyCardJob, 'status' | 'verdict' | 'ownJudge'>, coin: { model?: string | null } = {}): boolean {
  if (job.status !== 'judging' || job.verdict) return false;
  return !!job.ownJudge || coin.model === OWN_AGENT_MODEL_ID;
}

/** Whether the job closed because the creator's own agent gave no ruling in time. */
export function closedUnjudged(job: { status: BountyStatus; verdict?: { invalid: string | null } | null }): boolean {
  return job.status === 'no_winner' && job.verdict?.invalid === JUDGE_ABSENT;
}

export const BOUNTY_STATUS_LABEL: Record<BountyStatus, string> = {
  draft: 'Waiting to be posted',
  open: 'Taking entries',
  judging: 'Judging',
  proposed: 'Payment proposed',
  paid: 'Paid',
  no_winner: 'No winner',
  cancelled: 'Cancelled',
  expired: 'Expired unpaid',
  failed: 'Failed',
};

/**
 * The one-line outcome under a job that is not simply open; null while it takes entries, is judged or is paid. With
 * `coin` (the coin's `model`), a job that waits for the creator's own agent says so.
 */
export function outcomeLine(job: Pick<BountyJob, 'status'> & { verdict?: BountyJob['verdict']; ownJudge?: BountyCardJob['ownJudge'] }, coin: { model?: string | null } = {}): string | null {
  if (awaitsOwnJudge({ status: job.status, verdict: job.verdict ?? null, ownJudge: job.ownJudge ?? null }, coin)) return OWN_JUDGE_WAITING;
  if (closedUnjudged(job)) return OWN_JUDGE_ABSENT;
  switch (job.status) {
    case 'draft':
      return 'Written by the agent; it goes out on X once the creator has read it or a posting slot is free.';
    case 'proposed':
      return 'The judge picked a winner; the creator pays from their own wallet. Nothing is paid until they say yes.';
    case 'no_winner':
      return 'No entry met the job; nothing paid.';
    case 'cancelled':
      return 'Cancelled; nothing paid.';
    case 'expired':
      return 'Expired unpaid: the payment window passed.';
    case 'failed':
      return 'Failed: the job post did not go through; nothing paid.';
    default:
      return null;
  }
}

/** The reasons the agent service gives for an entry it did not judge (bounties.ts `IneligibleReason`), in plain words; an unknown key is spelled out. */
const INELIGIBLE: Record<string, string> = {
  no_artefact: 'nothing attached',
  no_address: 'no address',
  many_addresses: 'more than one address',
  own_account: 'the agent itself',
  creator_account: 'the creator',
  account_too_new: 'account under 30 days old',
  account_age_unknown: 'account age unknown',
  repeat_author: 'a second entry from the same account',
  shared_address: 'address used by another entry',
  duplicate_media: 'same picture as an earlier entry',
  reserved_address: 'an address the job cannot pay',
  address_in_cooldown: 'paid within the cooldown',
  artefact_unreadable: 'could not be read',
  image_too_large: 'picture too large',
  link_redirect: 'link redirected',
  not_considered: 'after the first 12',
};

export function ineligibleLabel(reason: string): string {
  return INELIGIBLE[reason] ?? reason.replace(/_/g, ' ');
}

/** "7 entries, 4 could be judged (2 no address, 1 same picture as an earlier entry)" or "No entries yet". */
export function entriesLine(entries: BountyJob['entries']): string {
  if (entries.received === 0) return 'No entries yet';
  const reasons = Object.entries(entries.ineligible)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${ineligibleLabel(reason)}`);
  const judged = entries.considered < entries.eligible ? `, ${entries.considered} judged` : '';
  return `${entries.received} ${entries.received === 1 ? 'entry' : 'entries'}, ${entries.eligible} could be judged${reasons.length ? ` (${reasons.join(', ')})` : ''}${judged}`;
}

/** "0.50 USDC" from the service's decimal USDC string ("0.5") or a micro-USDC amount. */
export function usdcLabel(amount: string | number | null | undefined, unit: 'usdc' | 'micro' = 'usdc'): string {
  if (amount === null || amount === undefined || amount === '') return '— USDC';
  const n = unit === 'micro' ? Number(amount) / 1_000_000 : Number(amount);
  return Number.isFinite(n) ? `${n.toFixed(2)} USDC` : '— USDC';
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
  if (!v || v.winner === null) return null;
  const marks = v.perCriterion[String(v.winner)];
  return marks ? job.criteria.map((_, i) => marks[i] ?? 'insufficient_evidence') : null;
}

/** The element id a job post on X links to: `#bounty-<shortId>` (the 16-hex prefix; a post cannot carry the full id). */
export function bountyAnchor(shortId: string): string {
  return `bounty-${shortId.toLowerCase()}`;
}
