import { pino } from 'pino';

/** Structured logger. Secrets must never be passed as fields; `redact` is a last line of defence. */
export const logger = pino({
  name: 'supervisor',
  level: process.env.SUPERVISOR_LOG_SILENT === '1' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  redact: { paths: ['*.privateKey', '*.token', '*.authorization', '*.secret', '*.key'], censor: '[redacted]' },
});

export type Logger = typeof logger;
