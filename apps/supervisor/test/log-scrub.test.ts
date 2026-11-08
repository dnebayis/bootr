import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { runtimes } from '../src/db/schema.js';
import { createLogger, redactUrls, rpcErrorText, scrub } from '../src/log.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent } from './helpers.js';

/**
 * A viem error names the RPC URL in its message, key and all. The tick put that message into report.errors (logged
 * whole) and into the runtime's last_error (stored, shown in the console), and the log scrubber covered only the
 * fields under `err`. Now every stored or reported error text goes through rpcErrorText, and every field of every
 * log line through the scrubber.
 */

const KEYED = 'https://api.developer.coinbase.com/rpc/v1/base/sEcReT-kEy-123';
const viemLike = () => Object.assign(new Error(`HTTP request failed.\n\nURL: ${KEYED}\nRequest body: {"method":"eth_call"}\n\nDetails: fetch failed`), { name: 'HttpRequestError', url: KEYED });

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'info', destination: { write: (s: string) => void lines.push(s) } });
  return { logger, lines, text: () => lines.join('') };
}

describe('error text in stored and reported fields', () => {
  it('reduces every URL to its origin and cuts the text', () => {
    expect(rpcErrorText(viemLike())).toContain('https://api.developer.coinbase.com/[redacted]');
    expect(rpcErrorText(viemLike())).not.toContain('sEcReT');
    expect(rpcErrorText('plain text')).toBe('plain text');
    expect(rpcErrorText('x'.repeat(600))).toHaveLength(500);
    expect(redactUrls(`see ${KEYED}?a=1 and https://bootr.fun/`)).toBe('see https://api.developer.coinbase.com/[redacted] and https://bootr.fun');
    expect(scrub({ reason: KEYED, nested: [{ url: KEYED, body: 'x', deeper: { note: `at ${KEYED}` } }] })).toEqual({
      reason: 'https://api.developer.coinbase.com/[redacted]',
      nested: [{ url: 'https://api.developer.coinbase.com/[redacted]', body: '[redacted]', deeper: { note: 'at https://api.developer.coinbase.com/[redacted]' } }],
    });
  });

  it('the logger scrubs every field of a line, not only err', () => {
    const { logger, text } = captureLogger();
    logger.info({ reason: `rpc said no at ${KEYED}`, errors: [{ agentId: '7', error: viemLike().message }], err: viemLike() }, 'tick');
    logger.warn({ error: viemLike(), tool: 'read_chain' }, 'tool failed');
    logger.child({ agentId: '7' }).error({ nested: { err: viemLike() } }, 'nested');
    expect(text()).not.toContain('sEcReT');
    expect(text()).toContain('https://api.developer.coinbase.com/[redacted]');
    expect(text()).toContain('HttpRequestError');
    expect(text()).toContain('"tool":"read_chain"');
  });
});

describe('the tick', () => {
  it('reports and stores a failing agent without the RPC key', async () => {
    const w = await makeWorld({ script: [finishResponse(Date.parse('2026-10-24T13:00:00Z'))] });
    try {
      await seedAgent(w);
      // The market read sits outside the turn's own catch, so it fails the agent at tick level: report.errors.
      w.ctx.indexer.market = async () => {
        throw viemLike();
      };
      const report = await tick(w.ctx);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]!.error).toContain('https://api.developer.coinbase.com/[redacted]');
      expect(report.errors[0]!.error).not.toContain('sEcReT');
    } finally {
      await w.close();
    }
  });

  it('stores a crashed turn as last_error without the RPC key', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      // The inference call throws a transport error that names the relay URL with a key.
      w.ctx.fetch = (() => {
        throw viemLike();
      }) as typeof fetch;
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      const row = await w.ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) });
      expect(row?.lastError).toBeTruthy();
      expect(row?.lastError).not.toContain('sEcReT');
      expect(row?.lastError).toContain('https://api.developer.coinbase.com/[redacted]');
    } finally {
      await w.close();
    }
  });
});
