import { describe, expect, it } from 'vitest';
// @ts-expect-error plain module next to the start script
import { AUTO_SCHEMA, NAMED_SCHEMA, VIEW_LINKS_SQL, isProtected, namedSchemasPlan, schemasToDrop } from '../../scripts/schema-janitor.mjs';

describe('schema janitor', () => {
  it('drops only automatic schemas older than the newest previous one, never fixed names or bootr_offchain', () => {
    const all = ['bootr_v1', 'bootr_v2', 'bootr_offchain', 'bootr_a1b2c3d', 'bootr_v3', 'bootr_e4f5a6b', 'bootr_0123abc', 'bootr_ffffff0'];
    expect(schemasToDrop(all, 'bootr_ffffff0')).toEqual(['bootr_a1b2c3d', 'bootr_e4f5a6b']);
    // the current one is never dropped, even when it is not the last created
    expect(schemasToDrop(all, 'bootr_a1b2c3d')).toEqual(['bootr_e4f5a6b', 'bootr_0123abc']);
    expect(schemasToDrop(['bootr_v3', 'bootr_offchain'], 'bootr_ffffff0')).toEqual([]);
    expect(AUTO_SCHEMA.test('bootr_v3')).toBe(false);
    expect(AUTO_SCHEMA.test('bootr_abc1234')).toBe(true);
  });

  it('keeps an automatic schema that a views schema reads from', () => {
    const all = ['bootr_a1b2c3d', 'bootr_e4f5a6b', 'bootr_0123abc', 'bootr_ffffff0'];
    const links = [{ viewSchema: 'bootr_live', targetSchema: 'bootr_a1b2c3d' }];
    expect(schemasToDrop(all, 'bootr_ffffff0', links)).toEqual(['bootr_e4f5a6b']);
  });
});

describe('schema janitor, named schemas (bootr_v<N>)', () => {
  // A fake catalog: `pg_namespace` in oid order, and the (views schema, target) pairs `VIEW_LINKS_SQL` returns.
  const catalog = ['public', 'drizzle', 'ponder_sync', 'ponder_rpc_cache_1', 'bootr_offchain', 'bootr_v3', 'bootr_v7', 'bootr_v8', 'bootr_a1b2c3d', 'bootr_v9', 'bootr_v10', 'bootr_live', 'bootr_v11'];
  const names = (plan: { keep: { name: string }[] }) => plan.keep.map((k) => k.name);

  it('keeps the current schema and the one immediately before it, and lists the rest', () => {
    const plan = namedSchemasPlan(catalog, 'bootr_v11');
    expect(plan.drop).toEqual(['bootr_v3', 'bootr_v7', 'bootr_v8', 'bootr_v9']);
    expect(names(plan)).toEqual(['bootr_v10', 'bootr_v11']);
  });

  it('orders by number, not by text or creation: v10 is after v9, and a gap in the numbers is no reason to keep more', () => {
    expect(namedSchemasPlan(['bootr_v10', 'bootr_v9', 'bootr_v2'], 'bootr_v10').drop).toEqual(['bootr_v2']);
    expect(namedSchemasPlan(['bootr_v3', 'bootr_v7', 'bootr_v11'], 'bootr_v11').drop).toEqual(['bootr_v3']);
    // a schema newer than the current one (a backfill in progress for the next deploy) is never listed
    expect(namedSchemasPlan(['bootr_v8', 'bootr_v9', 'bootr_v10', 'bootr_v11'], 'bootr_v10').drop).toEqual(['bootr_v8']);
  });

  it('never lists the schema a views schema points at, nor the views schema itself', () => {
    // bootr_live still serves the site from bootr_v9 while bootr_v11 backfills.
    const links = [
      { viewSchema: 'bootr_live', targetSchema: 'bootr_v9' },
      { viewSchema: 'bootr_live', targetSchema: 'bootr_v9' },
    ];
    const plan = namedSchemasPlan(catalog, 'bootr_v11', links);
    expect(plan.drop).toEqual(['bootr_v3', 'bootr_v7', 'bootr_v8']);
    expect(plan.keep).toContainEqual({ name: 'bootr_v9', why: 'read by views in bootr_live' });
    expect(plan.drop).not.toContain('bootr_live');
  });

  it('keeps a named schema that itself holds views into another one', () => {
    const links = [{ viewSchema: 'bootr_v7', targetSchema: 'bootr_v8' }];
    const plan = namedSchemasPlan(catalog, 'bootr_v11', links);
    expect(plan.drop).toEqual(['bootr_v3', 'bootr_v9']);
    expect(plan.keep).toContainEqual({ name: 'bootr_v7', why: 'holds views' });
    expect(plan.keep).toContainEqual({ name: 'bootr_v8', why: 'read by views in bootr_v7' });
  });

  it('never lists a schema of another kind: the sync store, the RPC cache, the offchain tables, public, drizzle, automatic ones', () => {
    const plan = namedSchemasPlan(catalog, 'bootr_v11');
    for (const name of ['public', 'drizzle', 'ponder_sync', 'ponder_rpc_cache_1', 'bootr_offchain', 'bootr_live', 'bootr_a1b2c3d']) {
      expect(plan.drop).not.toContain(name);
      expect(NAMED_SCHEMA.test(name)).toBe(false);
    }
    for (const name of ['public', 'drizzle', 'ponder_sync', 'ponder_rpc_cache_1', 'ponder_rpc_cache_7', 'bootr_offchain']) expect(isProtected(name)).toBe(true);
  });

  it('does nothing when the current schema is not a named one', () => {
    expect(namedSchemasPlan(catalog, 'bootr_a1b2c3d')).toEqual({ drop: [], keep: [] });
    expect(namedSchemasPlan(catalog, undefined)).toEqual({ drop: [], keep: [] });
    expect(namedSchemasPlan(catalog, 'bootr_live')).toEqual({ drop: [], keep: [] });
  });

  it('reads the views’ targets from the catalog across schemas only', () => {
    expect(VIEW_LINKS_SQL).toContain('pg_rewrite');
    expect(VIEW_LINKS_SQL).toContain('vn.nspname <> tn.nspname');
  });
});
