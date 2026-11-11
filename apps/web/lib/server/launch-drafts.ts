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
 *
 * Bounds: at most MAX_DRAFTS files (a new id is refused past that), and `sweepDrafts` removes drafts that never
 * launched once they are DRAFT_TTL_S old, after the indexer has said no coin carries the id. A launched coin's
 * draft is kept for good: its agent card and contract URI read it.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CUSTOM_WORKER_ID, normalizeWorkerPreset, workerTemplateById, type WorkerPreset, type WorkerTemplateId } from '@bootr/shared/workers';
import { normalizeLinks, type CoinLinks } from '@/lib/coin-link-rules';
import { parseTokenSettings, type TokenSettingsInput } from '@/lib/token-settings';
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

/**
 * The coin's own links, entered in the launch form (optional) and changed later by the creator from the coin page
 * (`PUT /api/agent/[kernel]/links`, `updateLaunchDraftLinks`). The rules live in lib/coin-link-rules.ts, shared
 * with the forms; `x` is the project's account (`https://x.com/<handle>`, lib/x-link.ts), not the agent's
 * (`DraftCoin.xHandle`).
 */
export type { CoinLinks } from '@/lib/coin-link-rules';
export { normalizeLinks } from '@/lib/coin-link-rules';

/** What the contract URI shows for a coin: entered in the launch form, written with the identity text. */
export type DraftCoin = { name: string; symbol: string; image: string; imageIpfs: string | null; xHandle: string | null; links: CoinLinks };

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

/** The form's `launchThrough` (`bootr` | `clanker` | `clanker-v5`); absent means Bootr, anything else is refused. */
export function normalizeSource(input: unknown): LaunchSource | null {
  if (input === undefined || input === null || input === 'bootr') return 'bootr';
  return input === 'clanker' || input === 'clanker-v5' ? input : null;
}

/**
 * A Clanker v5 launch's token settings as the form or the agent API sent them (`lib/token-settings.ts`), checked against
 * the fallback bounds; null for anything else. Kept with the draft so the launch's choices can be read back.
 */
export function normalizeDraftTokenSettings(input: unknown): TokenSettingsInput | null {
  if (!input || typeof input !== 'object') return null;
  const r = parseTokenSettings(input, null);
  return r.ok ? r.settings : null;
}

type DraftFile = {
  identity: string;
  coin: DraftCoin | null;
  worker: DraftWorker | null;
  source: LaunchSource;
  tokenSettings: TokenSettingsInput | null;
  ownerTag: string;
  createdAt: number;
  updatedAt: number;
};

/** `source`: which launcher the launch went (or goes) through; older drafts read back as `bootr`. `tokenSettings`: Clanker v5 only. */
export type LaunchDraft = { identity: string; coin: DraftCoin | null; worker: DraftWorker | null; source: LaunchSource; tokenSettings: TokenSettingsInput | null };

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
      tokenSettings: normalizeDraftTokenSettings(raw.tokenSettings),
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
  return draft ? { identity: draft.identity, coin: draft.coin, worker: draft.worker, source: draft.source, tokenSettings: draft.tokenSettings } : null;
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

export type SaveResult = { ok: true; ownerTag: string } | { ok: false; reason: 'owned' | 'full' };

/** Draft files kept at most; a new draft id is refused past this until the sweep has made room (`reason: 'full'`). */
export const MAX_DRAFTS = 5000;
/** A draft that never launched is removed this long after its last write. The form writes it right before the launch tx. */
export const DRAFT_TTL_S = 24 * 60 * 60;
/** Stale drafts looked up per sweep, so one sweep is a bounded amount of indexer work. */
export const SWEEP_LOOKUPS = 25;
/** A temp file older than this was left by a crash mid-write. */
const TMP_TTL_S = 60 * 60;
const DRAFT_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

/** Draft files in the store (0 when the directory does not exist yet). */
export async function countDrafts(opts: { dir?: string } = {}): Promise<number> {
  try {
    return (await readdir(opts.dir ?? draftsDir())).filter((n) => DRAFT_FILE.test(n)).length;
  } catch {
    return 0;
  }
}

export type SweepResult = { removed: string[]; checked: number; stopped: boolean };

/**
 * Removes drafts that never launched: files last written more than DRAFT_TTL_S ago whose id `launched` says no
 * indexed coin carries (false). `launched` answers null when it cannot know (indexer unreachable or not caught up)
 * and the sweep stops there keeping everything, because a launched coin's card and contract URI read its draft for
 * good, so a draft only ever goes on a definite no. Temp files left by a crash go too. At most `limit` lookups.
 */
