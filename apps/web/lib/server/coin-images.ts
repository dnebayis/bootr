/**
 * The image each coin's creator chose to show on Bootr, off-chain: one small JSON file next to the launch drafts, so it sits on
 * the same persistent volume (`LAUNCH_DRAFTS_DIR`). Single web instance, like the rest of the site's file state. Only the
 * creator's signature writes here (`app/api/coin/[id]/image/route.ts`); a missing or broken file reads as no overrides, so
 * every coin simply shows its on-chain image.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CoinImageMap } from '@/lib/coin-image';
import { draftsDir } from './launch-drafts';

if (typeof window !== 'undefined') throw new Error('lib/server/coin-images must not be imported in the browser');

const FILE = 'coin-images.json';

export type CoinImageEntry = { image: string; by: string; updatedAt: number };
type Stored = Record<string, CoinImageEntry>;
type Opts = { dir?: string; now?: number };

async function read(file: string): Promise<Stored> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Stored) : {};
  } catch {
    return {};
  }
}

// Writes run one after the other: each reads the whole file and replaces it.
const KEY = Symbol.for('bootr.web.coin-images-queue');
const g = globalThis as unknown as Record<symbol, Promise<unknown> | undefined>;

function write(dir: string, change: (all: Stored) => void): Promise<void> {
  const file = path.join(dir, FILE);
  const job = (g[KEY] ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const all = await read(file);
    change(all);
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2));
    await rename(tmp, file);
  });
  g[KEY] = job;
  return job;
}

/** Every override, as the site's fetchers apply them. */
export async function readCoinImages(opts: Opts = {}): Promise<CoinImageMap> {
  const all = await read(path.join(opts.dir ?? draftsDir(), FILE));
  const out: CoinImageMap = {};
  for (const [token, e] of Object.entries(all)) if (typeof e?.image === 'string' && e.image) out[token] = e.image;
  return out;
}

export function setCoinImage(token: string, image: string, by: string, opts: Opts = {}): Promise<void> {
  const entry: CoinImageEntry = { image, by: by.toLowerCase(), updatedAt: opts.now ?? Math.floor(Date.now() / 1000) };
  return write(opts.dir ?? draftsDir(), (all) => {
    all[token.toLowerCase()] = entry;
  });
}

/** Back to the on-chain image. */
export function clearCoinImage(token: string, opts: Opts = {}): Promise<void> {
  return write(opts.dir ?? draftsDir(), (all) => {
    delete all[token.toLowerCase()];
  });
}
