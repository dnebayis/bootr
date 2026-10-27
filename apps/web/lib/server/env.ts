/**
 * Server-only configuration. Read at call time from `process.env` (never inlined into a client bundle:
 * none of these are NEXT_PUBLIC_*). Import only from route handlers / server code.
 */
if (typeof window !== 'undefined') throw new Error('lib/server/env must not be imported in the browser');

function str(v: string | undefined): string {
  return (v ?? '').trim();
}

export type SenderServerEnv = {
  /** HMAC key shared with apps/sender (SENDER_SERVICE_KEY); null when unset or too short. */
  serviceKey: string | null;
  /** Browser-facing sender origin used for the `/oauth/start` redirect. */
  publicUrl: string;
  /** Server-to-server sender origin used for the internal API (SENDER_URL, else the public URL). */
  internalUrl: string;
};

export function senderEnv(): SenderServerEnv {
  const key = str(process.env.SENDER_SERVICE_KEY);
  const publicUrl = (str(process.env.NEXT_PUBLIC_SENDER_PUBLIC_URL) || str(process.env.SENDER_URL)).replace(/\/$/, '');
  const internalUrl = (str(process.env.SENDER_URL) || publicUrl).replace(/\/$/, '');
  return { serviceKey: key.length >= 16 ? key : null, publicUrl, internalUrl };
}
