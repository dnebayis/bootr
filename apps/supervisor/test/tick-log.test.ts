import { describe, expect, it } from 'vitest';
import { createTickLog } from '../src/tick-log.js';
import type { TickReport } from '../src/tick.js';

const MIN = 60_000;
const quiet = (processed: string[] = ['1', '2']): TickReport => ({ registered: 0, processed, ran: [], errors: [] });

describe('what the service logs about its ticks', () => {
  it('writes a tick that ran, registered or failed, and sums the quiet ones into one line every ten minutes', () => {
    const log = createTickLog(10 * MIN, 0);
    const lines: { at: number; msg: string; fields: Record<string, unknown> }[] = [];
    const note = (minute: number, report: TickReport, ms = 40) => {
      for (const l of log.note(report, ms, minute * MIN)) lines.push({ at: minute, ...l });
    };
    // nine quiet minutes: nothing
    for (let m = 1; m <= 9; m++) note(m, quiet(), m === 4 ? 900 : 40);
    expect(lines).toEqual([]);
    // the tenth: one summary of the ten
    note(10, quiet());
    expect(lines).toEqual([{ at: 10, msg: 'ticks', fields: { quietTicks: 10, sinceMs: 10 * MIN, avgMs: 126, maxMs: 900, processed: 2 } }]);
    // a tick that ran a turn is written at once, whole, and does not count as quiet
    const ran: TickReport = { registered: 0, processed: ['1', '2'], ran: ['1'], errors: [] };
    note(11, ran, 5200);
    expect(lines[1]).toEqual({ at: 11, msg: 'tick', fields: { ...ran, ms: 5200 } });
    // so are one that registered an agent and one with an error
    note(12, { registered: 1, processed: [], ran: [], errors: [] });
    note(13, { registered: 0, processed: ['1'], ran: [], errors: [{ agentId: '1', error: 'boom' }] });
    expect(lines.slice(2).map((l) => l.msg)).toEqual(['tick', 'tick']);
    // the next summary counts only the quiet ticks of its window
    for (let m = 14; m <= 20; m++) note(m, quiet(['1']));
    expect(lines.at(-1)).toEqual({ at: 20, msg: 'ticks', fields: { quietTicks: 7, sinceMs: 10 * MIN, avgMs: 40, maxMs: 40, processed: 1 } });
    // a day of quiet ticks: 144 lines instead of 1,440
    const day = createTickLog(10 * MIN, 0);
    let written = 0;
    for (let m = 1; m <= 1440; m++) written += day.note(quiet(), 40, m * MIN).length;
    expect(written).toBe(144);
  });

  it('with the interval at 0 writes a line for every tick', () => {
    const log = createTickLog(0, 0);
    expect(log.note(quiet(), 40, MIN).map((l) => l.msg)).toEqual(['ticks']);
    expect(log.note({ registered: 0, processed: ['1'], ran: ['1'], errors: [] }, 40, 2 * MIN).map((l) => l.msg)).toEqual(['tick']);
  });
});
