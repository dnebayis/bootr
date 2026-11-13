/**
 * Setup of the run `vitest run -c vitest.posting-off.config.ts` (docs/design/agent-tools-2.md section 17.1 rule 4):
 * every limit the posting workstream added is switched off before any test builds its config, so the whole suite runs
 * as it did before threads, comments, the mention audience and the open reply audience existed. A test that names one
 * of these values itself keeps its own value.
 */
import { vi } from 'vitest';
import { POSTING_OFF } from './posting-off.limits.js';

vi.mock('../src/config.js', async (original) => {
  const actual = await original<typeof import('../src/config.js')>();
  return { ...actual, loadConfig: (env: NodeJS.ProcessEnv = process.env) => actual.loadConfig({ ...POSTING_OFF, ...env }) };
});
