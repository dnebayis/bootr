/**
 * Rules for fetching a URL someone else chose (an agent's `read_url`, a creator's agent card, a launch image):
 * public hosts only, every address checked against private ranges, redirects followed by hand with the same check
 * on every hop, and bodies read as a stream under a byte cap, so a response that never ends or a compressed bomb
 * cannot fill the process. Node only (DNS); the web app's server routes and the supervisor share it.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type PublicHostProblem = 'url_private_host' | 'url_unresolvable_host';

export type Resolve = (host: string) => Promise<{ address: string }[]>;

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
    return false;
  }
  return true;
}

/**
 * Why `hostname` may not be fetched, or null when every address it resolves to is public. Loopback, link-local,
 * RFC1918, CGNAT, multicast and the IPv6 private ranges are refused, as are the local-only names.
 */
export async function publicHostProblem(hostname: string, resolve: Resolve = (h) => lookup(h, { all: true })): Promise<PublicHostProblem | null> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'url_private_host';
  if (isIP(host)) return isPrivateIp(host) ? 'url_private_host' : null;
  let records: { address: string }[];
  try {
    records = await resolve(host);
  } catch {
    return 'url_unresolvable_host';
  }
  if (!records.length || records.some((r) => isPrivateIp(r.address))) return 'url_private_host';
  return null;
}

/**
 * Headers for a body that is read under a cap: no compression, so what arrives is what is counted. A server may
 * still compress (fetch inflates it); the cap then holds the inflated bytes, which is the point.
 */
export const IDENTITY_ENCODING = { 'accept-encoding': 'identity' } as const;

export type CappedBody = { bytes: Uint8Array; exceeded: boolean };

/**
 * Reads `res`'s body as a stream and stops at `maxBytes`: the body is cancelled, the bytes so far come back with
 * `exceeded: true`. Nothing past the cap is ever held in memory, whatever the `content-length` says or omits.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<CappedBody> {
  if (!res.body) return { bytes: new Uint8Array(await res.arrayBuffer()).subarray(0, maxBytes), exceeded: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        total = maxBytes;
        exceeded = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (exceeded) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, exceeded };
}
