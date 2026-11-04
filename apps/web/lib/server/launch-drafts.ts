/**
 * Launch drafts: the creator's "Identity" text and the coin's display metadata, stored per launch draft id
 * before the launch transaction.
 *
 * The launch form posts `{draftId, identity, coin, worker}` to `POST /api/launch/draft` right before it sends
 * the launch tx. All three are kept here, one small JSON file per draft id. The text is published in the hosted
 * ERC-8004 agent card (`/agents/<draftId>.json`, field `bootr.identity`), where the supervisor reads it
 * when it registers the launch (apps/supervisor/src/agent-card.ts; see docs/agent-identity.md). A custom
 * worker's preset is published there too (`bootr.worker`; docs/design/agent-launch-v2.md). The coin
 * metadata backs the token's ERC-7572 contract URI (`/tokens/<draftId>.json`).
 *
 * Ownership: the first write of a draft id answers with a random owner tag that the route sets as an
 * HttpOnly cookie. The draft id becomes public on-chain at launch (BootrLauncher `LaunchContext` event), so
 * a later write needs the matching tag; without it the stored text cannot be replaced by someone who
 * only knows the id. The browser that wrote it can still change the text until it launches.
 *
 * `LAUNCH_DRAFTS_DIR` points the store at a persistent volume in production (`/data/launch-drafts` on
 * Railway, set in apps/web/Dockerfile). Unset = next to the admin config (`ADMIN_CONFIG_PATH`'s
 * directory), else `<cwd>/data/launch-drafts`. Read at call time, not at build.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CUSTOM_WORKER_ID, normalizeWorkerPreset, workerTemplateById, type WorkerPreset, type WorkerTemplateId } from '@bootr/shared/workers';
import type { LaunchSource } from '@/lib/types';

if (typeof window !== 'undefined') throw new Error('lib/server/launch-drafts must not be imported in the browser');

/** Same bounds as the launch form (`Instructions`, 20 to 600 characters). */
export const MIN_IDENTITY_CHARS = 20;
export const MAX_IDENTITY_CHARS = 600;

export const OWNER_COOKIE = 'bootr_launch_drafts';
export const OWNER_COOKIE_PATH = '/api/launch';
export const OWNER_TTL_S = 24 * 60 * 60;
/** Drafts remembered per browser (one per open launch tab is plenty). */
const MAX_OWNED = 4;

const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_TAG = /^[0-9a-f]{32}$/;

/** Launch draft ids are browser-generated `crypto.randomUUID()` (lowercase v4). */
export function isDraftId(v: unknown): v is string {
  return typeof v === 'string' && DRAFT_ID.test(v);
}

/**
 * Plain text, bounded: line endings and tabs normalized, control / zero-width / bidi characters dropped,
 * whitespace runs collapsed, trimmed. Null when the result is shorter than MIN_IDENTITY_CHARS or longer
 * than MAX_IDENTITY_CHARS (counted in UTF-16 units, like the form's `maxLength`).
 */
export function normalizeIdentity(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/[ \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length < MIN_IDENTITY_CHARS || text.length > MAX_IDENTITY_CHARS) return null;
  return text;
}

export function draftsDir(): string {
  const configured = (process.env.LAUNCH_DRAFTS_DIR ?? '').trim();
  if (configured) return path.resolve(configured);
  const adminConfig = (process.env.ADMIN_CONFIG_PATH ?? '').trim();
  if (adminConfig) return path.join(path.dirname(path.resolve(adminConfig)), 'launch-drafts');
  return path.join(process.cwd(), 'data', 'launch-drafts');
}

/** The coin's own links, entered in the launch form (optional). `website` any https URL; the others their own hosts. */
export type CoinLinks = { website: string | null; telegram: string | null; discord: string | null };

/** What the contract URI shows for a coin: entered in the launch form, written with the identity text. */
export type DraftCoin = { name: string; symbol: string; image: string; imageIpfs: string | null; xHandle: string | null; links: CoinLinks };

