/**
 * The dataset process: the second entry point of the supervisor image (`node dist/dataset.js`, built by
 * scripts/build.mjs, run as the `dataset` service of docker-compose.coolify.yml on the supervisor's database). It
 * builds Bootr's own dataset (docs/design/agent-behaviour.md section 6.4) and does nothing else: it serves no agent,
 * holds no key and calls no model. With `DATASET_ENABLED` unset it starts, answers its health check and reads nothing.
 */
import { createServer } from 'node:http';
import { createDb } from '../db/client.js';
import { IndexerClient } from '../indexer-client.js';
import { createLogger } from '../log.js';
import { loadDatasetConfig } from './config.js';
import { datasetPass, newPassState } from './run.js';

async function main(): Promise<void> {
  const config = loadDatasetConfig();
  const log = createLogger({ level: config.LOG_LEVEL }).child({ process: 'dataset' });
  const { db, close } = createDb(config.DATABASE_URL);
  // The indexer's public reads only: the key its internal route asks for is not given to this process.
  const indexer = new IndexerClient(config.INDEXER_URL, '');
  const state = newPassState();
  let running = false;
  let stopped = false;
  let lastPassAt: number | null = null;
  let lastError: string | null = null;

  const runPass = async () => {
    if (running || stopped || !config.DATASET_ENABLED) return;
    running = true;
    const started = Date.now();
    try {
      const report = await datasetPass({ db, indexer, log, chainEveryMs: config.DATASET_CHAIN_EVERY_MS, sourcesPerPass: config.DATASET_SOURCES_PER_PASS, recordsPerDay: config.DATASET_RECORDS_PER_DAY, sourceRecordsPerDay: config.DATASET_SOURCE_RECORDS_PER_DAY, sourceSightingsPerDay: config.DATASET_SOURCE_SIGHTINGS_PER_DAY }, state, new Date());
      lastPassAt = Date.now();
      lastError = null;
      if (report.chain || report.open.read || report.open.failed || report.aged) log.info({ ...report, ms: Date.now() - started }, 'dataset pass');
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 200) : 'pass failed';
      log.error({ err }, 'dataset pass failed');
    } finally {
      running = false;
    }
  };

  // Healthy while off, and while on as long as a pass finished within the last thirty intervals (a pass in which every
  // source times out is still far shorter than that).
  const startedAt = Date.now();
  const server = createServer((req, res) => {
    const stale = config.DATASET_ENABLED && Date.now() - (lastPassAt ?? startedAt) > 30 * config.DATASET_PASS_MS;
    const ok = req.url === '/health' && !stale;
    res.writeHead(req.url === '/health' ? (ok ? 200 : 503) : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/health' ? { ok, enabled: config.DATASET_ENABLED, lastPassAt: lastPassAt ? new Date(lastPassAt).toISOString() : null, lastError } : { error: 'not_found' }));
  });
  server.listen(config.DATASET_PORT, () => log.info({ port: config.DATASET_PORT, enabled: config.DATASET_ENABLED, passMs: config.DATASET_PASS_MS }, config.DATASET_ENABLED ? 'dataset starting' : 'dataset is off (DATASET_ENABLED is not true): nothing is read'));

  const timer = setInterval(() => void runPass(), config.DATASET_PASS_MS);
  void runPass();

  const shutdown = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    log.info({ signal }, 'shutting down');
    clearInterval(timer);
    server.close();
    const deadline = Date.now() + 30_000;
    while (running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('dataset failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
