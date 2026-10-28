import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AGENT_TOOLS } from '@/components/docs/agent-tools';

it('documents exactly the tools of packages/agent-core, in the same order', () => {
  const src = readFileSync(path.resolve(import.meta.dirname, '../../../../packages/agent-core/src/tools.ts'), 'utf8');
  const names = [...src.matchAll(/^\s+(\w+): define\(/gm)].map((m) => m[1]);
  expect(names.length).toBeGreaterThan(10);
  expect(AGENT_TOOLS.map((t) => t.name)).toEqual(names);
});