const MAX_LINK = 200;
const LINK_HOST: Record<keyof CoinLinks, RegExp | null> = {
  website: null,
  telegram: /^https:\/\/t\.me\//i,
  discord: /^https:\/\/(discord\.gg|discord\.com\/invite)\//i,
};

/** One optional link: null when absent or empty, undefined when present but not an https URL of its kind. */
function normalizeLink(kind: keyof CoinLinks, v: unknown): string | null | undefined {
  if (v == null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return null;
  if (s.length > MAX_LINK || !/^https:\/\/[^\s"<>]+$/.test(s)) return undefined;
  const host = LINK_HOST[kind];
  return host && !host.test(s) ? undefined : s;
}

/** The form's links, or null when any of them is not acceptable. Missing fields (older drafts) are null. */
export function normalizeLinks(input: unknown): CoinLinks | null {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const website = normalizeLink('website', o.website);
  const telegram = normalizeLink('telegram', o.telegram);
  const discord = normalizeLink('discord', o.discord);
  if (website === undefined || telegram === undefined || discord === undefined) return null;
  return { website, telegram, discord };
}

/** Validates the form's coin metadata (same bounds as the form); null when anything is off. */
export function normalizeCoin(input: unknown): DraftCoin | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  const name = typeof c.name === 'string' ? c.name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '').trim() : '';
  const symbol = typeof c.symbol === 'string' ? c.symbol : '';
  const image = typeof c.image === 'string' ? c.image : '';
  const imageIpfs = c.imageIpfs == null ? null : typeof c.imageIpfs === 'string' ? c.imageIpfs : undefined;
  const xHandle = c.xHandle == null ? null : typeof c.xHandle === 'string' ? c.xHandle : undefined;
  if (!name || name.length > 48) return null;
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return null;
  if (image.length > 512 || !/^https?:\/\/[^\s"<>]+$/.test(image)) return null;
  if (imageIpfs === undefined || (imageIpfs !== null && !/^ipfs:\/\/[A-Za-z0-9./_-]{1,200}$/.test(imageIpfs))) return null;
  if (xHandle === undefined || (xHandle !== null && !/^[A-Za-z0-9_]{1,15}$/.test(xHandle))) return null;
  const links = normalizeLinks(c.links);
  if (!links) return null;
  return { name, symbol, image, imageIpfs, xHandle, links };
}

/**
 * What the agent is for, as picked in the launch form: a preset (its template hash goes on-chain) or a custom worker
 * whose preset is published in the agent card (`bootr.worker`) so the supervisor can recompute the on-chain hash.
 */
export type DraftWorker = { kind: WorkerTemplateId } | { kind: typeof CUSTOM_WORKER_ID; preset: WorkerPreset };

/** The form's `worker: {kind, preset?}`; null when it is not a template id or not a valid custom preset. */
export function normalizeWorker(input: unknown): DraftWorker | null {
  if (!input || typeof input !== 'object') return null;
  const { kind, preset } = input as { kind?: unknown; preset?: unknown };
  if (typeof kind !== 'string') return null;
  if (kind === CUSTOM_WORKER_ID) {
    const p = normalizeWorkerPreset(preset);
    return p ? { kind: CUSTOM_WORKER_ID, preset: p } : null;
  }
  const template = workerTemplateById(kind);
  return template ? { kind: template.id } : null;
}

/** The form's `launchThrough` (`bootr` | `clanker`); absent means Bootr, anything else is refused. */
export function normalizeSource(input: unknown): LaunchSource | null {
  if (input === undefined || input === null || input === 'bootr') return 'bootr';
  return input === 'clanker' ? 'clanker' : null;
}

type DraftFile = { identity: string; coin: DraftCoin | null; worker: DraftWorker | null; source: LaunchSource; ownerTag: string; createdAt: number; updatedAt: number };

/** `source`: which launcher the launch went (or goes) through; older drafts read back as `bootr`. */
export type LaunchDraft = { identity: string; coin: DraftCoin | null; worker: DraftWorker | null; source: LaunchSource };

function fileFor(dir: string, draftId: string): string {
  if (!isDraftId(draftId)) throw new Error('not a draft id');
  return path.join(dir, `${draftId}.json`);
}

async function readDraft(dir: string, draftId: string): Promise<DraftFile | null> {
  try {
    const raw = JSON.parse(await readFile(fileFor(dir, draftId), 'utf8')) as Partial<DraftFile>;
    if (typeof raw.identity !== 'string' || typeof raw.ownerTag !== 'string') return null;
    return {
      identity: raw.identity,
      coin: normalizeCoin(raw.coin),
      worker: normalizeWorker(raw.worker),
      source: normalizeSource(raw.source) ?? 'bootr',
      ownerTag: raw.ownerTag,
      createdAt: Number(raw.createdAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

/** The stored identity text for a draft id, or null when none was saved. Never throws. */
export async function readDraftIdentity(draftId: string, opts: { dir?: string } = {}): Promise<string | null> {
  if (!isDraftId(draftId)) return null;
  const draft = await readDraft(opts.dir ?? draftsDir(), draftId);
  return draft ? draft.identity : null;
}

/** The stored identity text, coin metadata and worker choice for a draft id, or null when none was saved. Never throws. */
export async function readLaunchDraft(draftId: string, opts: { dir?: string } = {}): Promise<LaunchDraft | null> {
  if (!isDraftId(draftId)) return null;
  const draft = await readDraft(opts.dir ?? draftsDir(), draftId);
  return draft ? { identity: draft.identity, coin: draft.coin, worker: draft.worker, source: draft.source } : null;
}

function randomTag(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type SaveResult = { ok: true; ownerTag: string } | { ok: false; reason: 'owned' };

/**
 * Stores `identity` (already normalized), `opts.coin`, `opts.worker` and `opts.source` (default `bootr`) under `draftId`. A new draft id gets a fresh owner
 * tag; an existing one is only replaced when `ownerTag` matches the stored tag, else `{ok: false, reason: 'owned'}`.
 * Writes are atomic (temp file + rename).
 */
export async function saveDraftIdentity(
  draftId: string,
  identity: string,
  ownerTag: string | null,
  opts: { dir?: string; now?: number; coin?: DraftCoin | null; worker?: DraftWorker | null; source?: LaunchSource } = {},
): Promise<SaveResult> {
  const dir = opts.dir ?? draftsDir();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const file = fileFor(dir, draftId);
  const existing = await readDraft(dir, draftId);
  if (existing && !(ownerTag && OWNER_TAG.test(ownerTag) && timingSafeEqual(ownerTag, existing.ownerTag))) return { ok: false, reason: 'owned' };
  const tag = existing ? existing.ownerTag : randomTag();
  const next: DraftFile = { identity, coin: opts.coin ?? null, worker: opts.worker ?? null, source: opts.source ?? 'bootr', ownerTag: tag, createdAt: existing?.createdAt || now, updatedAt: now };
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomTag().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(next) + '\n', 'utf8');
  await rename(tmp, file);
  return { ok: true, ownerTag: tag };
}

// ------------------------------------------------------------------ owner cookie (`<id>.<tag>~<id>.<tag>`)

export function parseOwnerCookie(value: string | undefined): { id: string; tag: string }[] {
  return (value ?? '')
    .split('~')
    .map((p) => {
      const [id, tag] = p.split('.');
      return { id: id ?? '', tag: tag ?? '' };
    })
    .filter((d) => isDraftId(d.id) && OWNER_TAG.test(d.tag));
}

/** The tag this browser holds for `draftId`, or null. */
export function ownerTagFromCookie(value: string | undefined, draftId: string): string | null {
  return parseOwnerCookie(value).find((d) => d.id === draftId)?.tag ?? null;
}

/** Cookie value after saving `draftId` with `tag` (most recent first, at most MAX_OWNED). */
export function ownerCookieValue(current: string | undefined, draftId: string, tag: string): string {
  const rest = parseOwnerCookie(current).filter((d) => d.id !== draftId);
  return [{ id: draftId, tag }, ...rest]
    .slice(0, MAX_OWNED)
    .map((d) => `${d.id}.${d.tag}`)
    .join('~');
}
