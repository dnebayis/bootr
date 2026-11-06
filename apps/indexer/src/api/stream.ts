import { desc, gte } from 'ponder';
import { db } from 'ponder:api';
import schema from 'ponder:schema';

import { safeMessage } from '../../rpc-budget';

/**
 * `/stream` hint hub. One poller per process reads the newest launches, trades and agent status
 * changes every 2 s while at least one client is connected and fans out `{type, tokenId}` hints.
 * Cursors are block timestamps with a slack window plus a seen-set, because rows become visible
 * after their block timestamp.
 */
export type Hint = { type: 'launch' | 'trade' | 'agent'; tokenId: string };
type Listener = (h: Hint) => void;

const POLL_MS = 2_000;
const SLACK_SEC = 180;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
let primed = false;
let cursor = 0;
const seen = new Map<string, number>();

export function publish(h: Hint) {
  for (const l of listeners) l(h);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  if (!timer) timer = setInterval(() => void poll(), POLL_MS);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
      primed = false;
      seen.clear();
    }
  };
}

function mark(key: string, ts: number): boolean {
  if (seen.has(key)) return false;
  seen.set(key, ts);
  return true;
}

async function poll() {
  try {
    const since = cursor - SLACK_SEC;
    const [launches, trades, agents] = await Promise.all([
      db
        .select({ id: schema.token.id, ts: schema.token.launchedAt })
        .from(schema.token)
        .where(gte(schema.token.launchedAt, since))
        .orderBy(desc(schema.token.launchedAt))
        .limit(100),
      db
        .select({ id: schema.trade.id, token: schema.trade.token, ts: schema.trade.timestamp })
        .from(schema.trade)
        .where(gte(schema.trade.timestamp, since))
        .orderBy(desc(schema.trade.timestamp))
        .limit(500),
      db
        .select({ id: schema.agent.id, token: schema.agent.token, ts: schema.agent.statusChangedAt })
        .from(schema.agent)
        .where(gte(schema.agent.statusChangedAt, since))
        .orderBy(desc(schema.agent.statusChangedAt))
        .limit(200),
    ]);
    const out: Hint[] = [];
    for (const r of launches) if (mark(`l:${r.id}`, r.ts)) out.push({ type: 'launch', tokenId: r.id });
    const tradedTokens = new Set<string>();
    for (const r of trades) if (mark(`t:${r.id}`, r.ts)) tradedTokens.add(r.token);
    for (const t of tradedTokens) out.push({ type: 'trade', tokenId: t });
    for (const r of agents) if (mark(`a:${r.id}:${r.ts}`, r.ts)) out.push({ type: 'agent', tokenId: r.token });

    const maxTs = Math.max(cursor, ...launches.map((r) => r.ts), ...trades.map((r) => r.ts), ...agents.map((r) => r.ts));
    cursor = maxTs;
    for (const [k, ts] of seen) if (ts < cursor - 2 * SLACK_SEC) seen.delete(k);

    // The first poll only primes the cursor; clients fetch current state themselves.
    if (!primed) {
      primed = true;
      return;
    }
    for (const h of out) publish(h);
  } catch (err) {
    console.warn(`[indexer] /stream poll failed: ${safeMessage(err)}`);
  }
}
