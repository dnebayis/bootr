/** Composition root shared by `index.ts` and the tests. */
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { createLocalAdminSigner } from './admin-signer.js';
import { createChainContext } from './chain.js';
import type { Config } from './config.js';
import type { AgentRow, SupervisorContext } from './context.js';
import type { Db } from './db/client.js';
import { IndexerClient } from './indexer-client.js';
import { createKernelClient, type KernelClient } from './kernel.js';
import { logger } from './log.js';
import { MemoryStore } from './memories.js';
import { SenderClient } from './sender-client.js';

export function createContext(config: Config, db: Db, overrides: Partial<SupervisorContext> = {}): SupervisorContext {
  const chain = overrides.chain ?? createChainContext(config);
  const sessionSigner = overrides.sessionSigner ?? privateKeyToAccount(config.SESSION_SIGNER_PRIVATE_KEY as Hex);
  const fetchImpl = overrides.fetch ?? globalThis.fetch;
  const adminSigner =
    overrides.adminSigner !== undefined
      ? overrides.adminSigner
      : config.ADMIN_PRIVATE_KEY
        ? createLocalAdminSigner({ privateKey: config.ADMIN_PRIVATE_KEY as Hex, chain: chain.chain, rpcUrl: config.RPC_URL as string, guardian: chain.guardian, publicClient: chain.publicClient })
        : null;
  const kernels = new Map<string, Promise<KernelClient>>();
  const ctx: SupervisorContext = {
    config,
    db,
    chain,
    sender: overrides.sender ?? new SenderClient(config.SENDER_URL, config.SENDER_SERVICE_KEY, fetchImpl),
    indexer: overrides.indexer ?? new IndexerClient(config.INDEXER_URL, config.SENDER_SERVICE_KEY, fetchImpl),
    memories: overrides.memories ?? new MemoryStore(db),
    sessionSigner,
    adminSigner,
    fetch: fetchImpl,
    now: overrides.now ?? (() => Date.now()),
    log: overrides.log ?? logger,
    kernelFor:
      overrides.kernelFor ??
      (async (agent: AgentRow) => {
        if (!agent.permissionId) throw new Error(`agent ${agent.agentId} has no session key`);
        const builderCode = config.BUILDER_CODES_ENABLED ? (agent.builderCode ?? null) : null;
        const key = `${agent.kernel}:${agent.permissionId}:${builderCode ?? ''}`;
        let client = kernels.get(key);
        if (!client) {
          client = createKernelClient({
            publicClient: chain.publicClient,
            chain: chain.chain,
            kernel: agent.kernel as Hex,
            guardian: chain.guardian,
            permissionId: agent.permissionId as Hex,
            ...(agent.validatorData ? { validatorData: agent.validatorData as Hex } : {}),
            sessionSigner,
            bundlerUrl: config.BUNDLER_URL,
            ...(config.PAYMASTER_URL ? { paymasterUrl: config.PAYMASTER_URL } : {}),
            // an op that still finds the permission uninstalled (enable mode) is self-bundled too
            ...(config.ENABLE_MODE_SELF_BUNDLE && adminSigner ? { selfBundle: adminSigner } : {}),
            ...(builderCode ? { builderCode } : {}),
          });
          kernels.set(key, client);
        }
        return client;
      }),
  };
  return ctx;
}
