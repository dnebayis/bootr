/**
 * Everything of stage 5 is dark until the dataset is on (docs/design/agent-behaviour.md stage 5): with
 * `DATASET_ENABLED` not `true`, with nothing for the seam to serve, or with `PLATFORM_RECORDS=0`, a turn of the
 * platform account is what it was at the base of the stage, value for value. The base's answer is a recording, made
 * the way `test/round-off.test.ts` made its own: `fixtures/records-base-turn.json` is what `records-base-scenario.ts`
 * returned when it was run against commit bdeeb17 (how: the head of that file).
 *
 * With the dataset on and records to serve, the same turn differs by the `records` section and by the `record` field
 * of the two post tools, and by nothing else: the prompt is the owner's own (v1) and the tool list is the same.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { syncSources, ingestSighting } from '../src/dataset/store.js';
import { RECORD_FIELD_SENTENCE } from '@bootr/agent-core';
import { POSTING_DEFAULTS } from './posting-off.limits.js';
import { RECORDS_BASE_START, recordPlatformTurn as recordWith, type RecordedPlatformTurn } from './records-base-scenario.js';
import { infoOf, sighting } from './dataset-helpers.js';
import type { TestWorld } from './helpers.js';
import { resetWatchlistCache } from '../src/watchlist.js';
import { resetAccountChecks } from '../src/attributions.js';
import { resetMetricsBackoff } from '../src/post-performance.js';

// The base recording was made in a fresh process: what one turn reads into the module caches must not reach the next.
beforeEach(() => {
  resetWatchlistCache();
  resetAccountChecks();
  resetMetricsBackoff();
});

const base = JSON.parse(readFileSync(new URL('./fixtures/records-base-turn.json', import.meta.url), 'utf8')) as RecordedPlatformTurn;
type Tool = { function: { name: string; description: string; parameters: { properties: Record<string, unknown> } } };
const byName = (tools: unknown[]) => new Map((tools as Tool[]).map((t) => [t.function.name, t]));
const at = new Date(RECORDS_BASE_START - 2 * 3_600_000);
/** The recording was made with the posting limits at their defaults: so is every turn here, in whichever run (the posting-off run included). */
const recordPlatformTurn = (config: Record<string, string> = {}, seed?: (w: TestWorld) => Promise<void>) => recordWith({ ...POSTING_DEFAULTS, ...config }, seed);

/** Three records the seam would serve the platform account: an official release, a desk's story, a metric with numbers. */
async function seedRecords(w: TestWorld): Promise<void> {
  await syncSources(w.db, at);
  for (const [id, item] of [
    ['b:base-node', { title: 'Base node v0.14.2 is out', link: 'https://github.com/base/node/releases/tag/v0.14.2' }],
    ['b:decrypt', { title: 'Stripe opens stablecoin accounts to AI agents', link: 'https://decrypt.co/1/stripe-agents' }],
    ['b:x402-releases', { title: 'x402 v0.9.0 adds a payment router for agents', link: 'https://github.com/coinbase/x402/releases/tag/v0.9.0' }],
  ] as const) {
    await ingestSighting(w.db, infoOf(id), sighting(id, item, at), { now: at });
  }
}

const same = (now: RecordedPlatformTurn) => {
  expect(now.system).toBe(base.system);
  expect(now.tools).toEqual(base.tools);
  expect(now.observation).toEqual(base.observation);
  // one paid call, as at the base: nothing of the stage buys a thought
  expect(now.calls).toBe(base.calls);
};

describe('dark until the dataset is on: the platform account\'s turn is the base\'s, value for value', () => {
  it('the recording is of a turn worth comparing: the platform account, its slot due, the post tools offered', () => {
    expect(base.system).toContain('PLATFORM ACCOUNT');
    expect(base.observation.wakeReasons).toContain('original_post_due');
    expect([...byName(base.tools).keys()]).toEqual(expect.arrayContaining(['publish_post', 'schedule_post']));
    expect(base.observation).not.toHaveProperty('records');
  });

  it('DATASET_ENABLED unset, with records in the dataset', async () => {
    same(await recordPlatformTurn({}, seedRecords));
  });

  it('DATASET_ENABLED=false, with records in the dataset', async () => {
    same(await recordPlatformTurn({ DATASET_ENABLED: 'false' }, seedRecords));
  });

  it('DATASET_ENABLED=true with nothing to serve', async () => {
    same(await recordPlatformTurn({ DATASET_ENABLED: 'true' }));
  });

  it('DATASET_ENABLED=true and PLATFORM_RECORDS=0, with records in the dataset', async () => {
    same(await recordPlatformTurn({ DATASET_ENABLED: 'true', PLATFORM_RECORDS: '0' }, seedRecords));
  });

  it('the new gate settings alone change nothing either', async () => {
    same(await recordPlatformTurn({ NUMBER_GATE: 'enforce', PLATFORM_PROMPT: 'v1' }, seedRecords));
  });
});

describe('with the dataset on and records to serve, the turn differs by what the stage added, and by nothing else', () => {
  it('the records section, the record field of the two post tools; the prompt and everything else are the base\'s', async () => {
    const now = await recordPlatformTurn({ DATASET_ENABLED: 'true' }, seedRecords);
    expect(now.system).toBe(base.system);
    expect(now.calls).toBe(base.calls);
    const { records, ...rest } = now.observation;
    expect(rest).toEqual(base.observation);
    expect(records).toMatchObject({ instructionAuthority: false, suggested: { id: expect.stringMatching(/^r_[0-9a-f]{12}$/) } });
    expect((records as { items: unknown[] }).items).toHaveLength(3);
    // the same tools in the same order; every one as it was but the two post tools, which gain `record` and its sentence
    expect([...byName(now.tools).keys()]).toEqual([...byName(base.tools).keys()]);
    const was = byName(base.tools);
    for (const [name, tool] of byName(now.tools)) {
      if (name === 'publish_post' || name === 'schedule_post') {
        const before = was.get(name)!;
        expect(tool.function.description).toBe(`${before.function.description}${RECORD_FIELD_SENTENCE}`);
        expect(Object.keys(tool.function.parameters.properties)).toEqual([...Object.keys(before.function.parameters.properties), 'record']);
        const { record, ...others } = tool.function.parameters.properties;
        expect(others).toEqual(before.function.parameters.properties);
        expect(record).toMatchObject({ type: 'array', maxItems: 2 });
      } else {
        expect(tool, name).toEqual(was.get(name));
      }
    }
  });

  it('v2 of the platform prompt changes the prompt and nothing the turn is shown', async () => {
    const now = await recordPlatformTurn({ PLATFORM_PROMPT: 'v2' }, seedRecords);
    expect(now.system).not.toBe(base.system);
    expect(now.system).toContain('PLATFORM ACCOUNT');
    expect(now.observation).toEqual(base.observation);
    expect(now.tools).toEqual(base.tools);
  });
});
