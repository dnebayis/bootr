import { describe, expect, it } from 'vitest';
// @ts-expect-error plain module next to the start script
import { checkpointSeconds, decide, switchStatements, targetOfDefinition, validName, writerAlive } from '../../scripts/live-switch.mjs';

const NOW = 1_795_590_000;
const base = { schema: 'bootr_v11', heldBefore: false, nowSec: NOW, slackSec: 2, maxLagSec: 20 };

describe('live switch', () => {
  it('reads the schema a view selects from out of its definition', () => {
    expect(targetOfDefinition(' SELECT key,\n    value\n   FROM bootr_v10._ponder_meta;')).toBe('bootr_v10');
    expect(targetOfDefinition('SELECT key, value FROM "bootr_3fa9c1e"."_ponder_meta"')).toBe('bootr_3fa9c1e');
    expect(targetOfDefinition('')).toBeNull();
    expect(targetOfDefinition(undefined)).toBeNull();
  });

  it('takes the block time from a checkpoint', () => {
    expect(checkpointSeconds('1795589869000000000008453200000000633400019999999999999999599999999999999999')).toBe(1_795_589_869);
    expect(checkpointSeconds(null)).toBeNull();
    expect(checkpointSeconds('abc')).toBeNull();
  });

  it('waits for the backfill, then for the head being served, and never steps back while that writer lives', () => {
    const target = { name: 'bootr_v10', headSec: NOW - 3, alive: true };
    expect(decide({ ...base, mine: { ready: false, headSec: NOW - 9000 }, target }).action).toBe('wait');
    // ready at the finalized block: minutes behind the served head, and 15 s behind the clock would not be enough either
    expect(decide({ ...base, mine: { ready: true, headSec: NOW - 220 }, target }).action).toBe('wait');
    expect(decide({ ...base, mine: { ready: true, headSec: NOW - 15 }, target }).action).toBe('wait');
    expect(decide({ ...base, mine: { ready: true, headSec: NOW - 5 }, target }).action).toBe('switch');
    expect(decide({ ...base, mine: { ready: true, headSec: NOW - 3 }, target }).action).toBe('switch');
  });

  it('measures against the clock when the served schema has no writer, and switches at once when there are no views', () => {
    const dead = { name: 'bootr_v10', headSec: NOW - 4000, alive: false };
    expect(decide({ ...base, mine: { ready: true, headSec: NOW - 3000 }, target: dead }).action).toBe('switch');
    const deadAhead = { name: 'bootr_v10', headSec: NOW - 100, alive: false };
    expect(decide({ ...base, mine: { ready: true, headSec: NOW - 300 }, target: deadAhead }).action).toBe('wait');
    expect(decide({ ...base, mine: { ready: true, headSec: NOW - 300 }, target: { name: null, headSec: null, alive: false } }).action).toBe('switch');
    expect(decide({ ...base, mine: { ready: false, headSec: null }, target: { name: null, headSec: null, alive: false } }).action).toBe('wait');
  });

  it('leaves the views alone when they are its own, and when a newer schema took them from it', () => {
    const mine = { ready: true, headSec: NOW - 1 };
    expect(decide({ ...base, mine, target: { name: 'bootr_v11', headSec: NOW - 1, alive: true } }).action).toBe('done');
    // an old writer that restarts after the switch is ready and at the head, and still does not take the views back
    expect(decide({ ...base, schema: 'bootr_v10', heldBefore: true, mine, target: { name: 'bootr_v11', headSec: NOW - 1, alive: true } }).action).toBe('superseded');
    // its views were dropped with the schema they pointed at: nothing is served, so it takes them
    expect(decide({ ...base, schema: 'bootr_v10', heldBefore: true, mine, target: { name: null, headSec: null, alive: false } }).action).toBe('switch');
  });

  it('builds one drop and one create per table, the two Ponder tables included, and drops views the new index has no table for', () => {
    const sql = switchStatements('bootr_live', 'bootr_v11', ['token', 'trade'], ['gone']);
    expect(sql[0]).toBe('CREATE SCHEMA IF NOT EXISTS "bootr_live"');
    expect(sql[1]).toBe('DROP VIEW IF EXISTS "bootr_live"."gone"');
    expect(sql).toContain('CREATE VIEW "bootr_live"."trade" AS SELECT * FROM "bootr_v11"."trade"');
    expect(sql).toContain('CREATE VIEW "bootr_live"."_ponder_meta" AS SELECT * FROM "bootr_v11"."_ponder_meta"');
    expect(sql).toContain('CREATE VIEW "bootr_live"."_ponder_checkpoint" AS SELECT * FROM "bootr_v11"."_ponder_checkpoint"');
    expect(sql).toHaveLength(2 + 4 * 2);
  });

  it('accepts schema names and nothing that could leave the quotes', () => {
    expect(validName('bootr_v11')).toBe(true);
    expect(validName('bootr_3fa9c1e')).toBe(true);
    expect(validName('bootr"; drop schema x')).toBe(false);
    expect(validName('')).toBe(false);
    expect(validName(undefined)).toBe(false);
  });

  it('believes a cleared lock only after a missed heartbeat, and a set one only after Ponder would call it gone', () => {
    const now = 1_000_000;
    expect(writerAlive({ locked: true, heartbeatAt: now - 20_000 }, now)).toBe(true);
    expect(writerAlive({ locked: true, heartbeatAt: now - 31_000 }, now)).toBe(false);
    // a refused second writer clears the first one's lock flag while its heartbeat goes on
    expect(writerAlive({ locked: false, heartbeatAt: now - 9_000 }, now)).toBe(true);
    expect(writerAlive({ locked: false, heartbeatAt: now - 16_000 }, now)).toBe(false);
  });
});
