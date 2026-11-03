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
export function canonicalWorkerJson(t: { id: string; version: number; preset: WorkerPreset }): string {
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

export function workerTemplateHash(t: { id: string; version: number; preset: WorkerPreset }): Hex {
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

// ------------------------------------------------------------------------------------------ custom workers

/** Every agent-core capability a worker preset can name, in canonical order. */
export const CAPABILITY_KEYS = ['xRead', 'xReply', 'xPublish', 'research', 'memory', 'treasury', 'images'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Switched on for every agent: the fee -> fuel loop needs the treasury, and an agent without memory repeats itself. */
export const ALWAYS_ON_CAPABILITIES: readonly CapabilityKey[] = ['memory', 'treasury'];

/** User-facing copy for the launch form's Powers grid and the coin page's console. */
export const CAPABILITIES: Record<CapabilityKey, { label: string; description: string; alwaysOn?: true }> = {
  xRead: { label: 'Read X', description: 'Reads its timeline, mentions and the conversations around the coin.' },
  xReply: { label: 'Reply on X', description: 'Answers mentions and replies in threads about the coin.' },
  xPublish: { label: 'Post on X', description: 'Writes its own posts, on the cadence below.' },
  research: { label: 'Web research', description: 'Searches the web and reads pages before it speaks.' },
  images: { label: 'Images', description: 'Makes images for its posts, paid from its fuel like a thought.' },
  memory: { label: 'Memory', description: 'Keeps notes between cycles so it does not repeat itself.', alwaysOn: true },
  treasury: { label: 'Treasury', description: 'Claims its fees, keeps gas and refuels itself.', alwaysOn: true },
};

const MIN = 60 * 1000;
export const WORKER_BOUNDS = {
  minPostIntervalMs: 30 * MIN,
  maxPostIntervalMs: 7 * 24 * H,
  maxJobLines: 4,
  maxJobLineChars: 240,
} as const;

/** The cadence choices the launch form offers (milliseconds between original posts). */
export const CADENCE_OPTIONS: readonly { ms: number; label: string }[] = [
  { ms: 30 * MIN, label: 'Every 30 min' },
  { ms: 1 * H, label: 'Every hour' },
  { ms: 2 * H, label: 'Every 2 h' },
  { ms: 4 * H, label: 'Every 4 h' },
  { ms: 8 * H, label: 'Every 8 h' },
  { ms: 24 * H, label: 'Once a day' },
];

export const CUSTOM_WORKER_ID = 'custom' as const;
export const CUSTOM_WORKER_VERSION = 1;

/** A creator-defined worker: the same shape as a preset, hashed the same way, published in the agent card. */
export interface CustomWorker {
  id: typeof CUSTOM_WORKER_ID;
  version: typeof CUSTOM_WORKER_VERSION;
  preset: WorkerPreset;
  /** keccak256 of the canonical JSON of {id, version, preset}; what `BootrLauncher.launch(workerHash)` commits to. */
  hash: Hex;
}

/** Plain, bounded job line: control / zero-width / bidi characters dropped, whitespace collapsed, trimmed. */
function cleanLine(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/**
 * Validates a worker preset from the launch form, the agent API or an agent card. Capabilities are read as
 * booleans (missing = false; the always-on ones are forced true), the post interval must sit inside
 * WORKER_BOUNDS, job lines are cleaned and bounded (empty ones dropped). Null when anything is off.
 */
export function normalizeWorkerPreset(input: unknown): WorkerPreset | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as { capabilities?: unknown; postIntervalMs?: unknown; identity?: unknown; jobLines?: unknown };
  const capsIn = o.capabilities && typeof o.capabilities === 'object' ? (o.capabilities as Record<string, unknown>) : {};
  const capabilities = Object.fromEntries(
    CAPABILITY_KEYS.map((k) => [k, ALWAYS_ON_CAPABILITIES.includes(k) ? true : capsIn[k] === true]),
  ) as WorkerPreset['capabilities'];
  const interval = typeof o.postIntervalMs === 'number' ? o.postIntervalMs : typeof o.postIntervalMs === 'string' && /^\d+$/.test(o.postIntervalMs) ? Number(o.postIntervalMs) : NaN;
  if (!Number.isInteger(interval) || interval < WORKER_BOUNDS.minPostIntervalMs || interval > WORKER_BOUNDS.maxPostIntervalMs) return null;
  const rawLines = Array.isArray(o.identity) ? o.identity : Array.isArray(o.jobLines) ? o.jobLines : [];
  const identity: string[] = [];
  for (const l of rawLines) {
    const line = cleanLine(l);
    if (line === null) return null;
    if (!line) continue;
    if (line.length > WORKER_BOUNDS.maxJobLineChars) return null;
    identity.push(line);
  }
  if (identity.length > WORKER_BOUNDS.maxJobLines) return null;
  return { capabilities, postIntervalMs: interval, identity };
}

/** The custom worker for a (normalized) preset, with the hash the launch writes on-chain. */
export function customWorker(preset: WorkerPreset): CustomWorker {
  const t = { id: CUSTOM_WORKER_ID, version: CUSTOM_WORKER_VERSION, preset } as const;
  return { ...t, hash: workerTemplateHash(t) };
}

/**
 * The custom worker an agent card publishes as `bootr.worker` ({id: 'custom', version: 1, preset}), re-validated and
 * re-hashed here, so the caller can compare `hash` with the on-chain `workerHash` before trusting it. Null when the
 * card carries no usable custom worker.
 */
export function workerFromCard(card: unknown): CustomWorker | null {
  if (!card || typeof card !== 'object') return null;
  const bootr = (card as { bootr?: unknown }).bootr;
  if (!bootr || typeof bootr !== 'object') return null;
  const w = (bootr as { worker?: unknown }).worker;
  if (!w || typeof w !== 'object') return null;
  const { id, version, preset } = w as { id?: unknown; version?: unknown; preset?: unknown };
  if (id !== CUSTOM_WORKER_ID || version !== CUSTOM_WORKER_VERSION) return null;
  const p = normalizeWorkerPreset(preset);
  return p ? customWorker(p) : null;
}

/** True when `hash` is a known preset or equals the hash of `card`'s custom worker. */
export function workerKindForHash(hash: string | null | undefined, card?: unknown): WorkerTemplateId | typeof CUSTOM_WORKER_ID | null {
  const preset = workerTemplateByHash(hash);
  if (preset) return preset.id;
  if (!hash) return null;
  const custom = workerFromCard(card);
  return custom && custom.hash === hash.toLowerCase() ? CUSTOM_WORKER_ID : null;
}
