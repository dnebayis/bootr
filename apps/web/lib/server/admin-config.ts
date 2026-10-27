import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Platform config, file-backed for now.
 * TODO(postgres): move to the shared Postgres (DATABASE_URL) so indexer/supervisor replicas read one source.
 */
export type PlatformConfig = {
  graduationThresholdUsd: number;
  allowedModels: string[];
  xQuotas: { postsPerDay: number; repliesPerDay: number };
  postIntervalMinutes: { min: number; max: number };
  launchesPaused: boolean;
  swapLinkBase: string;
  updatedAt: number | null;
  updatedBy: string | null;
};

export const DEFAULT_CONFIG: PlatformConfig = {
  graduationThresholdUsd: 50_000,
  allowedModels: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'gpt-4.1-mini', 'llama-3.3-70b'],
  xQuotas: { postsPerDay: 12, repliesPerDay: 30 },
  postIntervalMinutes: { min: 30, max: 240 },
  launchesPaused: false,
  swapLinkBase: '',
  updatedAt: null,
  updatedBy: null,
};

const FILE = path.join(process.cwd(), 'data', 'admin-config.json');

export async function readConfig(): Promise<PlatformConfig> {
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8')) as Partial<PlatformConfig>;
    return { ...DEFAULT_CONFIG, ...raw, xQuotas: { ...DEFAULT_CONFIG.xQuotas, ...raw.xQuotas }, postIntervalMinutes: { ...DEFAULT_CONFIG.postIntervalMinutes, ...raw.postIntervalMinutes } };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function int(v: unknown, min: number, max: number, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return Math.round(n);
}

export function validateConfig(input: unknown): Omit<PlatformConfig, 'updatedAt' | 'updatedBy'> {
  const o = (input ?? {}) as Record<string, unknown>;
  const xq = (o.xQuotas ?? {}) as Record<string, unknown>;
  const pi = (o.postIntervalMinutes ?? {}) as Record<string, unknown>;
  const models = Array.isArray(o.allowedModels) ? o.allowedModels.map(String).map((s) => s.trim()).filter(Boolean) : [];
  if (models.length === 0) throw new Error('allowedModels must list at least one model');
  if (models.some((m) => !/^[\w.:/-]{1,80}$/.test(m))) throw new Error('allowedModels contains an invalid id');
  const min = int(pi.min, 5, 1440, 'postIntervalMinutes.min');
  const max = int(pi.max, 5, 10080, 'postIntervalMinutes.max');
  if (min > max) throw new Error('postIntervalMinutes.min must be <= max');
  const swap = typeof o.swapLinkBase === 'string' ? o.swapLinkBase.trim() : '';
  if (swap && !/^https:\/\/[^\s]+$/.test(swap)) throw new Error('swapLinkBase must be an https URL prefix');
  return {
    graduationThresholdUsd: int(o.graduationThresholdUsd, 1000, 100_000_000, 'graduationThresholdUsd'),
    allowedModels: [...new Set(models)],
    xQuotas: { postsPerDay: int(xq.postsPerDay, 0, 200, 'xQuotas.postsPerDay'), repliesPerDay: int(xq.repliesPerDay, 0, 500, 'xQuotas.repliesPerDay') },
    postIntervalMinutes: { min, max },
    launchesPaused: o.launchesPaused === true,
    swapLinkBase: swap,
  };
}

export async function writeConfig(next: Omit<PlatformConfig, 'updatedAt' | 'updatedBy'>, by: string): Promise<PlatformConfig> {
  const full: PlatformConfig = { ...next, updatedAt: Math.floor(Date.now() / 1000), updatedBy: by };
  await mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(full, null, 2) + '\n', 'utf8');
  await rename(tmp, FILE);
  return full;
}
