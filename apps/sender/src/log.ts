/**
 * Minimal structured logger. Never pass tokens, Authorization headers or OAuth codes here;
 * `redact` is a last line of defence for known secret-bearing keys.
 */
const SECRET_KEYS = /token|secret|authorization|code_verifier|password|key/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : v;
  return out;
}

function emit(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.SENDER_LOG_SILENT === '1') return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...redact(fields) });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
