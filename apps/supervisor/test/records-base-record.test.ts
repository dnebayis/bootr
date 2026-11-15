/**
 * Writes `fixtures/records-base-turn.json` from `records-base-scenario.ts`. Skipped unless `RECORD_BASE_TURN=1`: it is
 * run once, in a tree of the base commit, as `test/records-base-scenario.ts` says.
 */
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { recordPlatformTurn } from './records-base-scenario.js';

it.skipIf(process.env.RECORD_BASE_TURN !== '1')('records the platform turn of the base', async () => {
  const turn = await recordPlatformTurn();
  writeFileSync(new URL('./fixtures/records-base-turn.json', import.meta.url), `${JSON.stringify(turn, null, 2)}\n`);
});
