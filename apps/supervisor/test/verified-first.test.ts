import { describe, expect, it } from 'vitest';
import { isVerifiedAuthor, verifiedFirst } from '../src/runtime.js';

const view = (postId: string, author: { verified?: boolean; verifiedType?: 'blue' | 'business' | 'government' | 'none' }) => ({ postId, post: { author } });

describe('verified accounts first', () => {
  it('orders verified authors before the rest and keeps the order otherwise', () => {
    const views = [view('1', {}), view('2', { verified: true }), view('3', { verifiedType: 'none' }), view('4', { verifiedType: 'business' }), view('5', { verified: false })];
    expect(verifiedFirst(views).map((v) => v.postId)).toEqual(['2', '4', '1', '3', '5']);
    expect(isVerifiedAuthor({ author: { verifiedType: 'government' } })).toBe(true);
    expect(isVerifiedAuthor({ author: { verified: false, verifiedType: 'none' } })).toBe(false);
    expect(isVerifiedAuthor(null)).toBe(false);
  });
});
