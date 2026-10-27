import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseKey(hex: string): Buffer {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32 || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('encryption key must be 32 bytes of hex');
  }
  return key;
}

/**
 * AES-256-GCM. Output: `v1.<base64url(iv | tag | ciphertext)>`.
 * `aad` binds the ciphertext to its context (e.g. `access:<agentId>`) so a ciphertext copied
 * into another row or column fails to decrypt.
 */
export function encrypt(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, ct]).toString('base64url')}`;
}

export function decrypt(payload: string, key: Buffer, aad: string): string {
  const [version, body] = payload.split('.');
  if (version !== VERSION || !body) throw new Error('unsupported ciphertext format');
  const raw = Buffer.from(body, 'base64url');
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Constant-time comparison of two strings (any charset). */
export function safeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Deterministic JSON (sorted keys) for hashing and receipt signatures. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
