/**
 * How the dataset process is deployed (docker-compose.coolify.yml, scripts/build.mjs): its own service on the
 * supervisor's image, off unless the owner sets the flag, and holding none of the secrets the other services hold.
 * The compose file is read as text: these are the lines a deploy depends on.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const compose = read('../../../docker-compose.coolify.yml');

/** A service's block: from its name at two spaces of indent to the next service or top-level key. */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no service ${name}`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n|\n[a-z][a-z-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
const stripped = (block: string) => [...block.matchAll(/-u ([A-Z0-9_]+)/g)].map((m) => m[1]!);
const declared = (block: string) => [...block.slice(block.indexOf('environment:')).matchAll(/^ {6}([A-Z0-9_]+):/gm)].map((m) => m[1]!);

describe('the dataset service', () => {
  const dataset = service('dataset');

  it("runs the supervisor's image with the second entry point, on the supervisor's database", () => {
    expect(dataset).toContain('image: ghcr.io/dnebayis/bootr-supervisor:${IMAGE_TAG:-main}');
    expect(dataset).toMatch(/node dist\/dataset\.js"\]/);
    expect(dataset).not.toContain('migrate');
    const url = /DATABASE_URL: (.+)/;
    expect(url.exec(dataset)![1]).toBe(url.exec(service('supervisor'))![1]);
    // the indexer reader once INDEXER_INTERNAL_URL is set (docs/deploy/live-switch.md), the compose indexer until then
    expect(dataset).toContain('INDEXER_URL: ${INDEXER_INTERNAL_URL:-http://indexer:42069}');
    expect(/INDEXER_URL: (.+)/.exec(dataset)![1]).toBe(/INDEXER_URL: (.+)/.exec(service('supervisor'))![1]);
    expect(dataset).toMatch(/mem_limit: \d+m/);
    expect(dataset).toContain('restart');
    // its own health check, on its own port
    expect(dataset).toContain("fetch('http://127.0.0.1:3005/health')");
    expect(dataset).toContain('DATASET_PORT: "3005"');
  });

  it('is off unless the owner sets the flag: the default is empty, in its own block and in the supervisor', () => {
    expect(dataset).toContain('DATASET_ENABLED: ${DATASET_ENABLED:-}');
    expect(service('supervisor')).toContain('DATASET_ENABLED: ${DATASET_ENABLED:-}');
    for (const other of ['web', 'inference', 'indexer']) expect(declared(service(other)).filter((name) => name.startsWith('DATASET_'))).toEqual([]);
    // The sender holds layer c's cap, its key and the account that reads; all three empty by default, so X is off.
    expect(declared(service('sender')).filter((name) => name.startsWith('DATASET_')).sort()).toEqual(['DATASET_SENDER_KEY', 'DATASET_X_POSTS_PER_DAY', 'DATASET_X_READER_AGENT_ID']);
    for (const name of ['DATASET_SENDER_KEY', 'DATASET_X_POSTS_PER_DAY', 'DATASET_X_READER_AGENT_ID']) expect(service('sender')).toContain(`${name}: \${${name}:-}`);
    for (const name of ['DATASET_SENDER_KEY', 'DATASET_X_POSTS_PER_DAY']) expect(dataset).toContain(`${name}: \${${name}:-}`);
  });

  it("gives the dataset's sender key to the sender and the dataset alone, and strips it from every other service", () => {
    for (const name of ['sender', 'dataset']) expect(stripped(service(name))).not.toContain('DATASET_SENDER_KEY');
    for (const name of ['inference', 'indexer', 'web', 'supervisor']) expect(stripped(service(name)), name).toContain('DATASET_SENDER_KEY');
    expect(dataset).toContain('SENDER_URL: http://sender:3002');
  });

  it('holds no secret but its sender key: every other secret any service strips is stripped from it', () => {
    const everySecret = new Set(['postgres', 'sender', 'inference', 'indexer', 'web', 'supervisor'].flatMap((name) => stripped(service(name))));
    expect(everySecret.size).toBeGreaterThan(20);
    const mine = new Set(stripped(dataset));
    // Its one key opens the sender's dataset reads and nothing else (the case above).
    expect([...everySecret].filter((name) => !mine.has(name))).toEqual(['DATASET_SENDER_KEY']);
    for (const key of ['SESSION_SIGNER_PRIVATE_KEY', 'SPENDER_MASTER_KEY', 'ADMIN_PRIVATE_KEY', 'SUPERVISOR_SERVICE_KEY', 'SENDER_SERVICE_KEY', 'INDEXER_SERVICE_KEY', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN', 'SEARCH_API_KEY', 'BASE_RPC_URL', 'BUNDLER_URL', 'X_CLIENT_SECRET', 'SESSION_SECRET']) expect(mine.has(key), key).toBe(true);
    expect(declared(dataset).sort()).toEqual(['DATABASE_URL', 'DATASET_CHAIN_EVERY_MS', 'DATASET_ENABLED', 'DATASET_PASS_MS', 'DATASET_PORT', 'DATASET_RECORDS_PER_DAY', 'DATASET_SENDER_KEY', 'DATASET_SOURCES_PER_PASS', 'DATASET_SOURCE_RECORDS_PER_DAY', 'DATASET_SOURCE_SIGHTINGS_PER_DAY', 'DATASET_X_POSTS_PER_DAY', 'INDEXER_URL', 'LOG_LEVEL', 'SENDER_URL']);
    // nothing else it declares is something another service strips
    expect(declared(dataset).filter((name) => everySecret.has(name))).toEqual(['DATASET_SENDER_KEY']);
    expect(dataset).toMatch(/exec env -u /);
  });
});

describe('the image', () => {
  it('builds the dataset entry beside the supervisor and the migration', () => {
    const build = read('../scripts/build.mjs');
    for (const pair of ["['src/index.ts', 'dist/index.js']", "['src/db/migrate.ts', 'dist/db/migrate.js']", "['src/dataset/main.ts', 'dist/dataset.js']"]) expect(build).toContain(pair);
    // the runtime stage copies the whole dist folder, so the second entry needs no line of its own
    expect(read('../Dockerfile')).toContain('COPY --from=build /repo/apps/supervisor/dist apps/supervisor/dist');
  });
});
