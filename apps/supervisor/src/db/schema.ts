import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Every table is prefixed `sv_` because the supervisor shares a Postgres database with the
 * sender, the inference relay and the indexer. Only the supervisor reads or writes these.
 */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const agentStatuses = ['onboarding', 'active', 'paused', 'revoked'] as const;
export type AgentStatus = (typeof agentStatuses)[number];

/** One row per launched agent: identity, config and the installed session key. */
export const agents = pgTable('sv_agents', {
  agentId: text('agent_id').primaryKey(),
  token: text('token').notNull(),
  kernel: text('kernel').notNull().unique(),
  creator: text('creator').notNull(),
  /** agent-core `AgentConfig` (possibly incomplete until the X account is connected). */
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  permissionId: text('permission_id'),
  /** `abi.encode(bytes[] permissionEnableData)` installed for permissionId. */
  validatorData: text('validator_data'),
  /** The policy parameters that produced validatorData (JSON, bigints as strings). */
  sessionPolicy: jsonb('session_policy').$type<Record<string, unknown>>(),
  /**
   * The agent's x402 spender EOA (derived from SPENDER_MASTER_KEY and the agent id; see spender.ts): the only
   * USDC recipient the session key may fund, and the account that signs EIP-3009 payments to the relay.
   * null until derived (filled at registration, backfilled on later ticks).
   */
  spender: text('spender'),
  sessionValidUntil: ts('session_valid_until'),
  sessionKeyInstalledAt: ts('session_key_installed_at'),
  launchBlock: integer('launch_block'),
  launchTxHash: text('launch_tx_hash'),
  /** Base Builder Code registered for the kernel address (ERC-8021 suffix on every session userOp); null until registered. */
  builderCode: text('builder_code'),
  /**
   * Launch-form draft id (`id` of the JSON `context` in BootrLauncher's LaunchContext): the X account is connected
   * under it before launch and rebound to `agentId` during onboarding. null = not decoded yet; '' = decoded, none.
   */
  draftId: text('draft_id'),
  status: text('status', { enum: agentStatuses }).notNull().default('onboarding'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const runtimeStatuses = ['ready', 'running', 'waiting', 'held', 'paused', 'sleeping'] as const;
export type RuntimeStatus = (typeof runtimeStatuses)[number];

/** Worker runtime per agent: bounded state, cycle counter, lease and the one pending action. */
export const runtimes = pgTable(
  'sv_runtimes',
  {
    agentId: text('agent_id').primaryKey(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    cycle: integer('cycle').notNull().default(0),
    leaseToken: text('lease_token'),
    leaseUntil: ts('lease_until'),
    pending: jsonb('pending').$type<Record<string, unknown> | null>(),
    /** The in-flight turn (chat messages, step count) so a crash or held action can resume it. */
    turn: jsonb('turn').$type<Record<string, unknown> | null>(),
    nextAt: ts('next_at').notNull(),
    lastDecisionAt: ts('last_decision_at'),
    lastDecisionRevision: integer('last_decision_revision'),
    configRevision: integer('config_revision').notNull().default(0),
    status: text('status', { enum: runtimeStatuses }).notNull().default('ready'),
    /** 'operator' (admin API) or 'guardian' (creator paused on-chain); null when not paused. */
    pausedBy: text('paused_by'),
    failures: integer('failures').notNull().default(0),
    lastError: text('last_error'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('sv_runtimes_next_at_idx').on(t.status, t.nextAt)],
);

export const actionStatuses = ['sending', 'sent', 'held', 'completed', 'failed'] as const;

/** Every brokered tool call, keyed by the deterministic agent-core action id. */
export const actions = pgTable(
  'sv_actions',
  {
    actionId: text('action_id').primaryKey(),
    agentId: text('agent_id').notNull(),
    cycleKey: text('cycle_key').notNull(),
    action: jsonb('action').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: actionStatuses }).notNull(),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    receipt: jsonb('receipt').$type<Record<string, unknown> | null>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('sv_actions_agent_created_idx').on(t.agentId, t.createdAt)],
);

/** Private agent notes (`remember` / `recall`). */
export const memories = pgTable(
  'sv_memories',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    text: text('text').notNull(),
    sources: jsonb('sources').$type<string[]>().notNull().default([]),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    visibility: text('visibility').notNull().default('private'),
    supersedes: text('supersedes'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sv_memories_agent_idx').on(t.agentId, t.createdAt)],
);

export const inferenceStatuses = ['pending', 'succeeded', 'failed', 'unknown'] as const;

/** One paid inference request per (agent, cycle); the relay replays by idempotency key. */
export const inference = pgTable(
  'sv_inference',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    agentId: text('agent_id').notNull(),
    cycle: integer('cycle').notNull(),
    requestHash: text('request_hash').notNull(),
    /** The exact request body, so an `unknown` row can be replayed with the same key. */
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: inferenceStatuses }).notNull(),
    response: jsonb('response').$type<Record<string, unknown> | null>(),
    receipt: jsonb('receipt').$type<Record<string, unknown> | null>(),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('sv_inference_agent_idx').on(t.agentId, t.status)],
);

export const treasuryOpKinds = ['claim_fees', 'swap', 'fund_model', 'fund_gas', 'transfer'] as const;
export type TreasuryOpKind = (typeof treasuryOpKinds)[number];
export const treasuryOpStatuses = ['prepared', 'sent', 'unknown', 'confirmed', 'failed'] as const;
export type TreasuryOpStatus = (typeof treasuryOpStatuses)[number];

/** Prepared and executed kernel userOps. A sent op is never replaced; it is reconciled by hash. */
export const treasuryOps = pgTable(
  'sv_treasury_ops',
  {
    opId: text('op_id').primaryKey(),
    agentId: text('agent_id').notNull(),
    kind: text('kind', { enum: treasuryOpKinds }).notNull(),
    /** `[{to, value, data}]` with value as a decimal string. */
    calls: jsonb('calls').$type<{ to: string; value: string; data: string }[]>().notNull(),
    /** sha256 of the canonical calls; `treasury_execute` must present it as `expectedHash`. */
    callHash: text('call_hash').notNull(),
    description: text('description').notNull(),
    /** Who prepared the op: 'policy' (fee claim loop) or 'model' (treasury_prepare). */
    origin: text('origin').notNull(),
    userOpHash: text('user_op_hash'),
    txHash: text('tx_hash'),
    status: text('status', { enum: treasuryOpStatuses }).notNull().default('prepared'),
    error: text('error'),
    sentAt: ts('sent_at'),
    confirmedAt: ts('confirmed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('sv_treasury_ops_agent_idx').on(t.agentId, t.status)],
);

/** Small key/value store for pollers (launch event block cursor). */
export const cursors = pgTable('sv_cursors', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
