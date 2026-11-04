/**
 * Reads a launch's hosted agent card (`agentURI` of the `AgentLaunched` event): the creator's Identity text,
 * published as `bootr.identity`, the coin picture (`image`, the agent's default image style reference) and, for a
 * custom worker, the preset published as `bootr.worker`
 * (apps/web/lib/agent-card.ts, filled from the launch form via `POST /api/launch/draft`). See
 * docs/agent-identity.md.
 *
 * `agentURI` is creator-controlled on-chain, so the fetch follows the same rules as the agent's `read_url`
 * tool: public https only, every host resolved and checked against private ranges, redirects followed by
 * hand with the same check, body capped. The text itself is bounded and reduced to plain text by
 * `normalizeCreatorIdentity`; it only ever fills the identity slot of the system prompt, below OWNER RULES.
 */
import { httpsUrlSchema, PolicyError, normalizeCreatorIdentity } from '@bootr/agent-core';
import { assertPublicHost } from './web-reader.js';

const MAX_CARD_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

export interface AgentCardOptions {
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<{ address: string }[]>;
  timeoutMs?: number;
}

/** The card's `image` (the coin picture the web serves on a public https URL), the agents' default style reference; null otherwise. */
export function coinImageFromCard(card: unknown): string | null {
  if (!card || typeof card !== 'object') return null;
  const image = (card as { image?: unknown }).image;
  const parsed = httpsUrlSchema.safeParse(image);
  return parsed.success ? parsed.data : null;
}

/** `bootr.identity` of a parsed agent card, normalized; '' when absent or not a string. */
export function creatorIdentityFromCard(card: unknown): string {
  if (!card || typeof card !== 'object') return '';
  const bootr = (card as { bootr?: unknown }).bootr;
  if (!bootr || typeof bootr !== 'object') return '';
  return normalizeCreatorIdentity((bootr as { identity?: unknown }).identity);
}

/**
 * Outcome of a card fetch:
 *   - `{ card }`: the parsed JSON document (any shape; readers pick their fields).
 *   - `'none'`: final. No URI, not public https, private host, 4xx, not JSON, too large. Nothing to retry.
 *   - `'retry'`: the card could not be reached right now (network error, timeout, 5xx, 429, unresolvable
 *     host). Keep the defaults and try again on a later tick.
 */
export type AgentCardFetch = { card: unknown } | 'none' | 'retry';

/**
 * The creator identity behind `agentURI`: the text, or '' when the card has none or is final-unreadable, or
 * null when the card could not be reached (see `fetchAgentCard`).
 */
export async function fetchCreatorIdentity(agentURI: string, opts: AgentCardOptions = {}): Promise<string | null> {
  const res = await fetchAgentCard(agentURI, opts);
  if (res === 'retry') return null;
  if (res === 'none') return '';
  return creatorIdentityFromCard(res.card);
}

/** Fetches and parses the whole agent card behind `agentURI` under the `read_url` host rules. Never throws. */
export async function fetchAgentCard(agentURI: string, opts: AgentCardOptions = {}): Promise<AgentCardFetch> {
  if (!agentURI) return 'none';
  let current: URL;
  try {
    current = new URL(agentURI);
  } catch {
    return 'none';
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  let res: Response | null = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== 'https:' || current.username || current.password) return 'none';
      await assertPublicHost(current.hostname, opts.resolve);
      res = await doFetch(current.toString(), {
        redirect: 'manual',
        headers: { 'user-agent': 'BootrSupervisor/1.0 (+https://bootr.fun)', accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current);
        res = null;
        continue;
      }
      break;
    }
  } catch (err) {
    // A host that resolves to a private address can never become readable; a DNS failure may be transient.
    if (err instanceof PolicyError) return err.code === 'url_unresolvable_host' ? 'retry' : 'none';
    return 'retry';
  }
  if (!res) return 'none'; // redirect chain too long
  if (res.status === 429 || res.status >= 500) return 'retry';
  if (!res.ok) return 'none';
  let body: string;
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_CARD_BYTES) return 'none';
    body = buf.toString('utf8');
  } catch {
    return 'retry';
  }
  try {
    return { card: JSON.parse(body) as unknown };
  } catch {
    return 'none';
  }
}
