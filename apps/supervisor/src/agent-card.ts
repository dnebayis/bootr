/**
 * Reads the creator's Identity text from a launch's hosted agent card (`agentURI` of the `AgentLaunched`
 * event). The web app publishes it there as `bootr.identity` (apps/web/lib/agent-card.ts), filled from the
 * launch form via `POST /api/launch/draft`. See docs/agent-identity.md.
 *
 * `agentURI` is creator-controlled on-chain, so the fetch follows the same rules as the agent's `read_url`
 * tool: public https only, every host resolved and checked against private ranges, redirects followed by
 * hand with the same check, body capped. The text itself is bounded and reduced to plain text by
 * `normalizeCreatorIdentity`; it only ever fills the identity slot of the system prompt, below OWNER RULES.
 */
import { PolicyError, normalizeCreatorIdentity } from '@bootr/agent-core';
import { assertPublicHost } from './web-reader.js';

const MAX_CARD_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

export interface AgentCardOptions {
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<{ address: string }[]>;
  timeoutMs?: number;
}

/** `bootr.identity` of a parsed agent card, normalized; '' when absent or not a string. */
export function creatorIdentityFromCard(card: unknown): string {
  if (!card || typeof card !== 'object') return '';
  const bootr = (card as { bootr?: unknown }).bootr;
  if (!bootr || typeof bootr !== 'object') return '';
  return normalizeCreatorIdentity((bootr as { identity?: unknown }).identity);
}

/**
 * The creator identity behind `agentURI`:
 *   - a string: final. The text, or '' when the card has none, is unreadable (not public https, private
 *     host, not JSON, 4xx), or there is no URI at all. Nothing to retry.
 *   - null: the card could not be reached right now (network error, timeout, 5xx, 429, unresolvable host).
 *     Keep the default identity and try again on a later tick.
 */
export async function fetchCreatorIdentity(agentURI: string, opts: AgentCardOptions = {}): Promise<string | null> {
  if (!agentURI) return '';
  let current: URL;
  try {
    current = new URL(agentURI);
  } catch {
    return '';
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  let res: Response | null = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== 'https:' || current.username || current.password) return '';
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
    if (err instanceof PolicyError) return err.code === 'url_unresolvable_host' ? null : '';
    return null;
  }
  if (!res) return ''; // redirect chain too long
  if (res.status === 429 || res.status >= 500) return null;
  if (!res.ok) return '';
  let body: string;
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_CARD_BYTES) return '';
    body = buf.toString('utf8');
  } catch {
    return null;
  }
  try {
    return creatorIdentityFromCard(JSON.parse(body));
  } catch {
    return '';
  }
}
