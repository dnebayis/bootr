import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { buildContext } from './bootstrap.js';
import { log } from './log.js';
import { startReconciler } from './reconcile.js';

const { ctx, config, close } = buildContext();

if (config.SENDER_SERVICE_KEY.length < 32) {
  log.warn('SENDER_SERVICE_KEY is shorter than 32 characters; use a long random secret');
}

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
