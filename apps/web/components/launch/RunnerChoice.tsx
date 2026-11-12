'use client';

import type { Runner } from '@bootr/shared/own-agent';
import { CheckIcon } from '@/components/ui/Icons';
import { cn } from '@/components/ui/cn';

/** The two ways a coin's agent can be run, in the words every page uses for them. */
export const RUNNER_LABEL: Record<Runner, string> = { hosted: 'Bootr agent', own: 'My own agent' };

const CARDS: readonly { id: Runner; lead: string; points: readonly string[] }[] = [
  {
    id: 'hosted',
    lead: 'Bootr runs the agent for you, around the clock. It pays for its own thinking from fuel.',
    points: ['Always on, nothing to set up', 'You choose the model it thinks with', 'Needs fuel: it stays silent until some arrives'],
  },
  {
    id: 'own',
    lead: 'The agent thinks in your own AI client. Your machine on, it works; off, it is silent. No fuel needed to think.',
    points: ['Runs in Claude Code, Claude Desktop, Cursor, Codex and others', 'Same rules and limits as the Bootr agent', 'Only paid services use fuel'],
  },
];

/**
 * The launch page's first choice (docs/design/byo-agent.md section 5.1): who runs the coin's agent. Two cards, one
 * radio group. "Bootr agent" is today's launch, unchanged; "My own agent" adds the step that connects the creator's
 * AI client. Shown only where own agents are offered; the choice can be changed later from the creator console, both ways.
 */
export function RunnerChoice({ value, onChange }: { value: Runner; onChange: (runner: Runner) => void }) {
  return (
    <fieldset className="pb-8" data-testid="runner-choice">
      <legend className="text-display-sm font-semibold text-ink">Who runs the agent?</legend>
      <p className="mt-1 text-sm text-mute">Both get the same coin, treasury and fee split. You can switch later from the creator console, in either direction.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {CARDS.map((card) => {
          const selected = value === card.id;
          return (
            <label
              key={card.id}
              data-testid={`runner-${card.id}`}
              data-selected={selected ? 'true' : 'false'}
              className={cn(
                'relative flex cursor-pointer flex-col gap-2 rounded-md border p-4 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                selected ? 'border-ink bg-canvas' : 'border-hairline bg-canvas hover:border-hairline-strong',
              )}
            >
              <input type="radio" name="runner" value={card.id} checked={selected} onChange={() => onChange(card.id)} className="sr-only" />
              <span className="flex items-center justify-between gap-3">
                <span className="text-base font-semibold tracking-tight text-ink">{RUNNER_LABEL[card.id]}</span>
                <span
                  aria-hidden="true"
                  className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border', selected ? 'border-ink bg-ink text-on-ink' : 'border-hairline-strong text-transparent')}
                >
                  <CheckIcon size={12} />
                </span>
              </span>
              <span className="text-sm text-body">{card.lead}</span>
              <ul className="mt-1 flex flex-col gap-1 text-caption text-mute">
                {card.points.map((point) => (
                  <li key={point} className="flex gap-2">
                    <span aria-hidden="true">·</span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * The own path's three steps as one strip: wallet, connect your AI client, launch. A step is done, current or still
 * ahead; the strip only shows where the creator is, the steps themselves sit below it on the page.
 */
export function OwnSteps({ steps }: { steps: readonly { label: string; state: 'done' | 'current' | 'next'; note?: string }[] }) {
  return (
    <ol className="flex flex-col gap-2 rounded-md border border-hairline p-3 sm:flex-row sm:items-center sm:gap-0 sm:p-0" data-testid="own-steps" aria-label="Steps of an own-agent launch">
      {steps.map((step, i) => (
        <li key={step.label} data-state={step.state} className={cn('flex min-w-0 flex-1 items-center gap-2.5 sm:px-4 sm:py-3', i > 0 && 'sm:border-l sm:border-hairline')}>
          <span
            aria-hidden="true"
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-micro',
              step.state === 'done' ? 'border-ink bg-ink text-on-ink' : step.state === 'current' ? 'border-ink text-ink' : 'border-hairline-strong text-mute',
            )}
          >
            {step.state === 'done' ? <CheckIcon size={12} /> : i + 1}
          </span>
          <span className="min-w-0">
            <span className={cn("block text-sm leading-tight", step.state === "next" ? "text-mute" : "font-medium text-ink")}>
              {step.label}
              {step.state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
            {step.note ? <span className="block truncate text-micro text-mute">{step.note}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
