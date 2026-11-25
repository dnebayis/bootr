/**
 * What the service writes about its ticks (index.ts). A tick runs every minute and most do nothing: until 2026-11-25
 * each still wrote a `tick` line with every processed agent id, and a second timer wrote an `rpc usage` line, 2,880
 * info lines a day that said the same thing. A tick is now logged when it ran a turn, registered an agent or had an
 * error; the quiet ones in between are summed into one line every `LOG_SUMMARY_INTERVAL_MS` (ten minutes), so the log
 * still shows the loop is alive and how long its ticks take. `rpc usage` is written on the same interval, summed.
 */
import type { TickReport } from './tick.js';

export interface TickLine {
  /** The fields of the log line. */
  fields: Record<string, unknown>;
  msg: 'tick' | 'ticks';
}

export interface TickLog {
  /** Takes one finished tick; returns the lines to write now (none for a quiet tick inside the interval). */
  note(report: TickReport, ms: number, now: number): TickLine[];
}

export function createTickLog(intervalMs: number, startedAt: number): TickLog {
  let since = startedAt;
  let quiet = 0;
  let quietMs = 0;
  let quietMaxMs = 0;
  let lastProcessed = 0;
  const summary = (now: number): TickLine | null => {
    if (!quiet) return null;
    const line: TickLine = { msg: 'ticks', fields: { quietTicks: quiet, sinceMs: now - since, avgMs: Math.round(quietMs / quiet), maxMs: quietMaxMs, processed: lastProcessed } };
    quiet = 0;
    quietMs = 0;
    quietMaxMs = 0;
    return line;
  };
  return {
    note(report, ms, now) {
      const eventful = report.ran.length > 0 || report.errors.length > 0 || report.registered > 0;
      const out: TickLine[] = [];
      if (!eventful) {
        quiet += 1;
        quietMs += ms;
        quietMaxMs = Math.max(quietMaxMs, ms);
        lastProcessed = report.processed.length;
      }
      // The interval is over (or is 0: every tick is written, as before): the quiet ticks since the last summary, in one line.
      if (now - since >= intervalMs) {
        const line = summary(now);
        if (line) out.push(line);
        since = now;
      }
      if (eventful) out.push({ msg: 'tick', fields: { ...report, ms } });
      return out;
    },
  };
}
