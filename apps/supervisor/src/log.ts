import { pino, stdSerializers, type DestinationStream, type LoggerOptions } from 'pino';

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

/**
 * An error's message for a field that is stored or reported (`report.errors`, a runtime's `last_error`, an action's
 * `error`): every URL reduced to its origin, since RPC, bundler and paymaster URLs carry keys, and cut to `max`.
 */
export function rpcErrorText(err: unknown, max = 500): string {
  const text = err instanceof Error ? err.message : String(err);
  return redactUrls(text).slice(0, max);
}

type Serialized = Record<string, unknown>;

/** Every string in `value` with its URLs reduced to origins; `url`, `body`, `request` and `headers` fields dropped; Errors serialized first. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (typeof value === 'string') return redactUrls(value);
  if (value instanceof Error) return scrub(stdSerializers.err(value), depth);
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

/**
 * The structured logger. Secrets must never be passed as fields; what follows is the last line of defence: every
 * field of every line goes through `scrub` (so a URL with a key in a `reason`, an `error` string or a tick report
 * is reduced to its origin, not only one under `err`), `err` and `error` Errors are serialized with their causes
 * scrubbed, and the named secret paths are censored.
 */
export function createLogger(opts: { level?: string; destination?: DestinationStream } = {}) {
  const options: LoggerOptions = {
    name: 'supervisor',
    level: opts.level ?? (process.env.SUPERVISOR_LOG_SILENT === '1' ? 'silent' : (process.env.LOG_LEVEL ?? 'info')),
    serializers: { err: serializeError, error: serializeError },
    formatters: {
      // Runs before the serializers: an Error is left for them, everything else is scrubbed here.
      log: (obj: Record<string, unknown>) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v instanceof Error ? v : scrub(v)])),
    },
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
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

export const logger = createLogger();

export type Logger = typeof logger;
