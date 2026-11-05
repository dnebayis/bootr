/**
 * What the creator console says about the agent's fuel: a plain runway line and warnings, from data the page already
 * has (`/api/agent/:kernel/fuel`, the indexer's balances, the activity tape). Nothing is said when the data is thin.
 * Public copy: "fuel", never the wallets behind it.
 */
import { averageThoughtCost, fuelIsLow, runwayDays, thoughtsLeft } from '@bootr/shared/fuel';
import { formatMicroUsdc } from '@/lib/models';
import type { AgentActivityItem, AgentFuel } from '@/lib/types';

export interface FuelWarning {
  key: 'low_fuel' | 'ops_failing';
  /** `danger` when the agent cannot think at all right now. */
  tone: 'warning' | 'danger';
  text: string;
}

export interface FuelOutlook {
  runway: string | null;
  warnings: FuelWarning[];
}

const DAY_MS = 86_400_000;
/** Consecutive failed treasury operations before the console says so; one failure is routine and gets retried. */
export const OPS_FAILING_STREAK = 2;
const OPS_FAILING_MAX_AGE_MS = DAY_MS;
const TREASURY_KIND = /claim|swap|gas|fuel|transfer/i;
/** The tape's summaries for a failed operation all say so (supervisor activity.ts `opSummary`). */
const FAILED_SUMMARY = /\bfailed\b/i;

/** "About 3 days of fuel at the recent rate." */
export function runwayLine(days: number | null): string | null {
  if (days === null) return null;
  if (days <= 0) return 'Out of fuel.';
  const hours = days * 24;
  const amount =
    days >= 60 ? 'More than 60 days' : hours < 1 ? 'Less than an hour' : days < 1 ? plural('About', Math.round(hours), 'hour') : plural('About', Math.round(days), 'day');
  return `${amount} of fuel at the recent rate.`;
}

function plural(lead: string, n: number, unit: string): string {
  return `${lead} ${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Failed treasury operations in a row, newest first; 0 once one went through or the latest is over a day old. */
export function failedOpsStreak(items: readonly AgentActivityItem[], now: number): number {
  const ops = items.filter((it) => TREASURY_KIND.test(it.kind));
  const latest = ops[0];
  if (!latest || now - Date.parse(latest.at) > OPS_FAILING_MAX_AGE_MS) return 0;
  const firstOk = ops.findIndex((it) => !FAILED_SUMMARY.test(it.summary));
  return firstOk === -1 ? ops.length : firstOk;
}

function lowFuelWarning(spendable: number, reserve: number, left: number | null): FuelWarning | null {
  // Without an estimate (thin data) there is nothing to warn about: the status line already covers an empty coin.
  if (left === null || !fuelIsLow(spendable, left)) return null;
  const next = reserve > 0 ? `${formatMicroUsdc(reserve)} more is in reserve and should move over on its own.` : 'Add fuel to keep the agent thinking.';
  return left === 0
    ? { key: 'low_fuel', tone: 'danger', text: `Out of fuel to think with right now. ${next}` }
    : { key: 'low_fuel', tone: 'warning', text: `Low on fuel: enough for about ${left} more ${left === 1 ? 'thought' : 'thoughts'} right now. ${next}` };
}

export function fuelOutlook(input: { fuel: AgentFuel | null | undefined; spenderUsdc: string | null | undefined; treasuryUsdc: string | null | undefined; activity: readonly AgentActivityItem[]; now: number }): FuelOutlook {
  const streak = failedOpsStreak(input.activity, input.now);
  const warnings: FuelWarning[] = [];
  const spendable = Number(input.spenderUsdc ?? NaN);
  const reserve = Number(input.treasuryUsdc ?? NaN);
  let runway: string | null = null;
  if (input.fuel && Number.isFinite(spendable) && Number.isFinite(reserve)) {
    const rows = input.fuel.byModel;
    const thoughts = rows.reduce((n, r) => n + r.thoughts, 0);
    const spent = rows.reduce((n, r) => n + Number(r.chargedMicroUsdc), 0);
    const first = input.fuel.firstAt ? Date.parse(input.fuel.firstAt) : NaN;
    runway = runwayLine(Number.isFinite(first) ? runwayDays(spendable + reserve, spent, thoughts, input.now - first) : null);
    const low = lowFuelWarning(spendable, reserve, thoughtsLeft(spendable, averageThoughtCost(spent, thoughts)));
    if (low) warnings.push(low);
  }
  if (streak >= OPS_FAILING_STREAK) warnings.push({ key: 'ops_failing', tone: 'warning', text: `The last ${streak} fee claims, swaps or top-ups failed, so new fuel may not arrive.` });
  return { runway, warnings };
}
