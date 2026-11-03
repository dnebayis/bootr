import { describe, expect, it } from 'vitest';
import { findOption, flattenEntries, optionsFromChildren, selectEntries, textOf } from './select-options';

describe('Select compatibility mapping (native <option>/<optgroup> children)', () => {
  it('maps loose options and labelled groups in source order', () => {
    const entries = optionsFromChildren(
      <>
        <option value="">Loading models…</option>
        {[{ ms: 3600000, label: 'Every hour' }].map((o) => (
          <option key={o.ms} value={o.ms}>
            {o.label}
          </option>
        ))}
        <optgroup label="Anthropic">
          <option value="anthropic/claude-haiku-4.5">
            Claude Haiku 4.5 · {'$0.0101'}
            {' · Recommended'}
          </option>
          <option value="anthropic/off" disabled>
            Off
          </option>
        </optgroup>
        <optgroup label="Legacy" disabled>
          <option value="old">Old</option>
        </optgroup>
      </>,
    );
    expect(entries.map((e) => e.kind)).toEqual(['option', 'option', 'group', 'group']);
    expect(flattenEntries(entries).map((o) => o.value)).toEqual(['', '3600000', 'anthropic/claude-haiku-4.5', 'anthropic/off', 'old']);
    expect(findOption(entries, 'anthropic/claude-haiku-4.5')?.text).toBe('Claude Haiku 4.5 · $0.0101 · Recommended');
    expect(findOption(entries, 'anthropic/off')?.disabled).toBe(true);
    expect(findOption(entries, 'old')?.disabled).toBe(true);
    expect(findOption(entries, '3600000')?.text).toBe('Every hour');
    expect(findOption(entries, 'missing')).toBeUndefined();
    expect(findOption(entries, null)).toBeUndefined();
    const groups = entries.filter((e) => e.kind === 'group');
    expect(groups.map((g) => (g.kind === 'group' ? g.group.label : ''))).toEqual(['Anthropic', 'Legacy']);
  });

  it('falls back to the text when an <option> has no value, like the native element', () => {
    const [entry] = optionsFromChildren(<option>Hourly</option>);
    expect(entry).toMatchObject({ kind: 'option', option: { value: 'Hourly', text: 'Hourly' } });
  });

  it('ignores anything that is not an option or optgroup', () => {
    expect(optionsFromChildren([null, false, 'text', <div key="d">no</div>])).toEqual([]);
  });

  it('prefers typed groups over options over children', () => {
    const options = [{ value: 'a', label: 'A' }];
    const groups = [{ label: 'G', options: [{ value: 'b', label: 'B' }] }];
    const children = <option value="c">C</option>;
    expect(flattenEntries(selectEntries({ options, groups, children })).map((o) => o.value)).toEqual(['b']);
    expect(flattenEntries(selectEntries({ options, children })).map((o) => o.value)).toEqual(['a']);
    expect(flattenEntries(selectEntries({ children })).map((o) => o.value)).toEqual(['c']);
  });

  it('flattens labels to text', () => {
    expect(textOf(['a', 1, null, <b key="b">c</b>, true])).toBe('a1c');
  });
});
