/**
 * The creator console's "posts per day" control: what a daily budget means in plain words. The budget is the posting
 * service's quota (original posts and replies together, over a rolling day); the agent's original-post cadence follows
 * it (`postIntervalForPostsPerDay`, half the budget for originals), and the rough daily fuel cost comes from what the
 * agent's thoughts cost lately (`/api/agent/:kernel/fuel`) or, before there is enough history, the model's listed price.
 * Public copy: "fuel" and "thoughts", nothing about the services behind them.
 */
import { averageThoughtCost, THOUGHTS_PER_POST } from '@bootr/shared/fuel';
import { CADENCE_OPTIONS, postIntervalForPostsPerDay } from '@bootr/shared/workers';
import { formatMicroUsdc } from '@/lib/models';
import type { AgentFuel } from '@/lib/types';

/** "Every 2 h", "Every 40 min", "Once a day". */
export function cadenceLabel(ms: number): string {
  const known = CADENCE_OPTIONS.find((o) => o.ms === ms);
  if (known) return known.label;
  const h = ms / 3_600_000;
  return h >= 24 ? `Every ${Math.round(h / 24)} d` : h >= 1 ? `Every ${Math.round(h * 10) / 10} h` : `Every ${Math.round(ms / 60_000)} min`;
}

/** The measured average cost of one thought in micro-USDC from the fuel report, or null with too little history. */
export function measuredThoughtCost(fuel: AgentFuel | null | undefined): number | null {
  const rows = fuel?.byModel ?? [];
  if (!rows.length) return null;
  const thoughts = rows.reduce((n, r) => n + r.thoughts, 0);
  const spent = rows.reduce((n, r) => n + Number(r.chargedMicroUsdc), 0);
  return averageThoughtCost(spent, thoughts);
}

export interface PostBudgetNoteInput {
  postsPerDay: number;
  /** The cadence in force when the budget is unchanged, else the one the budget implies. */
  intervalMs: number;
  /** Micro-USDC per thought as measured (`measuredThoughtCost`); null when unknown. */
  measuredMicroUsdc: number | null;
  /** USD per thought from the model list, the fallback; null when unknown. */
  listedUsd: number | null;
}

/** The cadence the console shows for a draft budget: the stored one while the budget is unchanged, else what the budget implies. */
export function shownInterval(draftPostsPerDay: number, stored: { postsPerDay: number; postIntervalMs: number }): number {
  return draftPostsPerDay === stored.postsPerDay ? stored.postIntervalMs : postIntervalForPostsPerDay(draftPostsPerDay);
}

/** The rough daily fuel cost in micro-USDC, or null when no cost per thought is known. */
export function dailyFuelMicroUsdc(input: Pick<PostBudgetNoteInput, 'postsPerDay' | 'measuredMicroUsdc' | 'listedUsd'>): number | null {
  const perThought = input.measuredMicroUsdc ?? (input.listedUsd != null && Number.isFinite(input.listedUsd) ? input.listedUsd * 1e6 : null);
  if (perThought == null || perThought <= 0) return null;
  return Math.round(input.postsPerDay * THOUGHTS_PER_POST * perThought);
}

/** Two or three plain sentences under the control. */
export function postBudgetNote(input: PostBudgetNoteInput): string {
  const cadence = cadenceLabel(input.intervalMs).replace(/^Every/, 'every').replace(/^Once/, 'once');
  const parts = [`Original posts and replies together, over a rolling day. Original posts go out about ${cadence}; the rest of the budget answers mentions, and the agent stops when the budget is used up.`];
  const micro = dailyFuelMicroUsdc(input);
  if (micro != null) {
    const basis = input.measuredMicroUsdc != null ? 'what its thoughts have cost lately' : 'the model’s listed price';
    parts.push(`Roughly ${formatMicroUsdc(micro)} a day in fuel at ${basis} (about ${THOUGHTS_PER_POST} thoughts a post), less on quiet days.`);
  }
  return parts.join(' ');
}
