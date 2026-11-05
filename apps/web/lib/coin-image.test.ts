import { describe, expect, it } from 'vitest';
import { applyCoinImage, coinImageStatement } from './coin-image';

const id = `0x${'Ab'.repeat(20)}`;

describe('applyCoinImage', () => {
  it('prefers the override and keeps the original beside it, whatever the case of the address', () => {
    const t = applyCoinImage({ id, image: 'https://on.chain/a.png' }, { [id.toLowerCase()]: 'ipfs://new' });
    expect(t.image).toBe('ipfs://new');
    expect(t.imageOnChain).toBe('https://on.chain/a.png');
  });

  it('leaves a coin without an override alone', () => {
    const coin = { id, image: 'https://on.chain/a.png' };
    expect(applyCoinImage(coin, {})).toBe(coin);
    expect(applyCoinImage(coin, { [`0x${'0'.repeat(40)}`]: 'ipfs://other' })).toBe(coin);
  });

  it('cannot be tricked by a name every object inherits', () => {
    const coin = { id: 'constructor', image: 'x' };
    expect(applyCoinImage(coin, {})).toBe(coin);
  });
});

describe('coinImageStatement', () => {
  it('names the coin', () => {
    expect(coinImageStatement('BOOTR', id)).toBe(`Update the image of Bootr coin $BOOTR (${id}).`);
  });
});
