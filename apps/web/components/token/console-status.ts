'use client';

import { useMemo } from 'react';
import type { Address } from 'viem';
import { useAgent, useAgentActivity, useAgentConfig, useAgentFuel, useApprovalCount, useNotificationCount } from '@/lib/indexer';
import { fuelOutlook } from '@/lib/fuel-outlook';
import { gasTotal } from '@/lib/gas';
import { fuelFromAgent, onboardingItems } from '@/lib/onboarding';
import { useKernelGas } from '@/lib/use-gas';
import type { Agent, Token } from '@/lib/types';

/**
 * What both creator views read: the coin page's console card and the console page itself. The agent's config, the
 * counts for the Inbox (pending reviews, open notifications), the fuel and activity feeds behind the runway line and
 * its warnings, the gas read from the chain, and the first-steps items (lib/onboarding.ts) derived from all of it.
 * One set of React Query keys, so the two views never disagree.
 */
export function useConsoleStatus(token: Token, agent: Agent | null) {
  const config = useAgentConfig(token.kernel);
  // The indexer's agent row (shared with AgentPanel): the fuel figures of the first steps.
  const agentRow = useAgent(token.kernel);
  const approvals = useApprovalCount(token.kernel);
  const notifications = useNotificationCount(token.kernel);
  const fuel = useAgentFuel(token.kernel);
  const activity = useAgentActivity(token.kernel);
  const kernels = useMemo(() => [token.kernel as Address], [token.kernel]);
  const gas = useKernelGas(kernels);
  const kernelGas = gas.of(token.kernel as Address);
  const gasWei = kernelGas ? gasTotal(kernelGas) : null;
  const pendingReviews = approvals.data?.pending ?? 0;
  const inboxCount = pendingReviews + (notifications.data?.active ?? 0);
  const inactive = agent?.status === 'paused' || agent?.status === 'dormant' || agent?.status === 'claimed';
  // Runway and warnings; an agent that is not running has no rate to speak of. The clock is when the numbers were read.
  const outlook = useMemo(
    () => (inactive ? null : fuelOutlook({ fuel: fuel.data, spenderUsdc: agent?.spenderUsdc, treasuryUsdc: agent?.treasuryUsdc, activity: activity.data?.pages[0]?.items ?? [], now: fuel.dataUpdatedAt || activity.dataUpdatedAt })),
    [inactive, fuel.data, fuel.dataUpdatedAt, agent?.spenderUsdc, agent?.treasuryUsdc, activity.data, activity.dataUpdatedAt],
  );
  const cfg = config.data ?? null;
  // The first steps, from stored state (the saved instructions, not a draft): a step ticks when it is really done.
  // An own agent thinks in its creator's own AI client: its third step is a connected client, not fuel.
  const own = cfg?.runner === 'own' ? { clients: cfg.own?.clients ?? 0 } : null;
  const onboarding = cfg ? onboardingItems({ xHandle: token.xHandle, instructions: cfg.instructions, ...fuelFromAgent(agentRow.data ?? (agent && 'treasuryUsdc' in agent ? agent : null)), gasWei, own }) : null;
  // The runway line and its warnings count paid thoughts; an own agent buys none.
  return { config, cfg, fuel, activity, gas, kernelGas, gasWei, pendingReviews, inboxCount, inactive, outlook: own ? null : outlook, onboarding };
}

export type ConsoleStatus = ReturnType<typeof useConsoleStatus>;
