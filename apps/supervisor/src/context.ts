import type { LocalAccount } from 'viem';
import type { AdminSigner } from './admin-signer.js';
import type { ChainContext } from './chain.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type * as schema from './db/schema.js';
import type { IndexerClient } from './indexer-client.js';
import type { KernelClient } from './kernel.js';
import type { Logger } from './log.js';
import type { MemoryStore } from './memories.js';
import type { SenderClient } from './sender-client.js';

export type AgentRow = typeof schema.agents.$inferSelect;
export type RuntimeRow = typeof schema.runtimes.$inferSelect;
export type TreasuryOpRow = typeof schema.treasuryOps.$inferSelect;

/** Everything a tick needs. Tests build one with mocks. */
export interface SupervisorContext {
  config: Config;
  db: Db;
  chain: ChainContext;
  sender: SenderClient;
  indexer: IndexerClient;
  memories: MemoryStore;
  sessionSigner: LocalAccount;
  adminSigner: AdminSigner | null;
  /** Kernel client for an agent (cached per permissionId). */
  kernelFor(agent: AgentRow): Promise<KernelClient>;
  fetch: typeof fetch;
  now(): number;
  log: Logger;
}
