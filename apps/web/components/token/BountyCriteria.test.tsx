import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CriterionMark } from '@/lib/types';
import { BountyCriteria } from './BountyCriteria';

/** The criteria of the fee-split job, and entry 2's marks: it met the required criterion and lost a scored one. */
const CRITERIA = ['Shows exactly four recipients with the right shares', 'Square image, flat or hand-drawn style, readable text', 'Flows from one trade to the four recipients, no other brands'];
const ENTRY_2: CriterionMark[] = ['pass', 'fail', 'pass'];

const tags = (html: string) => [...html.matchAll(/data-criterion="(required|scored)"/g)].map((m) => m[1]);
const marks = (html: string) => [...html.matchAll(/data-mark="([a-z_]+)"/g)].map((m) => m[1]);

describe('BountyCriteria', () => {
  it('shows each criterion as required or scored, and how the winner is picked', () => {
    const html = renderToStaticMarkup(<BountyCriteria criteria={CRITERIA} required={[1]} />);
    expect(tags(html)).toEqual(['required', 'scored', 'scored']);
    expect(html.match(/>required</g)).toHaveLength(1);
    expect(html.match(/>scored</g)).toHaveLength(2);
    for (const c of CRITERIA) expect(html).toContain(c);
    expect(html).toContain('data-testid="bounty-winner-rule"');
    expect(html).toContain('An entry must meet the required criterion to win. Among those that do, the one that meets the most criteria wins; the earlier entry wins a tie.');
    // no marks without a ruling
    expect(marks(html)).toEqual([]);
  });

  it('shows the winning entry\'s marks beside the criteria: a winner may have missed a scored one', () => {
    const html = renderToStaticMarkup(<BountyCriteria criteria={CRITERIA} required={[1]} marks={ENTRY_2} />);
    expect(marks(html)).toEqual(['pass', 'fail', 'pass']);
    expect(html).toContain('aria-label="not met"');
  });

  it('two required criteria, a job that names none (its first is required), and a job whose every criterion is required', () => {
    expect(tags(renderToStaticMarkup(<BountyCriteria criteria={CRITERIA} required={[1, 3]} />))).toEqual(['required', 'scored', 'required']);
    expect(tags(renderToStaticMarkup(<BountyCriteria criteria={CRITERIA} />))).toEqual(['required', 'scored', 'scored']);
    expect(tags(renderToStaticMarkup(<BountyCriteria criteria={CRITERIA} required={null} />))).toEqual(['required', 'scored', 'scored']);
    const all = renderToStaticMarkup(<BountyCriteria criteria={CRITERIA.slice(0, 2)} required={[1, 2]} />);
    expect(tags(all)).toEqual(['required', 'required']);
    expect(all).toContain('An entry must meet every criterion to win');
  });

  it('as the creator\'s review queue uses it: its own test id, and no rule line where the creator picks by hand; nothing for a job without criteria', () => {
    const html = renderToStaticMarkup(<BountyCriteria criteria={CRITERIA} required={[1]} rule={false} testId="bounty-criteria" />);
    expect(html).toContain('data-testid="bounty-criteria"');
    expect(html).not.toContain('bounty-winner-rule');
    expect(tags(html)).toEqual(['required', 'scored', 'scored']);
    expect(renderToStaticMarkup(<BountyCriteria criteria={[]} required={[1]} />)).toBe('');
  });
});
