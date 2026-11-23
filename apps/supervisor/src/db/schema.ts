import { sql } from 'drizzle-orm';
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Every table is prefixed `sv_` because the supervisor shares a Postgres database with the
 * sender, the inference relay and the indexer. Only the supervisor reads or writes these.
 */
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const agentStatuses = ['onboarding', 'active', 'paused', 'revoked'] as const;
export type AgentStatus = (typeof agentStatuses)[number];

/** Launch source (chain.ts `LaunchSource`): which launcher emitted the agent's `AgentLaunched`, hence where its fees live. */
export const agentSources = ['bootr', 'clanker', 'clanker-v5'] as const;
export type AgentSource = (typeof agentSources)[number];

/** One row per launched agent: identity, config and the installed session key. */
export const agents = pgTable('sv_agents', {
  agentId: text('agent_id').primaryKey(),
  token: text('token').notNull(),
  kernel: text('kernel').notNull().unique(),
  creator: text('creator').notNull(),
  /**
   * `bootr` (RWAGMI v3 locker, `settleAndClaim`), `clanker` (Clanker v4 lockers, `collectRewards` + `claim`) or
   * `clanker-v5` (Clanker v5 `FeeEscrow`, `claimFor`); decided by the launcher that emitted the event
   * (docs/design/clanker-launch.md, docs/design/clanker-v5-migration.md). Rows older than the column are Bootr. A plain
   * text column (no database enum or check), so the new value needs no migration.
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

/** What a typed note is about (docs/design/agent-behaviour.md section 6.2); `note` is a keyed note that named no kind. */
export const memoryKinds = ['person', 'promise', 'lesson', 'coin', 'note'] as const;
export type MemoryKind = (typeof memoryKinds)[number];

/**
 * Private agent notes (`remember` / `recall`). A note with a `key` is one subject's one note (memories.ts): the same
 * kind and key again updates the row in place, `created_at` stays the first time it was noted, `updated_at` is the
 * last and `count` how many times it was written (null on a row written once, and on every row older than the columns).
 * A promise carries `due_at` and is open until `closed_at` is set. All six columns are null on a plain note.
 */
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
    kind: text('kind', { enum: memoryKinds }),
    key: text('key'),
    updatedAt: ts('updated_at'),
    count: integer('count'),
    dueAt: ts('due_at'),
    closedAt: ts('closed_at'),
  },
  (t) => [index('sv_memories_agent_idx').on(t.agentId, t.createdAt), uniqueIndex('sv_memories_agent_key_idx').on(t.agentId, t.kind, t.key).where(sql`${t.key} is not null`)],
);

/**
 * One row per finished turn (turns.ts; docs/design/agent-behaviour.md section 5): what woke it, how long it ran, how
 * many thoughts it bought, how it ended, what it published and what it cost. Until this table a turn existed only
 * while it ran (`sv_runtimes.turn`) and its wake reasons only as a log line, so "turns that end without a post" and
 * "fuel per post" could only be estimated. Written once, when the turn is dropped from the runtime row; never read by
 * the runtime itself. `id` is `<agentId>:<role>:<startedAt ms>` for a hosted turn and the turn's own id (`otn_…`) for
 * an own agent's, whose `thoughts` are its tool calls (its thinking happens in the creator's client and costs no fuel).
 */
export const turns = pgTable(
  'sv_turns',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    /** `social`, `treasury` or `judge` (agent-core `AgentRole`). */
    role: text('role').notNull(),
    /** `own` when the creator's own client ran the turn; null for a turn Bootr hosted. */
    via: text('via'),
    wakeReasons: jsonb('wake_reasons').$type<string[]>().notNull().default([]),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at').notNull(),
    thoughts: integer('thoughts').notNull().default(0),
    /** runtime.ts `TurnOutcome` for a hosted turn; `finished` or own/turns.ts `CloseWhy` for an own one. */
    outcome: text('outcome').notNull(),
    /** Original posts of the turn that went out or were queued for the creator's review. */
    posted: integer('posted').notNull().default(0),
    /** Replies of the turn that went out or were queued. */
    replied: integer('replied').notNull().default(0),
    /** What the turn's paid model calls cost (thoughts and pictures; sv_inference), a decimal string like every micro-USDC column. */
    chargedMicroUsdc: text('charged_micro_usdc').notNull().default('0'),
  },
  (t) => [index('sv_turns_agent_started_idx').on(t.agentId, t.startedAt)],
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

export const serviceCallStatuses = ['pending', 'paid', 'succeeded', 'failed', 'unknown'] as const;
export type ServiceCallStatus = (typeof serviceCallStatuses)[number];

