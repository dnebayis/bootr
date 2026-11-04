import { customType, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Every table is prefixed `sv_` because the supervisor shares a Postgres database with the
 * sender, the inference relay and the indexer. Only the supervisor reads or writes these.
 */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const agentStatuses = ['onboarding', 'active', 'paused', 'revoked'] as const;
export type AgentStatus = (typeof agentStatuses)[number];

/** Launch source (chain.ts `LaunchSource`): which launcher emitted the agent's `AgentLaunched`, hence where its fees live. */
export const agentSources = ['bootr', 'clanker'] as const;
export type AgentSource = (typeof agentSources)[number];

/** One row per launched agent: identity, config and the installed session key. */
export const agents = pgTable('sv_agents', {
  agentId: text('agent_id').primaryKey(),
  token: text('token').notNull(),
  kernel: text('kernel').notNull().unique(),
  creator: text('creator').notNull(),
  /**
   * `bootr` (RWAGMI v3 locker, `settleAndClaim`) or `clanker` (Clanker v4 lockers, `collectRewards` + `claim`);
   * decided by the launcher that emitted the event (docs/design/clanker-launch.md). Rows older than the column are Bootr.
   */
  source: text('source', { enum: agentSources }).notNull().default('bootr'),
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

/** Postgres `bytea`; node-postgres returns a Buffer, PGlite a Uint8Array (callers normalise with `Buffer.from`). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Pictures made with `generate_image` (one row per image, bytes inline): private to the agent until it attaches
 * the `imageId` to a post or reply, when the supervisor hands the bytes to the sender for the X media upload.
 * Small enough for Postgres (the relay caps one image at a few MB; X takes 5 MB); nothing is pinned or served.
 */
export const images = pgTable(
  'sv_images',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    /** The `generate_image` action that paid for it (`sv_actions.action_id`). */
    actionId: text('action_id').notNull().unique(),
    alt: text('alt').notNull(),
    mime: text('mime').notNull(),
    bytes: bytea('bytes').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    model: text('model').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sv_images_agent_created_idx').on(t.agentId, t.createdAt)],
);

export const approvalKinds = ['post', 'reply'] as const;
export type ApprovalKind = (typeof approvalKinds)[number];
export const approvalStatuses = ['pending_approval', 'approved', 'rejected', 'failed'] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];
export const approvalDecisions = ['approve', 'reject'] as const;
export type ApprovalDecision = (typeof approvalDecisions)[number];

/**
 * Post approval mode (`config.requireApproval`): a `publish_post` / `publish_reply` the agent decided on is held
 * here instead of going to the sender. The creator approves (the supervisor sends it then, with the image if any,
 * and records the real post in `sv_actions`) or rejects (the note reaches the agent on its next turn). Pending
 * rows expire after `APPROVAL_TTL_MS` (approvals.ts): auto-rejected with the note "expired".
 */
export const approvals = pgTable(
  'sv_approvals',
  {
    /** The agent-core action id of the queued publish (`sv_actions.action_id`); also the sender actionId when approved. */
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    kind: text('kind', { enum: approvalKinds }).notNull(),
    text: text('text').notNull(),
    /** sha256 of the normalised text (dedupe within 24 h). */
    textHash: text('text_hash').notNull(),
    imageId: text('image_id'),
    /** The X post a reply answers. */
    inReplyTo: text('in_reply_to'),
    /** What the sender needs for a reply decided earlier: `{replyAuthorId?, replyEligibility?, attributions?}`. */
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: approvalStatuses }).notNull().default('pending_approval'),
    decision: text('decision', { enum: approvalDecisions }),
    /** The creator address, or 'system' for an expiry. */
    decidedBy: text('decided_by'),
    note: text('note'),
    /** The X post id once an approved item went out. */
    postId: text('post_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    decidedAt: ts('decided_at'),
    /** When the rejection (or failure) was surfaced to the agent; null = still to tell. */
    feedbackAt: ts('feedback_at'),
  },
  (t) => [index('sv_approvals_agent_status_idx').on(t.agentId, t.status), index('sv_approvals_agent_created_idx').on(t.agentId, t.createdAt)],
);

/** Small key/value store for pollers (launch event block cursor). */
export const cursors = pgTable('sv_cursors', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
