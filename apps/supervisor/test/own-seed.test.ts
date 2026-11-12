/**
 * The seed script of the own-agent end-to-end run (scripts/seed-own-agent.ts) writes a made-up coin and stub X tokens
 * into a database. It must never do that anywhere but on the machine it runs on.
 */
import { createDecipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { getAddress } from 'viem';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { DueView, TurnOpen } from '@bootr/shared/own-agent';
import { ANVIL_FIRST_ACCOUNT, PER_AGENT_TABLES, SEED_DEFAULTS, isLocalDatabase, seedInto, seedOwnAgent } from '../scripts/seed-own-agent.js';
import { connectClient, ownWorld } from './own-helpers.js';

const KEY = '11'.repeat(32);

describe('seed-own-agent', () => {
  it('takes a database on this machine and no other', () => {
    for (const url of ['postgres://localhost:5432/bootr', 'postgresql://user:pw@127.0.0.1/bootr', 'postgres://[::1]:5432/bootr', 'postgres://LOCALHOST/bootr', 'postgres:///bootr?host=/var/run/postgresql']) {
      expect([url, isLocalDatabase(url)]).toEqual([url, true]);
    }
    for (const url of [
      'postgres://db.bootr.fun:5432/bootr',
      'postgres://77.42.90.52/bootr',
      'postgres://localhost.evil.example/bootr',
      'postgres://user:localhost@db.internal/bootr',
      'postgres://localhost/bootr?host=db.internal',
      'postgres:///bootr',
      'mysql://localhost/bootr',
      'localhost',
      '',
    ]) {
      expect([url, isLocalDatabase(url)]).toEqual([url, false]);
    }
  });

  it('refuses a remote database, a missing sender key and a malformed seed before it connects to anything', async () => {
    await expect(seedOwnAgent({})).rejects.toThrow('DATABASE_URL is required');
    await expect(seedOwnAgent({ DATABASE_URL: 'postgres://db.bootr.fun/bootr', SENDER_ENCRYPTION_KEY: KEY })).rejects.toThrow(/refusing to seed/);
    await expect(seedOwnAgent({ DATABASE_URL: 'postgres://localhost/bootr' })).rejects.toThrow(/SENDER_ENCRYPTION_KEY/);
    await expect(seedOwnAgent({ DATABASE_URL: 'postgres://localhost/bootr', SENDER_ENCRYPTION_KEY: KEY, SEED_CREATOR: 'nobody' })).rejects.toThrow('SEED_CREATOR must be an address');
    await expect(seedOwnAgent({ DATABASE_URL: 'postgres://localhost/bootr', SENDER_ENCRYPTION_KEY: KEY, SEED_AGENT_ID: '7; drop table sv_agents' })).rejects.toThrow('SEED_AGENT_ID must be a number');
    // The default creator is anvil's first account, the one the end-to-end script signs with.
    expect(ANVIL_FIRST_ACCOUNT).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('writes an own coin a client can connect to and run, and an X account row the sender can read', async () => {
    const w = await ownWorld();
    try {
      // The sender's tables share the database on a local stack: its migrations are applied beside the supervisor's.
      await migrate(w.db as never, { migrationsFolder: fileURLToPath(new URL('../../sender/drizzle', import.meta.url)), migrationsTable: 'sender_migrations', migrationsSchema: 'public' });
      const env = { SENDER_ENCRYPTION_KEY: KEY, SEED_CHAIN_ID: '84532' };
      const rows = async <T>(query: SQL) => ((await w.db.execute(query)) as unknown as { rows: T[] }).rows;
      const seed = await seedInto(w.db, env);
      expect(seed).toEqual({ agentId: SEED_DEFAULTS.agentId, kernel: getAddress(SEED_DEFAULTS.kernel), token: getAddress(SEED_DEFAULTS.token), symbol: 'OWNSEED' });
      // Running it again replaces the same rows.
      expect(await seedInto(w.db, env)).toEqual(seed);

      const account = await rows<{ agent_id: string; x_handle: string; encrypted_access_token: string; revoked_at: unknown; verified_type: string }>(sql`select * from sender_accounts`);
      expect(account).toHaveLength(1);
      expect(account[0]).toMatchObject({ agent_id: seed.agentId, x_handle: 'own_seed_agent', revoked_at: null, verified_type: 'blue' });
      // The token is stored the way the sender stores one: its own decryption, with the row's AAD, reads it back.
      const raw = Buffer.from(account[0]!.encrypted_access_token.split('.')[1]!, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(`access:${seed.agentId}`, 'utf8'));
      decipher.setAuthTag(raw.subarray(12, 28));
      expect(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')).toBe('stub-x-access-token');
      expect(await rows(sql`select reads_per_day from sender_quotas where agent_id = ${seed.agentId}`)).toEqual([{ reads_per_day: 200 }]);

      // The seed is written at the real time of day; the world's clock is moved there.
      w.setNow(Date.now() + 1000);
      // The seeded coin is an own coin anvil's first account can connect a client to, with its first post due.
      const client = await connectClient(w, { creator: ANVIL_FIRST_ACCOUNT, agentId: seed.agentId, kernel: seed.kernel });
      const due = await w.run<DueView>('due', client.credential);
      expect(due.body.coin).toMatchObject({ agentId: seed.agentId, symbol: 'OWNSEED', token: seed.token });
      expect(due.body.social.reasons).toContain('original_post_due');
      const turn = await w.run<TurnOpen>('turn', client.credential, { role: 'social' });
      expect(turn.status).toBe(200);
      expect(turn.body.tools).toEqual(expect.arrayContaining(['bootr_agent_publish_post', 'bootr_agent_upload_picture', 'bootr_agent_finish']));

      // Seeding again starts the coin over (found by the first real run of the end-to-end script: a second run saw no
      // original post due, and its mention read was held back by the sender's five-minute interval). What a run
      // leaves is gone: the client, the open turn, actions and notes, another table of each service, the mention clock.
      await w.db.execute(sql`insert into sv_actions (action_id, agent_id, cycle_key, action, status) values ('act_left_by_a_run', ${seed.agentId}, 'cycle:left', '{"tool":"publish_post"}'::jsonb, 'completed')`);
      await w.db.execute(sql`insert into sv_memories (id, agent_id, text, sources, tags, created_at) values ('mem_left_by_a_run', ${seed.agentId}, 'left by an earlier run', '[]'::jsonb, '[]'::jsonb, now())`);
      await w.db.execute(sql`insert into sender_reads (agent_id, kind, day, count) values (${seed.agentId}, 'mentions', '2026-11-12', 3)`);
      await w.db.execute(sql`update sender_quotas set last_mentions_read_at = now(), mentions_since_id = '42' where agent_id = ${seed.agentId}`);
      // Another coin's rows are not the seed's to touch.
      await w.db.execute(sql`insert into sv_memories (id, agent_id, text, sources, tags, created_at) values ('mem_of_another_coin', '7', 'kept', '[]'::jsonb, '[]'::jsonb, now())`);
      const count = async (table: string) => (await rows<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where agent_id = ${seed.agentId}`))[0]!.n;
      for (const table of ['sv_agent_clients', 'sv_actions', 'sv_memories', 'sender_reads']) expect([table, await count(table)]).not.toEqual([table, 0]);
      expect(await seedInto(w.db, env)).toEqual(seed);
      for (const table of PER_AGENT_TABLES) expect([table, await count(table)]).toEqual([table, 0]);
      expect(await rows(sql`select id from sv_memories`)).toEqual([{ id: 'mem_of_another_coin' }]);
      expect(await rows(sql`select reads_per_day, last_mentions_read_at, mentions_since_id from sender_quotas where agent_id = ${seed.agentId}`)).toEqual([{ reads_per_day: 200, last_mentions_read_at: null, mentions_since_id: null }]);
      expect(await rows(sql`select turn, cycle from sv_runtimes where agent_id = ${seed.agentId}`)).toEqual([{ turn: null, cycle: 0 }]);
      // And it is again a coin a client can connect to, with its first post due.
      w.setNow(Date.now() + 1000);
      const again = await connectClient(w, { creator: ANVIL_FIRST_ACCOUNT, agentId: seed.agentId, kernel: seed.kernel });
      expect((await w.run<DueView>('due', again.credential)).body.social.reasons).toContain('original_post_due');
    } finally {
      await w.close();
    }
  });
});
