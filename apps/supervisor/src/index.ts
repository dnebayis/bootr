import { serve } from '@hono/node-server';
import { createApp } from './api.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { logger } from './log.js';
import { createContext } from './service.js';
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

  const shutdown = async (signal: string) => {
    if (stopped) return;
    stopped = true;
    logger.info({ signal }, 'shutting down');
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
  logger.error({ err }, 'supervisor failed to start');
  process.exit(1);
});