/**
 * Paid web services (`x402_fetch`, services.ts): one row per call the model asked for, keyed by the agent-core action
 * id, so the same action never pays twice. `pending` before any signature (nothing can have moved); `paid` once the
 * spender signed, until the answer or the chain settles it; `succeeded` with the answer; `failed` with no money owed
 * (refused, unpaid, or paid and lost: `error` says which); `unknown` when the money may have moved and no answer came,
 * closed by the chain alone (`reconcileServiceCall`). `quote_micro_usdc` is what was signed for, `charged_micro_usdc`
 * what the chain says moved (null until known). The public tape shows host, amount and the model's reason.
 */
export const serviceCalls = pgTable(
  'sv_service_calls',
  {
    /** The agent-core action id (`sv_actions.action_id`) of the `x402_fetch` call. */
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    url: text('url').notNull(),
    host: text('host').notNull(),
    method: text('method').notNull(),
    /** The model's reason, plain text, public. */
    reason: text('reason').notNull(),
    status: text('status', { enum: serviceCallStatuses }).notNull().default('pending'),
    /** The cap this call ran under (min of the model's price, the per-call cap and what the day had left). */
    capMicroUsdc: text('cap_micro_usdc').notNull(),
    quoteMicroUsdc: text('quote_micro_usdc'),
    chargedMicroUsdc: text('charged_micro_usdc'),
    /** The signed x402 payment (its nonce and deadline close the row from the chain). */
    payment: jsonb('payment').$type<Record<string, unknown>>(),
    payTo: text('pay_to'),
    txHash: text('tx_hash'),
    httpStatus: integer('http_status'),
    /** The answer as handed to the model (bounded text), kept for the replay of the same action id. */
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    error: text('error'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('sv_service_calls_agent_created_idx').on(t.agentId, t.createdAt), index('sv_service_calls_agent_status_idx').on(t.agentId, t.status)],
);

/**
 * `post` and `reply` are the agent's publishes under post approval mode; `bounty_job` is a bounty job text waiting for
 * the creator before it is posted (the `review` switch of the bounties policy) and `bounty_payout` the proposal that
 * a job's winner be paid, which the creator settles by hand from their own wallet (bounties.ts; stage A pays nothing).
 * `bounty_pick` is a job whose judge gave no usable ruling in two thoughts: the creator picks the entry to pay from the
 * considered ones (and pays it by hand, like a payout), or declines.
 */
export const approvalKinds = ['post', 'reply', 'bounty_job', 'bounty_payout', 'bounty_pick'] as const;
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

export const scheduledPostStatuses = ['waiting_review', 'waiting', 'sending', 'sent', 'failed', 'missed', 'cancelled'] as const;
export type ScheduledPostStatus = (typeof scheduledPostStatuses)[number];

/**
 * Scheduled posts (scheduled.ts; docs/design/agent-tools-2.md section 5): an original the agent decided with
 * `schedule_post` and the tick sends at `send_at`. `waiting_review` while the creator has it in the review queue
 * (approval mode), `waiting` until its time, `sending` from the moment before the sender is called until its outcome is
 * known, then `sent`, `failed` (refused for good, with the reason), `missed` (not sent within the grace) or `cancelled`
 * (by the agent, the creator, or a rejected review). The rows are the coin's: a switch between the Bootr agent and an
 * own agent changes nothing here.
 */
export const scheduledPosts = pgTable(
  'sv_scheduled_posts',
  {
    /** `sch_` and 16 hex characters from the id of the `schedule_post` action; also the sender's action id of the first part. */
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    /** The `schedule_post` action that made it (`sv_actions.action_id`). */
    actionId: text('action_id').notNull(),
    text: text('text').notNull(),
    /** approvals.ts `textHash` over all parts. */
    textHash: text('text_hash').notNull(),
    /** `[{ text }]`: the parts after the first; null for a single post. */
    thread: jsonb('thread').$type<{ text: string }[] | null>(),
    imageId: text('image_id'),
    topic: text('topic'),
    /** `own` when an own agent's client scheduled it. */
    via: text('via'),
    clientId: text('client_id'),
    sendAt: ts('send_at').notNull(),
    status: text('status', { enum: scheduledPostStatuses }).notNull().default('waiting'),
    error: text('error'),
    postId: text('post_id'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    /** When a failure was told to the agent; null = still to tell. */
    feedbackAt: ts('feedback_at'),
    /** The dataset records the post cites (`schedule_post {record}`, post-records.ts): carried to the send, where the said-ledger and the records are told. */
    recordIds: jsonb('record_ids').$type<string[]>().notNull().default([]),
  },
  (t) => [index('sv_scheduled_posts_due_idx').on(t.status, t.sendAt), index('sv_scheduled_posts_agent_idx').on(t.agentId, t.sendAt)],
);

export const postMetricKinds = ['post', 'reply'] as const;
export type PostMetricKind = (typeof postMetricKinds)[number];

/**
 * One engagement reading per published post, taken once about a day after it went out (post-performance.ts):
 * the sweep in the tick picks the agent's own posts that are 24 to 72 h old and not here yet, reads their counts
 * through the sender, stores them and writes one memory note per batch. `unavailable` marks a post X no longer
 * returned (deleted, hidden): kept so it is not asked for again, never shown to the agent.
 */
export const postMetrics = pgTable(
  'sv_post_metrics',
  {
    /** The X post id. */
    postId: text('post_id').primaryKey(),
    agentId: text('agent_id').notNull(),
    kind: text('kind', { enum: postMetricKinds }).notNull(),
    /** The first characters of the text, for the note and the observation. */
    excerpt: text('excerpt').notNull(),
    postedAt: ts('posted_at').notNull(),
    measuredAt: ts('measured_at').notNull(),
    likes: integer('likes').notNull().default(0),
    replies: integer('replies').notNull().default(0),
    reposts: integer('reposts').notNull().default(0),
    quotes: integer('quotes').notNull().default(0),
    impressions: integer('impressions'),
    unavailable: boolean('unavailable').notNull().default(false),
    /** Read with the other counts since the facts exist (null on older rows and when X did not say). */
    bookmarks: integer('bookmarks'),
    /** Author-only counts, present when X returned them for the agent's own token. Stored, shown to nobody yet. */
    profileClicks: integer('profile_clicks'),
    linkClicks: integer('link_clicks'),
    /** What the post was, from Bootr's own rows at measure time (post-performance.ts `PostFeatures`); null on older rows. */
    features: jsonb('features').$type<PostFeatures>(),
  },
  (t) => [index('sv_post_metrics_agent_posted_idx').on(t.agentId, t.postedAt)],
);

/** What a measured post was (docs/design/agent-tools-2.md section 6.2): the facts are computed over these. */
export interface PostFeatures {
  form: 'post' | 'thread' | 'comment' | 'reply';
  picture: boolean;
  chars: 'short' | 'medium' | 'long';
  /** UTC hour the post went out, 0..23. */
  hour: number;
  /** Sent by the schedule (`sv_actions.action.scheduled`), not by the turn that wrote it. */
  scheduled: boolean;
  /** The agent's own word for what the post was about; absent when it gave none. */
  topic?: string;
}

/**
 * The agent's note on what works for its coin (what-works.ts): one row per version, newest first, the last
 * `WHAT_WORKS_KEEP` kept. `text` is the note as it passed the checks ('' on a row the creator's clear wrote), `facts`
 * the lines of the facts table the agent had in front of it, `action_id` the `note_what_works` action that wrote it,
 * `via` who did: null for the Bootr agent, 'own' for an own agent's client, 'creator' for a clear from the console.
 */
export const whatWorks = pgTable(
  'sv_what_works',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    text: text('text').notNull(),
    facts: jsonb('facts').$type<Record<string, unknown>>().notNull(),
    actionId: text('action_id'),
    via: text('via'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('sv_what_works_agent_created_idx').on(t.agentId, t.createdAt)],
);

/** Small key/value store for pollers (launch event block cursor). */
export const cursors = pgTable('sv_cursors', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const notificationEvents = ['review_waiting', 'review_expiring', 'fuel_low', 'gas_out', 'agent_asleep', 'agent_stopped', 'x_revoked', 'x_forbidden', 'key_rotation', 'model_changed', 'model_unavailable', 'post_silence'] as const;
export type NotificationEvent = (typeof notificationEvents)[number];

/**
 * What the creator is told (notifications.ts). One open row per (agent, event): an event that stays true updates its
 * row, `resolved_at` closes it, and the next time it is true starts a new row. `data` holds only numbers and our own
 * reason codes; the text is built from them when it is shown or sent, never from anything a third party wrote.
 */
export const notifications = pgTable(
  'sv_notifications',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    event: text('event', { enum: notificationEvents }).notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    firstAt: ts('first_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    /** The last Telegram send; carried into a new row when the event comes back, so a flapping event cannot repeat early. */
    lastSentAt: ts('last_sent_at'),
    sendCount: integer('send_count').notNull().default(0),
    /** No send before this (a chat Telegram refused for another reason than a block). */
    nextAttemptAt: ts('next_attempt_at'),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    uniqueIndex('sv_notifications_open_idx').on(t.agentId, t.event).where(sql`${t.resolvedAt} is null`),
    index('sv_notifications_agent_idx').on(t.agentId, t.lastSeenAt),
  ],
);

/** Per-agent notification settings and the sweep's clock. */
export const notificationSettings = pgTable('sv_notification_settings', {
  agentId: text('agent_id').primaryKey(),
  /** Events the creator turned off (`NotificationEvent[]`): shown nowhere and never sent. */
  optOut: jsonb('opt_out').$type<string[]>().notNull().default([]),
  /** When the health sweep last looked at this agent. */
  checkedAt: ts('checked_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** A creator wallet's linked Telegram chat; one wallet, one chat, for all of its coins. */
export const telegramLinks = pgTable(
  'sv_telegram_links',
  {
    /** Lowercase wallet address. */
    creator: text('creator').primaryKey(),
    chatId: text('chat_id').notNull(),
    linkedAt: ts('linked_at').notNull(),
  },
  (t) => [index('sv_telegram_links_chat_idx').on(t.chatId)],
);

/** One-time deep-link tokens; only the sha256 is stored. */
export const telegramLinkTokens = pgTable('sv_telegram_link_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  creator: text('creator').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull(),
});

export const chatRoles = ['creator', 'agent'] as const;
export type ChatRole = (typeof chatRoles)[number];
export const chatStatuses = ['open', 'done', 'failed'] as const;
export type ChatStatus = (typeof chatStatuses)[number];

/**
 * The private chat between a creator and their agent (chat.ts). Never published, never on the activity tape. An agent
 * row is `open` while its paid request is out; the partial unique index keeps it to one per agent at a time.
 */
export const chatMessages = pgTable(
  'sv_chat_messages',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    role: text('role', { enum: chatRoles }).notNull(),
    text: text('text').notNull(),
    status: text('status', { enum: chatStatuses }).notNull().default('done'),
    /** `sv_inference.idempotency_key` of the paid request behind an agent row. */
    inferenceKey: text('inference_key'),
    chargedMicroUsdc: text('charged_micro_usdc'),
    /** The memory note this reply stored, if any. */
    memoryId: text('memory_id'),
    error: text('error'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    index('sv_chat_messages_agent_idx').on(t.agentId, t.createdAt),
    uniqueIndex('sv_chat_messages_open_idx').on(t.agentId).where(sql`${t.status} = 'open'`),
  ],
);

export const bountyJobStatuses = ['draft', 'open', 'judging', 'proposed', 'paid', 'no_winner', 'cancelled', 'expired', 'failed'] as const;
export type BountyJobStatus = (typeof bountyJobStatuses)[number];
export const bountyDeliverables = ['image', 'link'] as const;
export type BountyDeliverable = (typeof bountyDeliverables)[number];

/**
 * Bounty jobs (bounties.ts; docs/design/agent-capabilities.md section 3.3, stage A). One row per job the treasury
 * turn posted: `draft` while it waits for the creator's review or for a posting slot, `open` once the job post is on
 * X, `judging` while the replies are collected and the judge rules (a crash here resumes on the next tick), then
 * `proposed` (a winner waits in the creator's approval queue), `paid` (the creator reported the paying transaction),
 * `no_winner` (nothing met the job, the verdict was refused in code, or the creator declined), `cancelled` (the agent
 * or the creator), `expired` (a proposal nobody acted on in 48 h) or `failed` (the post never went out, or collection
 * failed too often). Reserved jobs (every status but cancelled, expired and failed) count against the day's cap.
 * Amounts are micro-USDC strings. `verdict` is the judge's answer with its hashes; the entries are in `sv_bounty_entries`.
 */
export const bountyJobs = pgTable(
  'sv_bounty_jobs',
  {
    /** `keccak256(kernel, nonce, taskHash)` as the design says; the id the contract of stage B will take. */
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    /** The `bounty_post` action that made the job (`sv_actions.action_id`): the same action never makes two jobs. */
    actionId: text('action_id').notNull(),
    /** The agent's own job counter, part of the id. */
    nonce: integer('nonce').notNull(),
    task: text('task').notNull(),
    criteria: jsonb('criteria').$type<string[]>().notNull(),
    deliverable: text('deliverable', { enum: bountyDeliverables }).notNull(),
    amountMicroUsdc: text('amount_micro_usdc').notNull(),
    status: text('status', { enum: bountyJobStatuses }).notNull().default('draft'),
    /** When the agent decided on the job (the reservation's day). */
    createdAt: ts('created_at').notNull(),
    /** When the job post went out on X (null for a draft that never did). */
    openedAt: ts('opened_at'),
    closesAt: ts('closes_at').notNull(),
    /** A draft waiting for a posting slot or the X quota tries again from here. */
    publishNotBefore: ts('publish_not_before'),
    /** Attempts of the step the status names (posting a draft, collecting the replies); bounded in bounties.ts. */
    attempts: integer('attempts').notNull().default(0),
    /** The job post on X and its conversation (replies in it are entries, not mentions). */
    postId: text('post_id'),
    conversationId: text('conversation_id'),
    /** The job as the coin page shows it (the full template text). */
    pageText: text('page_text').notNull(),
    /**
     * `{winner, perCriterion, reason, invalid?, deliveryHash, reasonHash, judgedAt, thought, thoughts?}`; `thoughts` is
     * every paid thought the job had (two at most). `manualPick: true` while the creator is asked to pick (the judge
     * gave no usable ruling), `pickedBy: 'creator'` once they did, `rejudged: {at, outcome}` on a job the sweep judged
     * a second time after it had closed on a failed ruling.
     */
    verdict: jsonb('verdict').$type<Record<string, unknown> | null>(),
    /**
     * What the judge wrote when code refused its answer as no verdict (`malformed_answer`), cut to 4000 characters per
     * answer, with how each answer ended: kept so the failure can be read. Model output: never logged, never public.
     */
    judgeRaw: text('judge_raw'),
    judgedAt: ts('judged_at'),
    /** The approval row of the job text (review) or of the payout proposal. */
    approvalId: text('approval_id'),
    /** The winning entry's checksummed address, once a verdict names one. */
    payee: text('payee'),
    /** The creator's paying transaction and the template reply under the winning entry, once paid. */
    txHash: text('tx_hash'),
    paidAt: ts('paid_at'),
    paidReplyId: text('paid_reply_id'),
    /** The agent's own post that announces the paid job (a fixed template), and why there is none when it was refused for good. */
    payoutPostId: text('payout_post_id'),
    payoutPostError: text('payout_post_error'),
    /** The template reply that closed the job in public (no winner, cancelled). */
    closeReplyId: text('close_reply_id'),
    entriesReceived: integer('entries_received').notNull().default(0),
    entriesEligible: integer('entries_eligible').notNull().default(0),
    entriesConsidered: integer('entries_considered').notNull().default(0),
    /** When the job reached a closing status (proposed, paid, no_winner, cancelled, expired, failed); `bountyJobClosed` reads it. */
    closedAt: ts('closed_at'),
    error: text('error'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('sv_bounty_jobs_agent_status_idx').on(t.agentId, t.status), index('sv_bounty_jobs_agent_created_idx').on(t.agentId, t.createdAt), uniqueIndex('sv_bounty_jobs_action_idx').on(t.actionId)],
);

/**
 * The replies to a job post as code read them once the window closed (bounties.ts `collectEntries`): one row per
 * reply, with the artefact of the job's kind, the one `0x` address of the text (checksummed) and the eligibility
 * decision. The reply text itself is never stored: the address and the artefact are all a judge or a page needs.
 * `considered` marks the first 12 eligible by time; `n` is the number the judge saw (null otherwise). Public reads
 * (api.ts) never show an author id or an ineligible entry's address.
 */
export const bountyEntries = pgTable(
  'sv_bounty_entries',
  {
    /** `<jobId>:<replyId>`. */
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),
    agentId: text('agent_id').notNull(),
    replyId: text('reply_id').notNull(),
    authorId: text('author_id').notNull(),
    authorCreatedAt: ts('author_created_at'),
    /** The reply's `created_at` on X. */
    receivedAt: ts('received_at').notNull(),
    kind: text('kind', { enum: bountyDeliverables }).notNull(),
    /** `{url, mediaKey, sha256}` for an image, `{url, host}` for a link; null when the reply carried none of the job's kind. */
    artefact: jsonb('artefact').$type<Record<string, unknown> | null>(),
    /** The one `0x` address of the reply text, checksummed; null when none or more than one. */
    payee: text('payee'),
    eligible: boolean('eligible').notNull().default(false),
    /** Why the entry is not eligible (bounties.ts `IneligibleReason`); null when eligible. */
    ineligibleReason: text('ineligible_reason'),
    considered: boolean('considered').notNull().default(false),
    /** The entry number the judge saw (1-based), null when not considered. */
    n: integer('n'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('sv_bounty_entries_job_idx').on(t.jobId), uniqueIndex('sv_bounty_entries_job_reply_idx').on(t.jobId, t.replyId)],
);

export const agentGrantStatuses = ['pending', 'approved', 'redeemed'] as const;
export type AgentGrantStatus = (typeof agentGrantStatuses)[number];

/**
 * Own agents (docs/design/byo-agent.md section 3.3; own/clients.ts): the AI clients a creator connected to a coin's
 * agent. One row per credential; only the SHA-256 of the credential is stored, the credential itself is returned once
 * when its grant is redeemed. `agent_id` is null while the client is bound to a launch draft only (`draft_id`), until
 * registration adopts it. `creator` is the checksummed address of the wallet that approved it, compared with the coin's
 * creator on every call.
 */
export const agentClients = pgTable(
  'sv_agent_clients',
  {
    /** `cli_` and 16 hex characters. */
    id: text('id').primaryKey(),
    agentId: text('agent_id'),
    draftId: text('draft_id'),
    creator: text('creator').notNull(),
    /** sha256 (hex) of the credential. */
    tokenHash: text('token_hash').notNull(),
    label: text('label').notNull(),
    createdAt: ts('created_at').notNull(),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('sv_agent_clients_token_idx').on(t.tokenHash), index('sv_agent_clients_agent_idx').on(t.agentId), index('sv_agent_clients_draft_idx').on(t.draftId)],
);

/**
 * The device-style approval of a client (own/clients.ts): started by the client, approved in the browser by the
 * creator's wallet, redeemed once for a credential. Keyed by the SHA-256 of the device code; the user code is what the
 * creator sees and is no secret. Rows older than a day are deleted whenever a new grant is started.
 */
export const agentGrants = pgTable(
  'sv_agent_grants',
  {
    /** sha256 (hex) of the device code. */
    deviceHash: text('device_hash').primaryKey(),
    userCode: text('user_code').notNull(),
    clientName: text('client_name').notNull(),
    coinHint: text('coin_hint'),
    status: text('status', { enum: agentGrantStatuses }).notNull().default('pending'),
    /** Set at approval, one of the two. */
    agentId: text('agent_id'),
    draftId: text('draft_id'),
    creator: text('creator'),
    label: text('label'),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    approvedAt: ts('approved_at'),
  },
  (t) => [uniqueIndex('sv_agent_grants_user_code_idx').on(t.userCode)],
);

/** What a row of the said-ledger is: a single post or the first post of a thread, a later post of a thread, or a reply. */
export const saidKinds = ['original', 'thread_part', 'reply'] as const;
export type SaidKind = (typeof saidKinds)[number];

/**
 * The said-ledger (said.ts; docs/design/agent-behaviour.md section 6.2): one row per post that reached X, written by
 * code when its publish completes, whichever way it went out (sent at once, approved from the review queue, sent by
 * the scheduler) and whoever thought (a hosted or an own agent). It holds what the post said as code compares it, not
 * its text: the fact fingerprints, the numbers behind them as written, the first three words, and the word set the
 * cross-agent check reads. The repeat gate, the cross-agent gate and the weekly check read it. Rows older than
 * `SAID_KEEP_DAYS` are deleted.
 */
export const said = pgTable(
  'sv_said',
  {
    /** The `sv_actions` row of the publish for a single post, a reply or the first post of a thread; `<that id>.t<n>` for post n of a thread. */
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    /** The `sv_actions` row the post is recorded under; all posts of a thread share it. */
    actionId: text('action_id').notNull(),
    /** The post on X; null when the sender did not say. */
    postId: text('post_id'),
    kind: text('kind', { enum: saidKinds }).notNull(),
    postedAt: ts('posted_at').notNull(),
    /** agent-core `factFingerprints` of the post's text. */
    fingerprints: jsonb('fingerprints').$type<string[]>().notNull().default([]),
    /** agent-core `postFacts`: every number with its subject, its unit and the value as written (`s`, `u`, `v`). */
    facts: jsonb('facts').$type<{ s: string; u: string; v: number }[]>().notNull().default([]),
    /** agent-core `openerOf`: the first three words. */
    opener: text('opener').notNull().default(''),
    /** The post's words without the common ones, sorted (said.ts `wordSet`): what another agent's post is compared with. */
    words: jsonb('words').$type<string[]>().notNull().default([]),
    /** The dataset records the post cited; empty until records exist. */
    recordIds: jsonb('record_ids').$type<string[]>().notNull().default([]),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sv_said_agent_posted_idx').on(t.agentId, t.postedAt), index('sv_said_posted_idx').on(t.postedAt)],
);

/**
 * What a publish gate found (gate-shadow.ts; docs/design/agent-behaviour.md section 6.3 and measure M10): one row per
 * post a gate refused (`enforced`) or, in shadow, would have refused. `gate` is the gate's id in the design note
 * (`G1` repeat, `G3` fee claims, `G4` cross-agent, `G6` units), `code` the head of its refusal, `action_id` the
 * `sv_actions` row of the publish, `text_hash` approvals.ts `textHash` of the post, `detail` what the gate matched.
 * The same post found twice by the same gate (at scheduling and again at the send, or a repeated call) is one row.
 */
export const gateShadow = pgTable(
  'sv_gate_shadow',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    gate: text('gate').notNull(),
    code: text('code').notNull(),
    actionId: text('action_id'),
    textHash: text('text_hash').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    enforced: boolean('enforced').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sv_gate_shadow_agent_created_idx').on(t.agentId, t.createdAt), index('sv_gate_shadow_gate_created_idx').on(t.gate, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Bootr's own dataset (src/dataset/, docs/design/agent-behaviour.md section 6.4). Written by the dataset process alone,
// except `sv_ds_records.posted`, which the publish path appends to in a later stage.
// ---------------------------------------------------------------------------

/**
 * What the dataset reads, one row per source: the open sources of `dataset/sources.ts` (synced from the file at start,
 * `retired` when a commit removed one), Bootr's own index, and later X accounts. An X account is held by `x_user_id`,
 * never by its handle: a handle can be renamed or taken by a stranger, the id cannot (`x_handle` is only what the id
 * was last seen as). The fetch columns are the conditional GET's memory and the back-off of a source that fails.
 */
export const dsSources = pgTable(
  'sv_ds_sources',
  {
    /** `b:<slug>` for an open source, `a:<name>` for Bootr's own data, `x:<user id>` for an X account (`x:@<handle>` until its id is pinned). */
    id: text('id').primaryKey(),
    layer: text('layer').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    url: text('url'),
    cluster: text('cluster').notNull(),
    /** The organisation that counts once for independence. */
    groupId: text('group_id').notNull(),
    /** Entity ids this source may lift a record to grade 4 for. */
    officialFor: jsonb('official_for').$type<string[]>().notNull().default([]),
    xUserId: text('x_user_id'),
    xHandle: text('x_handle'),
    /** Read tier of an X account (1 = from day one); null for other sources. */
    tier: integer('tier'),
    /**
     * `active`, `suspended` (a person must look: a renamed handle, collapsed followers) or `retired` (left the list);
     * for an X account also `pending` (listed, its id not pinned yet) and `review` (the owner asked for another look).
     */
    status: text('status').notNull().default('active'),
    statusReason: text('status_reason'),
    etag: text('etag'),
    lastModified: text('last_modified'),
    contentHash: text('content_hash'),
    /** What the reader keeps between reads (an HTML page's known links, later an X `since_id`). */
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
    lastFetchAt: ts('last_fetch_at'),
    lastOkAt: ts('last_ok_at'),
    nextFetchAt: ts('next_fetch_at'),
    lastStatus: integer('last_status'),
    failures: integer('failures').notNull().default(0),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('sv_ds_sources_x_user_idx').on(t.xUserId), index('sv_ds_sources_due_idx').on(t.layer, t.status, t.nextFetchAt)],
);

/**
 * One event, one record, however many sources carried it (`dataset/types.ts`). `first_seen_at`, `last_reinforced_at`
 * and `observation_count` are about Bootr's sightings; `event_time` is when it happened or will happen and is never
 * mixed with them. `grade` describes sourcing, not truth (`dataset/grades.ts`). Every text column was built by code from
 * bounded, cleaned fields (`dataset/clean.ts`).
 */
export const dsRecords = pgTable(
  'sv_ds_records',
  {
    /** `r_` and 12 hex characters. */
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    entities: jsonb('entities').$type<string[]>().notNull().default([]),
    cluster: text('cluster').notNull(),
    weight: integer('weight').notNull().default(1),
    /** The coin a chain record is about (lowercase address); null for everything else. */
    coin: text('coin'),
    headline: text('headline').notNull(),
    summary: text('summary'),
    link: text('link'),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastReinforcedAt: ts('last_reinforced_at').notNull(),
    observationCount: integer('observation_count').notNull().default(1),
    eventTime: ts('event_time'),
    eventEnd: ts('event_end'),
    eventPrecision: text('event_precision').notNull().default('unknown'),
    /** `[{sourceId, cluster, group, official, link, seenAt}]`, one entry per source. */
    sources: jsonb('sources').$type<Record<string, unknown>[]>().notNull().default([]),
    groups: integer('groups').notNull().default(1),
    grade: integer('grade').notNull().default(1),
    /** A sighting pointed at a page of another listed source. */
    cited: boolean('cited').notNull().default(false),
    /** `[{value, unit, what, asOf, sourceId}]`: the only numbers an agent may state from the record. */
    numbers: jsonb('numbers').$type<Record<string, unknown>[]>().notNull().default([]),
    status: text('status').notNull().default('open'),
    changedAt: ts('changed_at'),
    changes: jsonb('changes').$type<Record<string, unknown>[]>().notNull().default([]),
    /** `[{agentId, postId, at}]`: who already posted about it. Appended by the publish path in a later stage. */
    posted: jsonb('posted').$type<Record<string, unknown>[]>().notNull().default([]),
    expiresAt: ts('expires_at').notNull(),
    /** The UTC day it was first seen, `YYYY-MM-DD`: the day's view and the day's cap count by it. */
    day: text('day').notNull(),
  },
  (t) => [index('sv_ds_records_day_idx').on(t.day, t.grade), index('sv_ds_records_reinforced_idx').on(t.lastReinforcedAt), index('sv_ds_records_coin_idx').on(t.coin)],
);

/**
 * One thing one source showed once: the raw material of a record, deleted after 30 days while the record's skeleton
 * stays. `link_key` and `key` are what matching step 1 looks up; `refs` what step 2 does.
 */
export const dsSightings = pgTable(
  'sv_ds_sightings',
  {
    /** sha256 of the source id and the source's own id for the item: the same item read twice is one row. */
    id: text('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    recordId: text('record_id').notNull(),
    externalId: text('external_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    excerpt: text('excerpt'),
    /** The text read like an instruction and was not kept, or, for an X post, was let go again (`dataset/x-text.ts`). */
    withheld: boolean('withheld').notNull().default(false),
    link: text('link'),
    linkKey: text('link_key'),
    key: text('key'),
    refs: jsonb('refs').$type<string[]>().notNull().default([]),
    /** How it found its record: `new`, `key`, `link`, `relation`, `words`, or `judge` (step 4, a later stage). */
    matchedBy: text('matched_by').notNull(),
    publishedAt: ts('published_at'),
    seenAt: ts('seen_at').notNull(),
    /**
     * For a sighting of an X post whose words are kept (`title`): when X last confirmed the post is still there
     * (`dataset/x-text.ts`). Null for every other sighting.
     */
    checkedAt: ts('checked_at'),
  },
  (t) => [index('sv_ds_sightings_record_idx').on(t.recordId), index('sv_ds_sightings_link_idx').on(t.linkKey), index('sv_ds_sightings_key_idx').on(t.key), index('sv_ds_sightings_seen_idx').on(t.seenAt)],
);

/**
 * Which records of the dataset an agent was handed (dataset/served.ts; docs/design/agent-behaviour.md stage 5): one row
 * per agent and record, written by the supervisor when a turn's first observation carries the record, never by the
 * dataset process. It answers four questions without touching `sv_ds_records`: whether an id a post cites is one this
 * agent was really shown (an id from anywhere else is not a citation), whether the agent already used the record
 * (`cited_at`: a post that cites it went out, was scheduled or waits for review), how often it was offered with a due
 * slot and passed over (`offered`: after a few it is not offered again), and whether the dataset handed this agent
 * anything in the last day (the condition of the platform account's quiet slot). Rows go 30 days after their last use.
 */
export const recordsServed = pgTable(
  'sv_records_served',
  {
    /** `<agent id>:<record id>`: one row per pair. */
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    recordId: text('record_id').notNull(),
    firstServedAt: ts('first_served_at').notNull(),
    lastServedAt: ts('last_served_at').notNull(),
    /** Turns whose first observation carried the record. */
    times: integer('times').notNull().default(1),
    /** Of those, the turns that held a due original-post slot: the agent could have posted about it and did not. */
    offered: integer('offered').notNull().default(0),
    /** When a post of this agent that cites the record went out, was scheduled or was queued for review; null until then. */
    citedAt: ts('cited_at'),
    /** The post that cited it: the id of its publish action, of its scheduled row or of its review item. The same post asked again is not a repeat. */
    citedBy: text('cited_by'),
  },
  (t) => [index('sv_records_served_agent_idx').on(t.agentId, t.lastServedAt)],
);
