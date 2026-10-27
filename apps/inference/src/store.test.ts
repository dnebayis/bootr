import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from './db/schema.js';
import { PgRequestStore } from './store.js';

const pg = new PGlite();
const db = drizzle(pg, { schema });
const store = new PgRequestStore(db);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
});
afterAll(async () => {
  await pg.close();
});

const base = {
  requestId: 'req-1',
  requestHash: 'h1',
  status: 'in_flight' as const,
  model: 'openai/gpt-4.1-mini',
  quoteMicroUsdc: 1234,
  payment: {
    scheme: 'exact',
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0x1111111111111111111111111111111111111111',
    amount: '1234',
    settlementAttempted: false,
  },
};

describe('PgRequestStore (migrated schema on PGlite)', () => {
  it('claims a key exactly once', async () => {
    expect(await store.insertIfAbsent({ ...base, idempotencyKey: 'k1' })).toBe(true);
    expect(await store.insertIfAbsent({ ...base, idempotencyKey: 'k1', requestId: 'req-2' })).toBe(
      false,
    );
    const row = await store.get('k1');
    expect(row).toMatchObject({
      requestId: 'req-1',
      status: 'in_flight',
      quoteMicroUsdc: 1234,
      payment: base.payment,
    });
    expect(await store.get('missing')).toBeNull();
  });

  it('updates with compare-and-set on status', async () => {
    const response = { status: 200, headers: {}, body: { choices: [] } };
    expect(await store.update('k1', { status: 'succeeded', response }, 'unknown')).toBeNull();
    const updated = await store.update(
      'k1',
      { status: 'succeeded', response, chargedMicroUsdc: 1234 },
      'in_flight',
    );
    expect(updated).toMatchObject({ status: 'succeeded', response, chargedMicroUsdc: 1234 });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(updated!.createdAt.getTime());
  });
});
