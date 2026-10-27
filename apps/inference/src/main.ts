import { serve } from '@hono/node-server';
import type { Network } from '@x402/core/types';
import { createApp } from './app.js';
import { loadConfig, resolveFacilitatorUrl } from './config.js';
import { createDb } from './db/client.js';
import { loadPriceTable } from './pricing.js';
import { createReconciler, createRpcAuthorizationChecker } from './reconcile.js';
import { PgRequestStore } from './store.js';
import { createOpenRouterClient } from './upstream.js';
import { createFacilitatorClient, createPaymentGate } from './x402.js';

const config = loadConfig();
const priceTable = loadPriceTable(config.INFERENCE_PRICE_TABLE_JSON);
const network = config.X402_NETWORK as Network;
const facilitatorUrl = resolveFacilitatorUrl(config.X402_NETWORK, config.X402_FACILITATOR_URL);

const { db, close } = createDb(config.DATABASE_URL);
const store = new PgRequestStore(db);

const gate = createPaymentGate({
  network,
  payTo: config.INFERENCE_PAYTO_ADDRESS,
  schemes: config.INFERENCE_X402_SCHEMES,
  maxTimeoutSeconds: config.INFERENCE_PAYMENT_TIMEOUT_SECONDS,
  facilitator: createFacilitatorClient(
    facilitatorUrl,
    config.CDP_API_KEY_ID && config.CDP_API_KEY_SECRET
      ? { keyId: config.CDP_API_KEY_ID, keySecret: config.CDP_API_KEY_SECRET }
      : undefined,
  ),
});

const app = createApp({
  store,
  gate,
  priceTable,
  network,
  payTo: config.INFERENCE_PAYTO_ADDRESS,
  paymentTimeoutSeconds: config.INFERENCE_PAYMENT_TIMEOUT_SECONDS,
  upstream: createOpenRouterClient({
    apiKey: config.OPENROUTER_API_KEY,
    timeoutMs: config.INFERENCE_UPSTREAM_TIMEOUT_MS,
  }),
  reconcile: createReconciler({
    store,
    checker: config.INFERENCE_RPC_URL
      ? createRpcAuthorizationChecker(config.INFERENCE_RPC_URL)
      : undefined,
    staleAfterMs: (config.INFERENCE_PAYMENT_TIMEOUT_SECONDS + 60) * 1000,
    log: console,
  }),
});

// Fail fast on facilitator/scheme misconfiguration, but keep serving /health if it is down;
// paid requests retry initialization lazily.
gate.initialize().catch((err: unknown) => {
  console.error(`x402 facilitator initialization failed (${facilitatorUrl}): ${String(err)}`);
});

const server = serve({ fetch: app.fetch, port: config.INFERENCE_PORT }, (info) => {
  console.log(`inference listening on :${info.port} (${network}, facilitator ${facilitatorUrl})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void close().finally(() => process.exit(0));
  });
}
