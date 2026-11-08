import { describe, expect, it } from 'vitest';
import { changedSections, CONSOLE_SECTIONS, sectionLabel, SETTINGS_SECTIONS } from './console-sections';

describe('changedSections', () => {
  it('is empty without changes', () => {
    expect(changedSections(null)).toEqual([]);
    expect(changedSections({})).toEqual([]);
  });

  it('maps every field of a config change to the tab that holds it, in tab order', () => {
    expect(changedSections({ instructions: 'x' })).toEqual(['mind']);
    expect(changedSections({ model: 'a/b' })).toEqual(['mind']);
    expect(changedSections({ routing: { decideModel: null } })).toEqual(['mind']);
    expect(changedSections({ postsPerDay: 12 })).toEqual(['posting']);
    expect(changedSections({ requireApproval: false })).toEqual(['posting']);
    expect(changedSections({ worker: { jobLines: ['a'] } })).toEqual(['posting']);
    expect(changedSections({ worker: { capabilities: { research: true } } })).toEqual(['powers']);
    expect(changedSections({ services: { dailyMicroUsdc: 1 } })).toEqual(['powers']);
    expect(changedSections({ imageModel: 'x' })).toEqual(['look']);
    expect(changedSections({ imageStyle: { notes: 'flat' } })).toEqual(['look']);
    expect(changedSections({ imageStyle: { notes: 'flat' }, instructions: 'x', worker: { capabilities: { images: true }, jobLines: [] } })).toEqual(['mind', 'posting', 'powers', 'look']);
  });

  it('keeps the settings tabs first and every section labelled', () => {
    expect(CONSOLE_SECTIONS.slice(0, SETTINGS_SECTIONS.length).map((s) => s.id)).toEqual([...SETTINGS_SECTIONS]);
    for (const s of CONSOLE_SECTIONS) expect(sectionLabel(s.id)).toBe(s.label);
  });
});
