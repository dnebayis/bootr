import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { directModelId, isImageModel, mindModels } from '@bootr/agent-core';

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
  // Every mind in the model catalog (`@bootr/agent-core` MODEL_CATALOG). The launch form offers these, cheapest-first per provider.
  allowedModels: mindModels().map((m) => m.id),
  xQuotas: { postsPerDay: 12, repliesPerDay: 30 },
  postIntervalMinutes: { min: 30, max: 240 },
  launchesPaused: false,
  swapLinkBase: '',
  updatedAt: null,
  updatedBy: null,
};

/**
 * `ADMIN_CONFIG_PATH` (absolute path to the JSON file) points the store at a persistent volume in
 * production, e.g. `/data/admin-config.json` on Railway. Unset = `<cwd>/data/admin-config.json`.
 * Read at call time so the value comes from the runtime environment, not the build.
 */
function configFile(): string {
  const configured = (process.env.ADMIN_CONFIG_PATH ?? '').trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), 'data', 'admin-config.json');
}

/**
 * The allow-list as the catalog knows it: a retired id (the relay's name for a model, or one BlockRun no longer serves)
 * becomes the id that stands in for it, an id nothing answers to is dropped, duplicates collapse. An allow-list that
 * ends up empty (every id retired without a stand-in) falls back to the default, so the launch form never goes blank
 * because of a stale file on the volume.
 */
export function normalizeAllowedModels(allowed: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of allowed) {
    if (typeof raw !== 'string') continue;
    const id = directModelId(raw.trim());
    if (id && !isImageModel(id) && !out.includes(id)) out.push(id);
  }
  return out.length ? out : [...DEFAULT_CONFIG.allowedModels];
}

export async function readConfig(): Promise<PlatformConfig> {
  try {
    const raw = JSON.parse(await readFile(configFile(), 'utf8')) as Partial<PlatformConfig>;
    const merged = { ...DEFAULT_CONFIG, ...raw, xQuotas: { ...DEFAULT_CONFIG.xQuotas, ...raw.xQuotas }, postIntervalMinutes: { ...DEFAULT_CONFIG.postIntervalMinutes, ...raw.postIntervalMinutes } };
    return { ...merged, allowedModels: normalizeAllowedModels(Array.isArray(raw.allowedModels) ? raw.allowedModels : DEFAULT_CONFIG.allowedModels) };
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
  const unknown = models.filter((m) => !directModelId(m) || isImageModel(directModelId(m)!));
  if (unknown.length) throw new Error(`allowedModels names models the catalog does not offer: ${unknown.join(', ')} (GET /api/models lists the ids)`);
  const min = int(pi.min, 5, 1440, 'postIntervalMinutes.min');
  const max = int(pi.max, 5, 10080, 'postIntervalMinutes.max');
  if (min > max) throw new Error('postIntervalMinutes.min must be <= max');
  const swap = typeof o.swapLinkBase === 'string' ? o.swapLinkBase.trim() : '';
  if (swap && !/^https:\/\/[^\s]+$/.test(swap)) throw new Error('swapLinkBase must be an https URL prefix');
  return {
    graduationThresholdUsd: int(o.graduationThresholdUsd, 1000, 100_000_000, 'graduationThresholdUsd'),
    allowedModels: normalizeAllowedModels(models),
    xQuotas: { postsPerDay: int(xq.postsPerDay, 0, 200, 'xQuotas.postsPerDay'), repliesPerDay: int(xq.repliesPerDay, 0, 500, 'xQuotas.repliesPerDay') },
    postIntervalMinutes: { min, max },
    launchesPaused: o.launchesPaused === true,
    swapLinkBase: swap,
  };
}

export async function writeConfig(next: Omit<PlatformConfig, 'updatedAt' | 'updatedBy'>, by: string): Promise<PlatformConfig> {
  const full: PlatformConfig = { ...next, updatedAt: Math.floor(Date.now() / 1000), updatedBy: by };
  const file = configFile();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(full, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
  return full;
}
