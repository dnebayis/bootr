/**
 * Seeds one own-agent coin into a LOCAL database for the end-to-end script (docs/design/byo-agent.md section 13.10,
 * `packages/mcp/test/own-agent-e2e.mjs`): an active agent whose stored config says `runner: 'own'`, its runtime row,
 * and a connected X account at the sender for the stub X (`packages/mcp/test/stub-x.mjs`), with the own read budget.
 * It prints one JSON line, `{ "agentId", "kernel", "token", "symbol" }`, and nothing else on stdout; the operator
 * passes that line to the end-to-end script as `E2E_SEED`.
 *
 *   DATABASE_URL=postgres://localhost:5432/bootr SENDER_ENCRYPTION_KEY=<the local sender's key> \
 *     pnpm --filter supervisor exec tsx scripts/seed-own-agent.ts
 *
 * It refuses a database whose host is not this machine, so it can never write a made-up coin into a real deployment.
 * Both services' migrations must have run (the supervisor's 0011 and the sender's 0003). Running it again starts the
 * coin over: the same rows are written again, and what an earlier run of the end-to-end script left for this agent id
 * is removed first (its actions, notes, clients, pictures, bounty jobs and approvals, the sender's posts and inbox, and
 * the sender's mention clock). Without that a second run finds no original post due (the last run's post is on record)
 * and its first mention read is held back by the sender's five-minute interval. The X tokens it stores are the fixed
 * words below: they open nothing but the stub.
 *
 * Environment: `DATABASE_URL` (required, local); `SENDER_ENCRYPTION_KEY` (required: the local sender's key, so the
 * sender can read the stub tokens); `SEED_CREATOR` (default: anvil's first account); `SEED_AGENT_ID`, `SEED_KERNEL`,
 * `SEED_TOKEN`, `SEED_SYMBOL`, `SEED_X_HANDLE`, `SEED_X_USER_ID`, `SEED_CHAIN_ID` (defaults below);
 * `SEED_PERMISSION_ID` (default none: a made-up kernel has no session key on the fork, so no treasury operation can be
 * signed for it; point `SEED_KERNEL` and this at a real fork agent when a part of the script needs one).
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { OWN_DEFAULTS } from '@bootr/shared/own-agent';
import { DEFAULT_MIND_MODEL } from '@bootr/agent-core';
import { sql } from 'drizzle-orm';
import { getAddress, isAddress } from 'viem';
import { createDb, type Db } from '../src/db/client.js';
import { agents, runtimes } from '../src/db/schema.js';
import { agentConfigOf } from '../src/onboarding.js';
import { initialState } from '../src/runtime.js';

/** anvil's first account: the creator of every part of the end-to-end script. */
export const ANVIL_FIRST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const SEED_DEFAULTS = {
  agentId: '990001',
  kernel: '0x00000000000000000000000000000000000b0071',
  token: '0x00000000000000000000000000000000000b0072',
  symbol: 'OWNSEED',
  name: 'Own Seed Coin',
  xHandle: 'own_seed_agent',
  xUserId: '990001',
  chainId: 8453,
} as const;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/**
 * Every table that keeps rows per agent and is not written below: the supervisor's and, on a local stack in the same
 * database, the sender's. A seed empties them for its agent id, so the coin starts over (the header says why).
 */
export const PER_AGENT_TABLES = [
  'sv_actions',
  'sv_agent_clients',
  'sv_agent_grants',
  'sv_approvals',
  'sv_bounty_entries',
  'sv_bounty_jobs',
  'sv_chat_messages',
  'sv_images',
  'sv_inference',
  'sv_memories',
  'sv_notifications',
  'sv_post_metrics',
  'sv_service_calls',
  'sv_treasury_ops',
  'sender_actions',
  'sender_inbox',
  'sender_reads',
  'sender_optouts',
] as const;

