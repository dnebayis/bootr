import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRAPHQL_EXAMPLES } from '@/components/docs/graphql-examples';

/**
 * The docs' example queries may only select fields that exist in the indexer schema. Ponder generates the
 * GraphQL schema from `ponder.schema.ts`: one `x(id)` and one paged `xs(...)` field per table, a GraphQL field
 * per column and per relation, and `items` / `pageInfo` on every page.
 */
const schemaSrc = readFileSync(path.resolve(import.meta.dirname, '../../../indexer/ponder.schema.ts'), 'utf8');

const tables = [...schemaSrc.matchAll(/export const (\w+) = onchainTable\(/g)].map((m) => m[1]!);
const columns = [...schemaSrc.matchAll(/^\s+(\w+): t\.\w+\(/gm)].map((m) => m[1]!);
const relations = [...schemaSrc.matchAll(/^\s+(\w+): (?:one|many)\(/gm)].map((m) => m[1]!);
const known = new Set([...tables, ...tables.map((t) => `${t}s`), ...columns, ...relations, 'items', 'pageInfo', 'hasNextPage', 'endCursor', 'startCursor', 'hasPreviousPage']);

/** Selected field names: drop strings, argument lists and the operation header, keep identifiers. */
function selectedFields(query: string): string[] {
  const body = query
    .replace(/"[^"]*"/g, '')
    .replace(/^\s*query\s+\w+\s*(\([^)]*\))?/, '')
    .replace(/\([^)]*\)/g, '');
  return [...body.matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]);
}

describe('GraphQL examples on /docs/api', () => {
  it('parse the schema file', () => {
    expect(tables).toContain('token');
    expect(columns).toContain('agentBps');
    expect(relations).toContain('feeSlots');
  });

  for (const ex of GRAPHQL_EXAMPLES) {
    it(`${ex.id} selects only fields the indexer has`, () => {
      const fields = selectedFields(ex.query);
      expect(fields.length).toBeGreaterThan(3);
      expect(fields.filter((f) => !known.has(f))).toEqual([]);
    });
  }
});
