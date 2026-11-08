import { serve } from '@hono/node-server';
import { createApp } from './api.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { logger } from './log.js';
import { startCatalogChecks } from './model-check.js';
import { notifierPass } from './notify-health.js';
import { createContext } from './service.js';
import { runTelegramLoop } from './telegram.js';
import { tick } from './tick.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, close } = createDb(config.DATABASE_URL);
  const ctx = createContext(config, db);
  logger.info({ chainId: config.CHAIN_ID, port: config.SUPERVISOR_PORT, tickMs: config.SUPERVISOR_TICK_MS, admin: !!ctx.adminSigner, sessionSigner: ctx.sessionSigner.address }, 'supervisor starting');

  const server = serve({ fetch: createApp(ctx).fetch, port: config.SUPERVISOR_PORT }, (info) => logger.info({ port: info.port }, 'admin api listening'));

  let running = false;
  let stopped = false;
  const runTick = async () => {
    if (running || stopped) return;
    running = true;
    const started = Date.now();
    try {
      const report = await tick(ctx);
      logger.info({ ...report, ms: Date.now() - started }, 'tick');
    } catch (err) {
      logger.error({ err }, 'tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runTick(), config.SUPERVISOR_TICK_MS);
  void runTick();

  // Creator notifications run beside the tick, on their own clock: a slow chain read or a Telegram outage waits here, not there.
  let notifying = false;
  const runNotifier = async () => {
    if (notifying || stopped) return;
    notifying = true;
    try {
      const report = await notifierPass(ctx);
      if (report.sent || report.failed) logger.info(report, 'notifier');
    } finally {
      notifying = false;
    }
  };
  const notifyTimer = setInterval(() => void runNotifier(), config.NOTIFY_SWEEP_MS);
  // What the tick, the notifier and the API together sent to the RPC in the last minute, by method, with its cost in CDP
  // billing units (rpc-retry.ts): the line to read when the key is near its limit.
  const rpcTimer = setInterval(() => {
    const rpc = ctx.chain.rpc?.drain();
    if (rpc?.total) logger.info({ rpc }, 'rpc usage');
  }, config.SUPERVISOR_TICK_MS);
  const telegramStop = new AbortController();
  if (ctx.telegram) void runTelegramLoop(ctx, telegramStop.signal);
  // Direct mode: the model catalog is held against BlockRun's live list at start and every few hours (model-check.ts).
  const stopCatalogChecks = config.BLOCKRUN_DIRECT_MODE === 'off' ? () => undefined : startCatalogChecks(ctx);

  const shutdown = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(timer);
    clearInterval(notifyTimer);
    clearInterval(rpcTimer);
    stopCatalogChecks();
    telegramStop.abort();
    server.close();
    const deadline = Date.now() + 30_000;
    while ((running || notifying) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.error({ err }, 'supervisor failed to start');
  process.exit(1);
});