/** True when the database address points at this machine (a loopback host, or a unix socket given as `?host=/path`). */
export function isLocalDatabase(databaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return false;
  const socket = url.searchParams.get('host');
  if (!url.hostname) return !!socket && socket.startsWith('/');
  // `?host=` overrides the host in node-postgres: a remote one there is not local whatever the URL's own host says.
  if (socket && !socket.startsWith('/') && !LOCAL_HOSTS.has(socket.toLowerCase())) return false;
  return LOCAL_HOSTS.has(url.hostname.toLowerCase());
}

/** The sender's token encryption (apps/sender/src/crypto.ts): AES-256-GCM, `v1.<base64url(iv | tag | ciphertext)>`, bound to its row by the AAD. */
function encryptForSender(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
}

function addressOf(name: string, value: string): string {
  if (!isAddress(value)) throw new Error(`${name} must be an address`);
  return getAddress(value);
}

export interface Seed {
  agentId: string;
  kernel: string;
  token: string;
  symbol: string;
}

export async function seedOwnAgent(env: NodeJS.ProcessEnv = process.env): Promise<Seed> {
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!isLocalDatabase(databaseUrl)) throw new Error('refusing to seed: DATABASE_URL does not point at this machine (localhost, 127.0.0.1, ::1 or a unix socket)');
  // Every value is checked before a connection is opened.
  parseSeed(env);
  const { db, close } = createDb(databaseUrl);
  try {
    return await seedInto(db, env);
  } finally {
    await close();
  }
}

interface ParsedSeed extends Seed {
  key: Buffer;
  creator: string;
  xHandle: string;
  xUserId: string;
  chainId: 8453 | 84532;
  permissionId: string | null;
}

function parseSeed(env: NodeJS.ProcessEnv): ParsedSeed {
  const keyHex = env.SENDER_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('SENDER_ENCRYPTION_KEY (the local sender\'s 32-byte hex key) is required to store the stub X account');
  const key = Buffer.from(keyHex, 'hex');

  const agentId = env.SEED_AGENT_ID || SEED_DEFAULTS.agentId;
  if (!/^\d{1,20}$/.test(agentId)) throw new Error('SEED_AGENT_ID must be a number');
  const kernel = addressOf('SEED_KERNEL', env.SEED_KERNEL || SEED_DEFAULTS.kernel);
  const token = addressOf('SEED_TOKEN', env.SEED_TOKEN || SEED_DEFAULTS.token);
  const creator = addressOf('SEED_CREATOR', env.SEED_CREATOR || ANVIL_FIRST_ACCOUNT);
  const symbol = env.SEED_SYMBOL || SEED_DEFAULTS.symbol;
  if (!/^[A-Za-z0-9_]{1,16}$/.test(symbol)) throw new Error('SEED_SYMBOL must be 1 to 16 letters, digits or underscores');
  const xHandle = env.SEED_X_HANDLE || SEED_DEFAULTS.xHandle;
  const xUserId = env.SEED_X_USER_ID || SEED_DEFAULTS.xUserId;
  const chainId = Number(env.SEED_CHAIN_ID || SEED_DEFAULTS.chainId);
  if (chainId !== 8453 && chainId !== 84532) throw new Error('SEED_CHAIN_ID must be 8453 or 84532');
  const permissionId = env.SEED_PERMISSION_ID || null;
  return { agentId, kernel, token, symbol, key, creator, xHandle, xUserId, chainId, permissionId };
}

