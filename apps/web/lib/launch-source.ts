/**
 * The three launch paths a coin can come from, as the indexer names them in `token.source`
 * (docs/design/clanker-v5-migration.md section 6): `bootr` (RWAGMI v3 through BootrLauncher), `clanker` (Clanker v4
 * through BootrClankerLauncher) and `clanker-v5` (Clanker v5 through BootrClankerLauncherV5). No imports with side
 * effects: used by the pages, the API routes and the tests.
 */
import type { LaunchSource } from './types';

export const LAUNCH_SOURCES = ['bootr', 'clanker', 'clanker-v5'] as const satisfies readonly LaunchSource[];

export function isLaunchSource(v: unknown): v is LaunchSource {
  return typeof v === 'string' && (LAUNCH_SOURCES as readonly string[]).includes(v);
}

/** A token's `source` as the indexer sends it; older indexers omit it, which means the Bootr path. */
export function parseLaunchSource(v: unknown): LaunchSource {
  return isLaunchSource(v) ? v : 'bootr';
}

/** Launched through Clanker, either version. */
export function isClankerSource(v: unknown): v is 'clanker' | 'clanker-v5' {
  return v === 'clanker' || v === 'clanker-v5';
}

/** The Clanker version a coin was launched through: 4, 5, or null for a Bootr-path coin. */
export function clankerVersionOf(v: unknown): 4 | 5 | null {
  return v === 'clanker' ? 4 : v === 'clanker-v5' ? 5 : null;
}

/** The launcher's name, for labels: RWAGMI or Clanker (both Clanker versions read the same to people). */
export function launchPathLabel(v: unknown): 'RWAGMI' | 'Clanker' {
  return isClankerSource(v) ? 'Clanker' : 'RWAGMI';
}
