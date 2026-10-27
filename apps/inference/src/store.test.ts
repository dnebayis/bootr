import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from './db/schema.js';
import { MemoryRequestStore, PgRequestStore, type RequestStore } from './store.js';

const pg = new PGlite();
const db = drizzle(pg, { schema });
const pgStore = new PgRequestStore(db);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
});
afterAll(async () => {
  await pg.close();
});

const PAYER = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';

const base = {
  payer: PAYER,
  requestId: 'req-1',
  requestHash: 'h1',
  status: 'in_flight' as const,
  model: 'openai/gpt-4.1-mini',
  quoteMicroUsdc: 1234,
  paymentNonce: '0x01',
  proofHash: 'p1',
  payment: {
    scheme: 'exact',
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0x1111111111111111111111111111111111111111',
    amount: '1234',
    settlementAttempted: false,
  },
};

describe.each([
  ['PgRequestStore (migrated schema on PGlite)', () => pgStore],
  ['MemoryRequestStore', () => new MemoryRequestStore()],
] as const)('%s', (_name, make) => {
  const store: RequestStore = make();

  it('claims a (payer, key) exactly once; keys are namespaced per payer', async () => {
    expect(await store.insertIfAbsent({ ...base, idempotencyKey: 'k1' })).toBe('inserted');
    expect(
      await store.insertIfAbsent({
        ...base,
        idempotencyKey: 'k1',
        requestId: 'req-2',
        paymentNonce: '0x02',
      }),
    ).toBe('key_exists');
    // Another payer may use the same key (no squatting across payers).
    expect(
      await store.insertIfAbsent({
        ...base,
        payer: OTHER,
        idempotencyKey: 'k1',
        requestId: 'req-3',
      }),
    ).toBe('inserted');
    const row = await store.get(PAYER, 'k1');
    expect(row).toMatchObject({
      requestId: 'req-1',
      status: 'in_flight',
      quoteMicroUsdc: 1234,
      payment: base.payment,
    });
    expect(await store.get(OTHER, 'k1')).toMatchObject({ requestId: 'req-3' });
    expect(await store.get(PAYER, 'missing')).toBeNull();
    expect(await store.get('0x00000000000000000000000000000000000000c3', 'k1')).toBeNull();
  });

  it('one authorization (payer, nonce) opens at most one row', async () => {
    expect(
      await store.insertIfAbsent({ ...base, idempotencyKey: 'k-other', requestId: 'req-4' }),
    ).toBe('nonce_reused');
    expect(await store.get(PAYER, 'k-other')).toBeNull();
  });

  it('updates with compare-and-set on status', async () => {
    const response = { status: 200, headers: {}, body: { choices: [] } };
    expect(
      await store.update(PAYER, 'k1', { status: 'succeeded', response }, 'unknown'),
    ).toBeNull();
    const updated = await store.update(
      PAYER,
      'k1',
      { status: 'succeeded', response, chargedMicroUsdc: 1234, upstreamAttempts: 1 },
      'in_flight',
    );
    expect(updated).toMatchObject({
      status: 'succeeded',
      response,
      chargedMicroUsdc: 1234,
      upstreamAttempts: 1,
    });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(updated!.createdAt.getTime());
    expect(await store.get(OTHER, 'k1')).toMatchObject({ status: 'in_flight' });
  });
});

describe('migration 0001 on existing rows', () => {
  it('backfills payer, nonce and proof hash and de-duplicates shared authorizations', async () => {
    const legacy = new PGlite();
    const folder = fileURLToPath(new URL('../drizzle', import.meta.url));
    const { readFileSync } = await import('node:fs');
    await legacy.exec(
      readFileSync(`${folder}/0000_inference_requests.sql`, 'utf8').replaceAll(
        '--> statement-breakpoint',
        '',
      ),
    );
    const pay = (nonce: string) =>
      JSON.stringify({
        payer: '0xAbC0000000000000000000000000000000000001',
        authorization: { from: '0xAbC0000000000000000000000000000000000001', nonce },
      });
    await legacy.exec(`
      insert into inference_requests (idempotency_key, request_id, request_hash, status, model, quote_micro_usdc, payer, payment, created_at)
      values ('a', 'r-a', 'h', 'succeeded', 'm', 1, null, '${pay('0xAA')}', now() - interval '2 minutes'),
             ('b', 'r-b', 'h', 'failed', 'm', 1, null, '${pay('0xAA')}', now() - interval '1 minute'),
             ('c', 'r-c', 'h', 'failed', 'm', 1, null, null, now());
    `);
    await legacy.exec(
      readFileSync(`${folder}/0001_payer_scoped_keys.sql`, 'utf8').replaceAll(
        '--> statement-breakpoint',
        '',
      ),
    );
    const rows = (
      await legacy.query<{
        idempotency_key: string;
        payer: string;
        payment_nonce: string;
        proof_hash: string;
      }>(
        'select idempotency_key, payer, payment_nonce, proof_hash from inference_requests order by idempotency_key',
      )
    ).rows;
    expect(rows).toEqual([
      {
        idempotency_key: 'a',
        payer: '0xabc0000000000000000000000000000000000001',
        payment_nonce: '0xaa',
        proof_hash: 'legacy',
      },
      {
        idempotency_key: 'b',
        payer: '0xabc0000000000000000000000000000000000001',
        payment_nonce: 'legacy-dup:r-b',
        proof_hash: 'legacy',
      },
      {
        idempotency_key: 'c',
        payer: 'legacy:r-c',
        payment_nonce: 'legacy:r-c',
        proof_hash: 'legacy',
      },
    ]);
    await legacy.close();
  });
});
