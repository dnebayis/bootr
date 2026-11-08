'use client';

import { useState } from 'react';
import type { ConsoleSection } from '@/lib/console-sections';
import { onboardingComplete, onboardingPending, readOnboardingHidden, writeOnboardingHidden, type OnboardingItem } from '@/lib/onboarding';
import { Button } from '@/components/ui/Button';
import { CheckIcon } from '@/components/ui/Icons';
import { cn } from '@/components/ui/cn';

/**
 * The first-steps card at the top of the creator console: four facts about a new agent (X account, instructions, fuel,
 * gas) read from state the page already has (lib/onboarding.ts), each with one button that opens the section (or scrolls
 * to the X banner) where it is settled. Gone on its own once every step is done; "Hide" puts it away for this viewer
 * and agent (localStorage, best effort). Rendered only on the client after the config has loaded, so reading storage
 * at mount cannot disagree with a server render.
 */
export function OnboardingCard({ kernel, items, onGo }: { kernel: string; items: OnboardingItem[]; onGo: (target: ConsoleSection | 'x') => void }) {
  const [hidden, setHidden] = useState(() => readOnboardingHidden(kernel));
  if (hidden || onboardingPending(items) || onboardingComplete(items)) return null;
  const done = items.filter((i) => i.done).length;
  return (
    <section aria-labelledby="onboarding-title" className="rounded-sm border border-hairline" data-testid="onboarding-checklist" data-done={done}>
      <header className="flex items-center justify-between gap-3 border-b border-hairline px-3 py-1.5">
        <h3 id="onboarding-title" className="text-caption font-medium text-ink">
          First steps{' '}
          <span className="font-mono text-micro text-mute tabular" data-testid="onboarding-progress">
            {done}/{items.length}
          </span>
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            writeOnboardingHidden(kernel);
            setHidden(true);
          }}
          data-testid="onboarding-hide"
        >
          Hide
        </Button>
      </header>
      <ol className="divide-y divide-hairline">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-3 px-3 py-2" data-testid="onboarding-item" data-key={item.key} data-done={item.done ? 'true' : 'false'}>
            <span
              aria-hidden="true"
              className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', item.done ? 'border-ink bg-ink text-on-ink' : 'border-hairline-strong')}
            >
              {item.done ? <CheckIcon size={10} /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block text-sm', item.done ? 'text-mute' : 'text-ink')}>
                {item.label}
                {item.done ? <span className="sr-only"> (done)</span> : null}
              </span>
              {!item.done ? <span className="block text-micro text-mute">{item.detail}</span> : null}
            </span>
            {!item.done ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => onGo(item.target)}>
                {item.action}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
