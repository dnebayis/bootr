import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AGENT_TOOLS } from '@/components/docs/agent-tools';

/**
 * The schedule tools (docs/design/agent-tools-2.md section 17.3) reach agent-core from another branch of the same
 * release than the one that documents them, so the check holds on both sides of that merge: the docs always list the
 * three, directly after `finish`, and once agent-core has them the two lists are compared whole, order included.
 */
const SCHEDULE_TOOLS = ['schedule_post', 'scheduled_list', 'scheduled_cancel'];

it('documents exactly the tools of packages/agent-core, in the same order', () => {
  const src = readFileSync(path.resolve(import.meta.dirname, '../../../../packages/agent-core/src/tools.ts'), 'utf8');
  const names = [...src.matchAll(/^\s+(\w+): define\(/gm)].map((m) => m[1]!);
  expect(names.length).toBeGreaterThan(10);
  const documented = AGENT_TOOLS.map((t) => t.name);
  const merged = SCHEDULE_TOOLS.every((n) => names.includes(n));
  expect(merged ? documented : documented.filter((n) => !SCHEDULE_TOOLS.includes(n))).toEqual(names);
  expect(documented.slice(documented.indexOf('finish') + 1, documented.indexOf('finish') + 4)).toEqual(SCHEDULE_TOOLS);
  expect(documented.indexOf('note_what_works')).toBe(documented.indexOf('recall') + 1);
});
