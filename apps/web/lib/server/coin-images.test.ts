import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearCoinImage, readCoinImages, setCoinImage } from './coin-images';

const A = `0x${'Aa'.repeat(20)}`;
const B = `0x${'bb'.repeat(20)}`;
const dir = () => mkdtemp(path.join(tmpdir(), 'coin-images-'));

describe('coin image store', () => {
  it('reads nothing before the first write, and from a broken file', async () => {
    const d = await dir();
    expect(await readCoinImages({ dir: d })).toEqual({});
    await writeFile(path.join(d, 'coin-images.json'), '{not json');
    expect(await readCoinImages({ dir: d })).toEqual({});
  });

  it('keeps one image per coin under the lowercase address', async () => {
    const d = await dir();
    await setCoinImage(A, 'ipfs://one', B, { dir: d });
    await setCoinImage(A.toLowerCase(), 'ipfs://two', B, { dir: d });
    expect(await readCoinImages({ dir: d })).toEqual({ [A.toLowerCase()]: 'ipfs://two' });
  });

  it('goes back to the original', async () => {
    const d = await dir();
    await setCoinImage(A, 'ipfs://one', B, { dir: d });
    await setCoinImage(B, 'ipfs://two', B, { dir: d });
    await clearCoinImage(A, { dir: d });
    expect(await readCoinImages({ dir: d })).toEqual({ [B]: 'ipfs://two' });
  });

  it('loses nothing when writes arrive together', async () => {
    const d = await dir();
    const ids = Array.from({ length: 12 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
    await Promise.all(ids.map((id) => setCoinImage(id, `ipfs://${id}`, A, { dir: d })));
    expect(Object.keys(await readCoinImages({ dir: d })).sort()).toEqual([...ids].sort());
  });
});
