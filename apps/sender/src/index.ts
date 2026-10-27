import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { buildContext } from './bootstrap.js';
import { describeConfigError, loadConfig, type Config } from './config.js';
import { log } from './log.js';
import { startReconciler } from './reconcile.js';

let loaded: Config;
try {
  loaded = loadConfig();
} catch (err) {
  // Fail closed with a clear message (a missing or short SENDER_SERVICE_KEY lands here).
  log.error(`sender: invalid configuration, refusing to start: ${describeConfigError(err)}`);
  process.exit(1);
}

const { ctx, config, close } = buildContext(loaded);

const app = createApp(ctx);
const stopReconciler = startReconciler(ctx, config.SENDER_RECONCILE_INTERVAL_MS);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log.info(`sender listening on :${info.port}`);
});

const shutdown = () => {
  stopReconciler();
  server.close(() => void close().finally(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
