import { ReviewError } from '@/lib/indexer';

/**
 * One call inside the console's signed session (`/api/agent/:kernel/<path>`, the shape the inbox, the review queue and
 * the chat use): the body carries the session token or a fresh signature, the answer may carry a token to keep. A
 * refusal is a `ReviewError`; status 401 means the session ran out and the creator signs again.
 */
export async function consolePost<T>(kernel: string, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/agent/${encodeURIComponent(kernel.toLowerCase())}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ReviewError(res.status, err.error ?? `http_${res.status}`, err.message ?? `The request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

/** "in 35 min", "in 3 h", "in 2 days"; "now" for a time that has come. `nowMs` 0 (before the clock ticked) gives ''. */
export function untilLabel(iso: string, nowMs: number): string {
  const ms = Date.parse(iso) - nowMs;
  if (!nowMs || !Number.isFinite(ms)) return '';
  if (ms <= 60_000) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/** "Fri 14 Nov, 10:00" in the viewer's own time zone. */
export function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
