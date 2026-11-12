/**
 * Server-side IPFS pinning for `/api/upload`: content sniffing, SVG screening, Pinata pinning and a
 * per-IP rate limit. Import only from route handlers.
 *
 * Pinata API: the v3 Files API, `POST https://uploads.pinata.cloud/v3/files` (multipart `file`,
 * `network=public`, `name`, `keyvalues`; `Authorization: Bearer <PINATA_JWT>`, scope
 * `org:files:write`) -> `{ data: { id, cid, name, size, mime_type, ... } }`. The legacy
 * `pinFileToIPFS` endpoint is only still recommended for folder uploads, which we do not need.
 * `network=public` matters: v3 uploads default to the private network, which no public gateway serves.
 */
import { UPLOAD_MAX_BYTES } from '@/lib/ipfs';
import { pinataEnv } from './env';

if (typeof window !== 'undefined') throw new Error('lib/server/ipfs must not be imported in the browser');

export const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';
const PIN_TIMEOUT_MS = 30_000;

export type ImageKind = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

const EXT: Record<ImageKind | 'application/json', string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/json': 'json',
};

function startsWith(b: Uint8Array, sig: number[], at = 0): boolean {
  return b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
}

/** Image type from the file's leading bytes (never from the declared content type). Null when not an accepted image. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'; // RIFF....WEBP
  if (svgText(b) !== null) return 'image/svg+xml';
  return null;
}

/** UTF-8 text of an SVG document (optional BOM, XML declaration and comments before `<svg`), else null. */
function svgText(b: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
  text = text.replace(/^﻿/, '').trimStart();
  return /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text) ? text : null;
}

/**
 * Screens an SVG for active or external content. We reject rather than rewrite: a token image has
 * no reason to carry any of this, and an SVG opened directly from the gateway would run scripts.
 * Returns the reason, or null when the SVG is acceptable.
 */
