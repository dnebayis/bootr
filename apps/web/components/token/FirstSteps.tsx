'use client';

import { useRouter } from 'next/navigation';
import { consoleHref } from '@/lib/console-sections';
import type { Agent, Token } from '@/lib/types';
import { useConsoleStatus } from './console-status';
import { OnboardingCard } from './OnboardingCard';

/**
 * The first-steps card in the coin page's side column, for the creator of a new agent: each step's button opens the
 * console page at its section (`?section=`); the X step scrolls to the X banner above. Nothing once every step is
 * done or the creator hid it (OnboardingCard). Creator only (everyone in mock mode).
 */
export function FirstSteps({ token, agent }: { token: Token; agent: Agent | null }) {
  const router = useRouter();
  const { onboarding } = useConsoleStatus(token, agent);
  if (!onboarding) return null;
  return (
    <OnboardingCard
      kernel={token.kernel}
      items={onboarding}
      className="rounded-md border-edge"
      onGo={(target) => {
        if (target === 'x') document.getElementById('connect-x')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else router.push(consoleHref(token.id, target));
      }}
    />
  );
}
