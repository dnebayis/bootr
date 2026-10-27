import { pino, stdSerializers } from 'pino';

/**
 * viem transport errors (`HttpRequestError`, `RpcRequestError`, ...) carry the RPC / bundler / paymaster URL
 * in `url`, `details`, `metaMessages` and the composed `message`. Those URLs embed API keys (CDP, ZeroDev,
 * Pimlico), so every URL in an error is reduced to its origin before it reaches the log stream (M-07).
 */
const URL_RE = /\b(https?:\/\/[^\s"'<>)\]]+)/g;

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' && !u.search && !u.hash ? u.origin : `${u.origin}/[redacted]`;
  } catch {
    return '[redacted-url]';
  }
}

export function redactUrls(text: string): string {
  return text.replace(URL_RE, (m) => redactUrl(m));
}

type Serialized = Record<string, unknown>;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (typeof value === 'string') return redactUrls(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Serialized = {};
    for (const [k, v] of Object.entries(value as Serialized)) {
      if (k === 'url') out[k] = typeof v === 'string' ? redactUrl(v) : '[redacted]';
      else if (k === 'body' || k === 'request' || k === 'headers') out[k] = '[redacted]';
      else out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** pino `err` serializer: the standard one, then URL scrubbing over every field including nested causes. */
export function serializeError(err: unknown): unknown {
  const base = err instanceof Error ? stdSerializers.err(err) : err;
  return scrub(base);
}

/** Structured logger. Secrets must never be passed as fields; `redact` and `serializeError` are a last line of defence. */
export const logger = pino({
  name: 'supervisor',
  level: process.env.SUPERVISOR_LOG_SILENT === '1' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  serializers: { err: serializeError, error: serializeError },
  redact: {
    paths: [
      '*.privateKey',
      '*.token',
      '*.authorization',
      '*.secret',
      '*.key',
      '*.apiKey',
      'err.url',
      'err.cause.url',
      'err.cause.cause.url',
      'err.body',
      'err.cause.body',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