/** Writes the rows into an open database (the script's own connection, or a test's). The caller answers for where it points. */
export async function seedInto(db: Db, env: NodeJS.ProcessEnv): Promise<Seed> {
  const { agentId, kernel, token, symbol, key, creator, xHandle, xUserId, chainId, permissionId } = parseSeed(env);
  const now = new Date();
  const config: Record<string, unknown> = {
    agentId,
    token: { address: token, symbol, name: SEED_DEFAULTS.name, chainId },
    kernel: { address: kernel },
    creator: { address: creator },
    xHandle,
    xUserId,
    // Who runs it: the creator's own client. The hosted model stays in the config for a switch back.
    runner: 'own',
    model: DEFAULT_MIND_MODEL,
    identityText: `You are the agent of ${SEED_DEFAULTS.name} ($${symbol}), a coin that exists only on a local test stack.`,
    creatorIdentity: '',
    ownerRules: [],
    capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: true },
    postIntervalMs: 2 * 3_600_000,
    dormancyPeriodMs: 90 * 86_400_000,
    // Started long enough ago that the first original post is due at once.
    socialStartedAt: new Date(now.getTime() - 6 * 3_600_000).toISOString(),
    replyAuthorIds: [],
    blockedAuthorIds: [],
    revision: 1,
  };

  {
    // What an earlier run left for this agent id goes first, so the rows below describe a coin that has done nothing yet.
    for (const table of PER_AGENT_TABLES) await db.execute(sql`delete from ${sql.identifier(table)} where agent_id = ${agentId}`);
    const row = { agentId, token, kernel, creator, source: 'bootr' as const, config, permissionId, sessionKeyInstalledAt: permissionId ? now : null, status: 'active' as const, draftId: '', createdAt: now, updatedAt: now };
    const [agent] = await db
      .insert(agents)
      .values(row)
      .onConflictDoUpdate({ target: agents.agentId, set: { ...row, agentId: undefined } })
      .returning();
    if (!agent || !agentConfigOf(agent)) throw new Error('the seeded config does not parse as an agent config');
    const runtime = { agentId, state: initialState() as unknown as Record<string, unknown>, cycle: 0, pending: null, turn: null, leaseToken: null, leaseUntil: null, nextAt: now, status: 'waiting' as const, pausedBy: null, configRevision: 1, lastDecisionAt: now, lastDecisionRevision: 1, failures: 0, lastError: null, updatedAt: now };
    await db
      .insert(runtimes)
      .values(runtime)
      .onConflictDoUpdate({ target: runtimes.agentId, set: { ...runtime, agentId: undefined } });

    // The sender's tables live in the same local database (apps/sender/src/db/schema.ts). The account is "connected" to
    // the stub X: tokens that never run out during a test, the badge already read so the sender asks X nothing for it.
    const access = encryptForSender('stub-x-access-token', key, `access:${agentId}`);
    const refresh = encryptForSender('stub-x-refresh-token', key, `refresh:${agentId}`);
    const expiresAt = new Date(now.getTime() + 3650 * 86_400_000);
    await db.execute(sql`
      insert into sender_accounts (agent_id, x_user_id, x_handle, encrypted_access_token, encrypted_refresh_token, scopes, expires_at, revoked_at, connected_at, updated_at, verified_type, verified_checked_at)
      values (${agentId}, ${xUserId}, ${xHandle}, ${access}, ${refresh}, ${'tweet.read tweet.write users.read offline.access media.write'}, ${expiresAt}, null, ${now}, ${now}, ${'blue'}, ${now})
      on conflict (agent_id) do update set x_user_id = excluded.x_user_id, x_handle = excluded.x_handle, encrypted_access_token = excluded.encrypted_access_token, encrypted_refresh_token = excluded.encrypted_refresh_token, scopes = excluded.scopes, expires_at = excluded.expires_at, revoked_at = null, connected_at = excluded.connected_at, updated_at = excluded.updated_at, verified_type = excluded.verified_type, verified_checked_at = excluded.verified_checked_at
    `);
    // The X read budget an own coin starts on (own/quota.ts), as registration would have set it, and no mention read
    // yet: an earlier run's read would hold the next one back for the sender's interval, and its cursor would hide
    // what the stub is asked for after a reset.
    await db.execute(sql`
      insert into sender_quotas (agent_id, reads_per_day, updated_at) values (${agentId}, ${OWN_DEFAULTS.OWN_READS_PER_DAY}, ${now})
      on conflict (agent_id) do update set reads_per_day = excluded.reads_per_day, last_mentions_read_at = null, mentions_since_id = null, updated_at = excluded.updated_at
    `);
  }
  return { agentId, kernel, token, symbol };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  seedOwnAgent().then(
    (seed) => {
      console.log(JSON.stringify(seed));
    },
    (err: unknown) => {
      console.error('seed-own-agent failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
