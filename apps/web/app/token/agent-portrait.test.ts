import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentPortrait, agentSigilDataUrl, portraitCells } from '@/components/art/AgentPortrait';

/** The face is a function of the kernel address: same address, same face; another address, another face. */

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

function markup(address: string, status?: 'awake' | 'sleeping' | 'paused' | 'dormant' | 'claimed') {
  return renderToStaticMarkup(createElement(AgentPortrait, { address, status, size: 56 }));
}

describe('AgentPortrait', () => {
  it('is deterministic for one address and differs between addresses', () => {
    expect(markup(A)).toBe(markup(A));
    expect(markup(A)).not.toBe(markup(B));
    expect(markup(B)).not.toBe(markup(C));
    expect(portraitCells(A)).toEqual(portraitCells(A));
    expect(portraitCells(A).cells).not.toEqual(portraitCells(B).cells);
  });

  it('ignores checksum case, so an address and its lower-cased form share a face', () => {
    expect(portraitCells(C)).toEqual(portraitCells(C.toLowerCase()));
  });

  it('is symmetric: every row mirrors about the centre line', () => {
    for (const address of [A, B, C]) {
      const { cells } = portraitCells(address);
      for (let r = 0; r < 16; r++) for (let c = 0; c < 8; c++) expect(cells[r * 16 + c]).toBe(cells[r * 16 + (15 - c)]);
    }
  });

  it('has eyes and some ink', () => {
    const { cells, eyes } = portraitCells(A);
    expect(eyes.length).toBeGreaterThan(0);
    expect(cells.filter((v) => v === 2).length).toBeGreaterThan(3);
  });

  it('carries the status as data and only the awake face animates', () => {
    // The class is on the root <svg>; the hoisted stylesheet names the class too, so look at the attribute.
    expect(markup(A, 'awake')).toMatch(/<svg[^>]*class="[^"]*\bap-awake\b/);
    expect(markup(A, 'awake')).toContain('data-status="awake"');
    expect(markup(A, 'sleeping')).not.toMatch(/<svg[^>]*class="[^"]*\bap-awake\b/);
    expect(markup(A, 'sleeping')).toMatch(/<svg[^>]*class="[^"]*\bopacity-50\b/);
    expect(markup(A, 'paused')).not.toBe(markup(A, 'claimed'));
    expect(markup(A)).toContain('data-status="none"');
  });

  it('exports a deterministic sigil data URL', () => {
    const url = agentSigilDataUrl(A);
    expect(url.startsWith('data:image/svg+xml,')).toBe(true);
    expect(url).toBe(agentSigilDataUrl(A));
    expect(url).not.toBe(agentSigilDataUrl(B));
    expect(decodeURIComponent(url)).toContain('<svg');
  });
});
