import { isRequired, MARK_LABEL, winnerRuleLine } from '@/lib/bounties';
import type { CriterionMark } from '@/lib/types';
import { cn } from '@/components/ui/cn';

function Mark({ mark }: { mark: CriterionMark }) {
  const glyph = mark === 'pass' ? '✓' : mark === 'fail' ? '✕' : '?';
  return (
    <span className={cn('inline-flex w-4 shrink-0 justify-center font-mono text-micro', mark === 'pass' ? 'text-ink' : mark === 'fail' ? 'text-danger' : 'text-mute')} title={MARK_LABEL[mark]} aria-label={MARK_LABEL[mark]} data-mark={mark}>
      {glyph}
    </span>
  );
}

/**
 * A job's criteria as the coin page and the creator's review queue show them: numbered as written, each one tagged
 * required (an entry must meet it to win) or scored (it counts toward the most criteria met), with the marks of one
 * entry beside them when given, and one line on how the winner is picked. `required` holds 1-based numbers; a job that
 * names none has its first criterion as the required one.
 */
export function BountyCriteria({ criteria, required, marks, rule = true, testId = 'bounty-job-criteria' }: { criteria: readonly string[]; required?: readonly number[] | null; marks?: readonly CriterionMark[] | null; rule?: boolean; testId?: string }) {
  if (!criteria.length) return null;
  const line = rule ? winnerRuleLine(criteria.length, required) : null;
  return (
    <div className="flex flex-col gap-1">
      <ol className="flex flex-col gap-0.5 text-caption text-body" data-testid={testId}>
        {criteria.map((c, i) => {
          const needed = isRequired(required, i + 1);
          return (
            <li key={i} className="flex items-baseline gap-2" data-criterion={needed ? 'required' : 'scored'}>
              <span className="w-4 shrink-0 font-mono text-micro text-mute tabular">{i + 1}.</span>
              <span className="min-w-0 flex-1 break-words">{c}</span>
              <span className={cn('shrink-0 font-mono text-micro', needed ? 'text-ink' : 'text-mute')} title={needed ? 'An entry must meet this to win' : 'Counts toward the most criteria met'}>
                {needed ? 'required' : 'scored'}
              </span>
              {marks ? <Mark mark={marks[i] ?? 'insufficient_evidence'} /> : null}
            </li>
          );
        })}
      </ol>
      {line ? (
        <p className="text-micro text-mute" data-testid="bounty-winner-rule">
          {line}
        </p>
      ) : null}
    </div>
  );
}