export function svgProblem(b: Uint8Array): string | null {
  const text = svgText(b);
  if (text === null) return 'not an SVG document';
  if (/<script/i.test(text)) return 'scripts are not allowed';
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return 'DOCTYPE and entity declarations are not allowed';
  if (/<(?:foreignObject|iframe|embed|object|audio|video)\b/i.test(text)) return 'embedded documents and media are not allowed';
  if (/[\s"'/]on[a-z]+\s*=/i.test(text)) return 'event handler attributes are not allowed';
  if (/javascript:|vbscript:|data:text\/html|@import/i.test(text)) return 'script URLs and imports are not allowed';
  if (/\ssrc\s*=/i.test(text)) return 'external references are not allowed';
  for (const m of text.matchAll(/(?:xlink:)?href\s*=\s*(["']?)\s*([^"'\s>]*)/gi)) {
    if (!m[2]!.startsWith('#')) return 'external references are not allowed (only #fragment hrefs)';
  }
  for (const m of text.matchAll(/url\(\s*(["']?)\s*([^"')\s]*)/gi)) {
    if (!m[2]!.startsWith('#')) return 'external references are not allowed (only url(#id))';
  }
  return null;
}

const DECLARED: Record<string, ImageKind> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/svg+xml': 'image/svg+xml',
};

export type ImageCheck = { ok: true; bytes: Uint8Array; type: ImageKind } | { ok: false; status: number; error: string; message: string };

/** An uploaded image as both upload routes accept it: at most 2 MB, type from its bytes and matching its label, SVGs screened. */
export async function checkImageFile(file: FormDataEntryValue | null): Promise<ImageCheck> {
  if (!(file instanceof File) || file.size === 0) return { ok: false, status: 400, error: 'invalid_request', message: 'Expected multipart/form-data with a "file" field.' };
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: 'payload_too_large', message: 'Image must be at most 2 MB.' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) return { ok: false, status: 415, error: 'unsupported_type', message: 'Use a PNG, JPG, WebP or SVG image.' };
  const declared = file.type ? DECLARED[file.type.toLowerCase()] : type;
  if (declared !== type) return { ok: false, status: 415, error: 'unsupported_type', message: 'The file content does not match its type. Use a PNG, JPG, WebP or SVG image.' };
  if (type === 'image/svg+xml') {
    const problem = svgProblem(bytes);
    if (problem) return { ok: false, status: 415, error: 'unsafe_svg', message: `SVG refused: ${problem}.` };
  }
  return { ok: true, bytes, type };
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Mock-mode CID: a well-formed CIDv1 (raw codec, sha2-256, base32 `b…`) of the bytes. Deterministic,
 * but not the CID Pinata would return (Pinata builds a UnixFS DAG) and not resolvable on any gateway.
 */
export async function mockCid(b: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)));
  return 'b' + base32(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]));
}

export function isCid(v: string): boolean {
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(v) || /^b[a-z2-7]{50,}$/.test(v);
}

export class PinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Pins one file to public IPFS through Pinata (or computes a mock CID). Returns the CID. */
export async function pinFile(bytes: Uint8Array, type: ImageKind | 'application/json', name: string, keyvalues: Record<string, string>): Promise<{ cid: string; mock: boolean }> {
  const { jwt, mock } = pinataEnv();
  if (mock) return { cid: await mockCid(bytes), mock: true };
  if (!jwt) throw new PinError('PINATA_JWT is not set');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), `${name.split('/').pop()}.${EXT[type]}`);
  form.append('network', 'public');
  form.append('name', name);
  form.append('keyvalues', JSON.stringify(keyvalues));
  let res: Response;
  try {
    res = await fetch(PINATA_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
      signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (e) {
    throw new PinError(`Pinata unreachable: ${(e as Error).name}`);
  }
  if (!res.ok) throw new PinError(`Pinata answered ${res.status}`, res.status);
  const body = (await res.json().catch(() => null)) as { data?: { cid?: unknown } } | null;
  const cid = typeof body?.data?.cid === 'string' ? body.data.cid : '';
  if (!isCid(cid)) throw new PinError('Pinata response has no CID');
  return { cid, mock: false };
}

/**
 * Fixed-window, in-memory rate limiter (per instance: with several replicas the effective limit is
 * multiplied by the replica count).
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records one hit. Returns 0 when allowed, else the seconds until the window resets. */
  hit(key: string, now = Date.now()): number {
    let e = this.hits.get(key);
    if (!e || e.reset <= now) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count += 1;
    return e.count > this.limit ? Math.max(1, Math.ceil((e.reset - now) / 1000)) : 0;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    // Still full (a flood of distinct keys): start over rather than grow without bound.
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}

const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * An address as a limiter keys it, or null when the text is not an address: an IPv4 address whole, an IPv6 address by
 * its first 64 bits (one subscriber holds a whole /64 and can use a new address of it for every request), an
 * IPv4-mapped IPv6 address as its IPv4 address.
 */
export function ipKey(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim().toLowerCase();
  if (!text || text.length > 45) return null;
  if (IPV4_RE.test(text)) return text;
  if (!text.includes(':')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string): string[] | null => {
    if (part === '') return [];
    const out: string[] = [];
    const pieces = part.split(':');
    for (const [i, piece] of pieces.entries()) {
      if (i === pieces.length - 1 && IPV4_RE.test(piece)) {
        // A dotted tail stands for the last two groups.
        const [a, b, c, d] = piece.split('.').map(Number) as [number, number, number, number];
        out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) out.push(piece.replace(/^0+(?=.)/, ''));
      else return null;
    }
    return out;
  };
  const head = groupsOf(halves[0]!);
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array.from({ length: Math.max(missing, 0) }, () => '0'), ...tail];
  if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
    const [hi, lo] = [parseInt(groups[6]!, 16), parseInt(groups[7]!, 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** `TRUSTED_PROXY=cloudflare`: the site sits behind Cloudflare, and the origin takes connections from Cloudflare only. */
export function trustedProxy(): 'cloudflare' | null {
  return (process.env.TRUSTED_PROXY ?? '').trim().toLowerCase() === 'cloudflare' ? 'cloudflare' : null;
}

/**
 * Client IP for rate limiting.
 *
 * Unset (the default): `X-Real-IP` as the hosting edge set it (Railway), otherwise the last `X-Forwarded-For` hop,
 * i.e. the one our own proxy appended; earlier hops are client-controlled. Behind Cloudflare and Traefik that is not
 * the visitor: it is a Cloudflare address shared by many visitors, or, when the origin can be reached around
 * Cloudflare, whatever the caller wrote.
 *
 * `TRUSTED_PROXY=cloudflare`: the address Cloudflare saw, `CF-Connecting-IP`, and nothing else; an IPv6 visitor is
 * keyed by its /64 (`ipKey`). A request without a well-formed one did not come through Cloudflare and shares the one
 * key `unknown` with every other such request. This is only as good as the origin's firewall: `CF-Connecting-IP` is a
 * header like any other to a caller who reaches the origin directly, so the origin must admit Cloudflare's ranges
 * only (docs/deploy/coolify.md).
 */
export function clientIp(headers: Headers): string {
  if (trustedProxy() === 'cloudflare') return ipKey(headers.get('cf-connecting-ip')) ?? 'unknown';
  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;
  const xff = headers.get('x-forwarded-for');
  const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).pop();
  return last || 'unknown';
}
