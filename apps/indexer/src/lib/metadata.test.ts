import { describe, expect, it } from 'vitest';

import { imageFromUri } from './metadata';

describe('imageFromUri', () => {
  it('reads `image` from inline and base64 JSON data URIs and plain JSON', () => {
    const doc = JSON.stringify({ name: 'Coin', image: 'ipfs://bafy/img.png' });
    expect(imageFromUri(`data:application/json;utf8,${encodeURIComponent(doc)}`)).toBe('ipfs://bafy/img.png');
    expect(imageFromUri(`data:application/json;base64,${Buffer.from(doc).toString('base64')}`)).toBe('ipfs://bafy/img.png');
    expect(imageFromUri(doc)).toBe('ipfs://bafy/img.png');
    expect(imageFromUri('data:application/json,{"name":"x"}')).toBe('');
  });

  it('accepts a URI that already is an image and rejects other URIs', () => {
    expect(imageFromUri('https://cdn.bootr.fun/c/abc.webp?v=2')).toBe('https://cdn.bootr.fun/c/abc.webp?v=2');
    expect(imageFromUri('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(imageFromUri('https://bootr.fun/meta/abc.json')).toBe('');
    expect(imageFromUri('')).toBe('');
    expect(imageFromUri('data:application/json;base64,!!!')).toBe('');
  });
});
