#!/usr/bin/env node
/**
 * Prints a signed X connect link for an agent (dev/ops helper).
 *
 *   set -a; source .env; set +a; node apps/sender/scripts/oauth-link.mjs <agentId> [state] [--reconnect]
 *
 * Needs SENDER_SERVICE_KEY and SENDER_URL (default http://localhost:3002). The printed link points
 * at the sender's own `/oauth/start` (signed, valid for 5 minutes): open it in the browser that will
 * complete the flow, because the sender binds the OAuth state to that browser with a cookie.
 * `--reconnect` allows replacing an agent's existing, different X account.
 */
/* global process, console, fetch */
import { createHash, createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const reconnect = args.includes('--reconnect');
const [agentId, state = 'dev-connect'] = args.filter((a) => a !== '--reconnect');
if (!agentId) {
  console.error('usage: oauth-link.mjs <agentId> [state]');
  process.exit(1);
}
const key = process.env.SENDER_SERVICE_KEY;
if (!key) {
  console.error('SENDER_SERVICE_KEY is not set (source .env first)');
  process.exit(1);
}
const base = process.env.SENDER_URL ?? 'http://localhost:3002';
const path = `/oauth/start?agentId=${encodeURIComponent(agentId)}&state=${encodeURIComponent(state)}${reconnect ? '&reconnect=1' : ''}`;
const ts = String(Math.floor(Date.now() / 1000));
const sha = createHash('sha256').update('').digest('hex');
const sig = createHmac('sha256', key).update(`${ts}\nGET\n${path}\n${sha}`).digest('hex');
const res = await fetch(base + path, { headers: { authorization: `HMAC ${ts}:${sig}` } });
const body = await res.json();
if (!res.ok || !body.url) {
  console.error('sender refused:', res.status, JSON.stringify(body));
  process.exit(1);
}
console.log(body.url);
