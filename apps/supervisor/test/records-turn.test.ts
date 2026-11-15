/**
 * Who is handed records and when (src/records-turn.ts): the platform account alone, with the dataset on, in a turn
 * that holds a due slot of its own to write from. Coin agents and own agents are the next stage: never here.
 */
import { describe, expect, it } from 'vitest';
import { platformRecordsLimit, platformServeRequest, recordsOn, slotToWriteFrom, turnRecords } from '../src/records-turn.js';
import { served } from './records-helpers.js';

const caps = { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false, services: false, bounties: false };
const platform = { platform: true, capabilities: caps };
const coin = { platform: false, capabilities: caps };
const on = { config: { DATASET_ENABLED: true, PLATFORM_RECORDS: 5, PLATFORM_RECORDS_MIN_GRADE: 1 } };
const slot = { schedule: { due: true, mayCompose: true } };
const throwingCtx = { ...on, db: null as never, now: () => 0, log: { warn: () => undefined, info: () => undefined } } as never;

describe('recordsOn', () => {
  it('the platform account, X publishing on, the dataset exactly on, PLATFORM_RECORDS above 0', () => {
    expect(recordsOn(on, platform)).toBe(true);
    expect(recordsOn(on, coin)).toBe(false);
    expect(recordsOn(on, { ...platform, capabilities: { ...caps, xPublish: false } })).toBe(false);
    expect(recordsOn({ config: { ...on.config, DATASET_ENABLED: false } }, platform)).toBe(false);
    expect(recordsOn({ config: { ...on.config, DATASET_ENABLED: 'true' } }, platform)).toBe(false);
    expect(recordsOn({ config: { ...on.config, PLATFORM_RECORDS: 0 } }, platform)).toBe(false);
    expect(recordsOn({}, platform)).toBe(false);
    expect(platformRecordsLimit({ config: { DATASET_ENABLED: true, PLATFORM_RECORDS: 3.7 } })).toBe(3);
  });
});

describe('the turn', () => {
  it('holds a due slot of its own: not the numbers post, not the digest, not a slot it may not use', () => {
    expect(slotToWriteFrom(slot)).toBe(true);
    expect(slotToWriteFrom({ schedule: { due: false, mayCompose: true } })).toBe(false);
    expect(slotToWriteFrom({ schedule: { due: true, mayCompose: false } })).toBe(false);
    expect(slotToWriteFrom({ ...slot, numbers: { day: '2026-11-15' } })).toBe(false);
    expect(slotToWriteFrom({ ...slot, digest: { week: '2026-W46' } })).toBe(false);
    expect(slotToWriteFrom({ schedule: null })).toBe(false);
  });

  it('a coin agent is handed nothing, whatever it is given; the platform account what the check found', async () => {
    const found = [served()];
    expect(await turnRecords(throwingCtx, { agentId: '77', token: '0x3' }, coin, slot, found)).toEqual([]);
    expect(await turnRecords(throwingCtx, { agentId: '1', token: '0x3' }, platform, slot, found)).toEqual(found);
    expect(await turnRecords(throwingCtx, { agentId: '1', token: '0x3' }, platform, { schedule: { due: false, mayCompose: true } }, found)).toEqual([]);
  });

  it('a seam that fails hands the turn nothing and does not throw', async () => {
    expect(await turnRecords(throwingCtx, { agentId: '1', token: '0x3' }, platform, slot)).toEqual([]);
  });

  it('asks the seam for every cluster and grade, its own coin, without the platform totals', () => {
    expect(platformServeRequest(on as never, { agentId: '1153600', token: '0xb1c3' })).toEqual({ agentId: '1153600', beat: { topics: 'all', coin: '0xb1c3', withoutSources: ['a:indexer'] }, minGrade: 1, limit: 5 });
    expect(platformServeRequest({ config: { ...on.config, PLATFORM_RECORDS_MIN_GRADE: 3 } } as never, { agentId: '1', token: '0x' }).minGrade).toBe(3);
  });
});
