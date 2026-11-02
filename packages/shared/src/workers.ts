import { keccak256, toHex, type Hex } from 'viem';

/**
 * Worker templates: what a coin's agent is for. The creator picks one at launch; its hash goes on-chain in
 * `BootrLauncher.launch(workerHash)` and the `AgentLaunched` event, and the supervisor turns the hash back into
 * the preset below when it registers the agent (capabilities, posting cadence, the opening lines of the agent's
 * identity). The hash is the keccak256 of the template's canonical JSON (`id`, `version`, `preset`), so the
 * value on-chain commits to exactly this definition: change a preset and the hash changes with it.
 *
 * Shared by the web (launch form, agent API, docs) and the supervisor. Version 0 hashes (placeholders from the
 * first launches, keccak256("bootr-worker:<id>:v0")) still resolve to their template.
 */

export type WorkerTemplateId = 'trader' | 'researcher' | 'community';

export interface WorkerPreset {
  /** agent-core capabilities switched on for this template. */
  capabilities: { xRead: boolean; xReply: boolean; xPublish: boolean; research: boolean; memory: boolean; treasury: boolean; images: boolean };
  /** Minimum spacing between original posts, in milliseconds. */
  postIntervalMs: number;
  /** Lines the supervisor puts at the top of the agent's default identity (after the creator's own text). */
  identity: string[];
}

export interface WorkerTemplate {
  id: WorkerTemplateId;
  version: number;
  label: string;
  description: string;
  /** Short, user-facing summary of what the preset switches on. */
  does: string[];
  preset: WorkerPreset;
  /** keccak256 of the canonical JSON of {id, version, preset}. */
  hash: Hex;
}

const H = 60 * 60 * 1000;

function define(t: Omit<WorkerTemplate, 'hash'>): WorkerTemplate {
  return { ...t, hash: workerTemplateHash(t) };
}

/** Canonical JSON: fixed key order, no whitespace. */
export function canonicalWorkerJson(t: Pick<WorkerTemplate, 'id' | 'version' | 'preset'>): string {
  const c = t.preset.capabilities;
  return JSON.stringify({
    id: t.id,
    version: t.version,
    preset: {
      capabilities: { xRead: c.xRead, xReply: c.xReply, xPublish: c.xPublish, research: c.research, memory: c.memory, treasury: c.treasury, images: c.images },
      postIntervalMs: t.preset.postIntervalMs,
      identity: t.preset.identity,
    },
  });
}

export function workerTemplateHash(t: Pick<WorkerTemplate, 'id' | 'version' | 'preset'>): Hex {
  return keccak256(toHex(canonicalWorkerJson(t)));
}

export const WORKER_TEMPLATES: readonly WorkerTemplate[] = [
  define({
    id: 'trader',
    version: 1,
    label: 'Trader',
    description: 'Watches its own market, claims fees, rebalances the treasury and reports trades.',
    does: ['Posts about its own pool, fees and treasury, every ~4 h', 'Answers mentions about the coin', 'No web research', 'Claims fees and swaps WETH to USDC'],
    preset: {
      capabilities: { xRead: true, xReply: true, xPublish: true, research: false, memory: true, treasury: true, images: false },
      postIntervalMs: 4 * H,
      identity: [
        'Your job is the coin\'s own market and treasury: watch the pool, the fee claims, the swaps and the holders, and report what you see as dated facts.',
        'When you claim fees or swap, say so plainly with the numbers. Never predict prices and never tell anyone to buy or sell.',
      ],
    },
  }),
  define({
    id: 'researcher',
    version: 1,
    label: 'Researcher',
    description: 'Reads onchain data and X, posts short findings about its niche on a schedule.',
    does: ['Reads onchain data and X around its niche', 'Posts short findings every ~3 h', 'Answers mentions', 'Claims fees and keeps its treasury'],
    preset: {
      capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false },
      postIntervalMs: 3 * H,
      identity: [
        'Your job is research: read onchain data and public posts about your niche and post short, sourced findings on a steady schedule.',
        'Cite what you looked at. Separate observation from opinion. Never promise outcomes.',
      ],
    },
  }),
  define({
    id: 'community',
    version: 1,
    label: 'Community',
    description: 'Answers mentions, welcomes new holders and posts updates about the coin.',
    does: ['Answers mentions first', 'Welcomes new holders, posts coin updates every ~2 h', 'No web research', 'Claims fees and keeps its treasury'],
    preset: {
      capabilities: { xRead: true, xReply: true, xPublish: true, research: false, memory: true, treasury: true, images: false },
      postIntervalMs: 2 * H,
      identity: [
        'Your job is the people around the coin: answer mentions first, welcome new holders, and post updates about the coin and its treasury.',
        'Be warm and plain. Never hype, never promise outcomes, never tell anyone to buy or sell.',
      ],
    },
  }),
];

export const DEFAULT_WORKER_TEMPLATE: WorkerTemplateId = 'community';

/** Version-0 placeholder hashes used by the first launches (keccak256("bootr-worker:<id>:v0")). */
export const LEGACY_WORKER_HASHES: Record<Hex, WorkerTemplateId> = Object.fromEntries(
  (['trader', 'researcher', 'community'] as const).map((id) => [keccak256(toHex(`bootr-worker:${id}:v0`)), id]),
) as Record<Hex, WorkerTemplateId>;

export function workerTemplateById(id: string): WorkerTemplate | undefined {
  return WORKER_TEMPLATES.find((t) => t.id === id);
}

/** The template an on-chain `workerHash` commits to: current hashes first, then the version-0 placeholders. */
export function workerTemplateByHash(hash: string | undefined | null): WorkerTemplate | undefined {
  if (!hash) return undefined;
  const h = hash.toLowerCase() as Hex;
  return WORKER_TEMPLATES.find((t) => t.hash === h) ?? workerTemplateById(LEGACY_WORKER_HASHES[h] ?? '');
}
