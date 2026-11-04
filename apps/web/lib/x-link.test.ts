import { describe, expect, it } from 'vitest';
import { normalizeXLink, xHandleOfUrl } from './x-link';

describe("the project's X link", () => {
  it('normalizes a handle or an x.com / twitter.com URL to https://x.com/<handle>', () => {
    expect(normalizeXLink('@bootrfun')).toBe('https://x.com/bootrfun');
    expect(normalizeXLink('bootrfun')).toBe('https://x.com/bootrfun');
    expect(normalizeXLink(' @Bootr_Fun ')).toBe('https://x.com/Bootr_Fun');
    expect(normalizeXLink('https://x.com/bootrfun')).toBe('https://x.com/bootrfun');
    expect(normalizeXLink('https://x.com/@bootrfun/')).toBe('https://x.com/bootrfun');
    expect(normalizeXLink('https://twitter.com/bootrfun?s=21')).toBe('https://x.com/bootrfun');
    expect(normalizeXLink('https://www.x.com/bootrfun')).toBe('https://x.com/bootrfun');
    expect(normalizeXLink('http://mobile.twitter.com/bootrfun')).toBe('https://x.com/bootrfun');
  });
  it('is null when empty and undefined when it is not an X profile', () => {
    expect(normalizeXLink(undefined)).toBeNull();
    expect(normalizeXLink(null)).toBeNull();
    expect(normalizeXLink('')).toBeNull();
    expect(normalizeXLink('   ')).toBeNull();
    expect(normalizeXLink(42)).toBeUndefined();
    expect(normalizeXLink('@')).toBeUndefined();
    expect(normalizeXLink('a_handle_that_is_too_long')).toBeUndefined();
    expect(normalizeXLink('bad handle')).toBeUndefined();
    expect(normalizeXLink('https://x.com/')).toBeUndefined();
    expect(normalizeXLink('https://x.com/bootrfun/status/1')).toBeUndefined();
    expect(normalizeXLink('https://x.com/i/flow/login')).toBeUndefined();
    expect(normalizeXLink('https://example.com/bootrfun')).toBeUndefined();
    expect(normalizeXLink('javascript:alert(1)')).toBeUndefined();
    expect(normalizeXLink(`https://x.com/${'a'.repeat(200)}`)).toBeUndefined();
  });
  it('reads the handle back out of a profile URL', () => {
    expect(xHandleOfUrl('https://x.com/bootrfun')).toBe('bootrfun');
    expect(xHandleOfUrl('https://twitter.com/BootrFun/')).toBe('BootrFun');
    expect(xHandleOfUrl('https://x.com/bootrfun/status/1')).toBeNull();
    expect(xHandleOfUrl('https://bootr.fun')).toBeNull();
  });
});