export async function sweepDrafts(launched: (draftId: string) => Promise<boolean | null>, opts: { dir?: string; now?: number; limit?: number } = {}): Promise<SweepResult> {
  const dir = opts.dir ?? draftsDir();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const limit = opts.limit ?? SWEEP_LOOKUPS;
  const result: SweepResult = { removed: [], checked: 0, stopped: false };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return result;
  }
  const ageOf = async (name: string): Promise<number | null> => {
    try {
      return now - Math.floor((await stat(path.join(dir, name))).mtimeMs / 1000);
    } catch {
      return null;
    }
  };
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const age = await ageOf(name);
    if (age !== null && age > TMP_TTL_S) {
      await unlink(path.join(dir, name)).catch(() => undefined);
      result.removed.push(name);
    }
  }
  for (const name of names.filter((n) => DRAFT_FILE.test(n)).sort()) {
    if (result.checked >= limit) break;
    const age = await ageOf(name);
    if (age === null || age < DRAFT_TTL_S) continue;
    const draftId = name.slice(0, -5);
    result.checked += 1;
    let isLaunched: boolean | null;
    try {
      isLaunched = await launched(draftId);
    } catch {
      isLaunched = null;
    }
    if (isLaunched === null) {
      result.stopped = true;
      break;
    }
    if (isLaunched) continue;
    await unlink(path.join(dir, name)).catch(() => undefined);
    result.removed.push(draftId);
  }
  return result;
}

/**
 * Stores `identity` (already normalized), `opts.coin`, `opts.worker` and `opts.source` (default `bootr`) under `draftId`. A new draft id gets a fresh owner
 * tag; an existing one is only replaced when `ownerTag` matches the stored tag, else `{ok: false, reason: 'owned'}`.
 * A new id is refused with `{ok: false, reason: 'full'}` once the store holds `opts.cap` (default MAX_DRAFTS) drafts.
 * Writes are atomic (temp file + rename).
 */
export async function saveDraftIdentity(
  draftId: string,
  identity: string,
  ownerTag: string | null,
  opts: { dir?: string; now?: number; coin?: DraftCoin | null; worker?: DraftWorker | null; source?: LaunchSource; tokenSettings?: TokenSettingsInput | null; cap?: number } = {},
): Promise<SaveResult> {
  const dir = opts.dir ?? draftsDir();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const file = fileFor(dir, draftId);
  const existing = await readDraft(dir, draftId);
  if (existing && !(ownerTag && OWNER_TAG.test(ownerTag) && timingSafeEqual(ownerTag, existing.ownerTag))) return { ok: false, reason: 'owned' };
  if (!existing && (await countDrafts({ dir })) >= (opts.cap ?? MAX_DRAFTS)) return { ok: false, reason: 'full' };
  const tag = existing ? existing.ownerTag : randomTag();
  const next: DraftFile = {
    identity,
    coin: opts.coin ?? null,
    worker: opts.worker ?? null,
    source: opts.source ?? 'bootr',
    tokenSettings: opts.source === 'clanker-v5' ? (opts.tokenSettings ?? null) : null,
    ownerTag: tag, createdAt: existing?.createdAt || now, updatedAt: now };
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomTag().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(next) + '\n', 'utf8');
  await rename(tmp, file);
  return { ok: true, ownerTag: tag };
}

export type UpdateLinksResult = { ok: true } | { ok: false; reason: 'missing' | 'no_coin' };

/**
 * Replaces the coin links of a stored draft: the creator's edit from the coin page after the launch, so no owner
 * tag is needed (the route proved the creator wallet). `{ok: false, reason: 'missing'}` when no draft is stored
 * under `draftId`, `'no_coin'` when the draft carries no coin metadata to attach links to (such a draft never
 * backed a contract URI). Writes are atomic (temp file + rename); the next `GET /tokens/<id>.json` reads the file.
 */
export async function updateLaunchDraftLinks(draftId: string, links: CoinLinks, opts: { dir?: string; now?: number } = {}): Promise<UpdateLinksResult> {
  if (!isDraftId(draftId)) return { ok: false, reason: 'missing' };
  const dir = opts.dir ?? draftsDir();
  const existing = await readDraft(dir, draftId);
  if (!existing) return { ok: false, reason: 'missing' };
  if (!existing.coin) return { ok: false, reason: 'no_coin' };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const next: DraftFile = { ...existing, coin: { ...existing.coin, links: { ...links } }, updatedAt: now };
  const file = fileFor(dir, draftId);
  const tmp = `${file}.${process.pid}.${randomTag().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(next) + '\n', 'utf8');
  await rename(tmp, file);
  return { ok: true };
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
