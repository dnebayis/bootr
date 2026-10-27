#!/usr/bin/env node
/**
 * Prints an X OAuth authorize link for an agent (dev helper).
 *
 *   set -a; source .env; set +a; node apps/sender/scripts/oauth-link.mjs <agentId> [state]
 *
 * Needs SENDER_SERVICE_KEY and SENDER_URL (default http://localhost:3002). The link embeds a
 * signed state that expires after a few minutes; generate a fresh one right before use.
 */
/* global process, console, fetch */
import { createHash, createHmac } from 'node:crypto';

const [agentId, state = 'dev-connect'] = process.argv.slice(2);
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
const path = `/oauth/start?agentId=${encodeURIComponent(agentId)}&state=${encodeURIComponent(state)}`;
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
