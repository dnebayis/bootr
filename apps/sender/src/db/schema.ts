import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * All tables are prefixed `sender_` because the sender may share a Postgres database with
 * other Bootr services. Only the sender reads or writes these tables.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** One connected X account per agent. Tokens are AES-256-GCM encrypted (see src/crypto.ts). */
export const accounts = pgTable('sender_accounts', {
  agentId: text('agent_id').primaryKey(),
  xUserId: text('x_user_id').notNull(),
  xHandle: text('x_handle').notNull(),
  encryptedAccessToken: text('encrypted_access_token').notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token'),
  scopes: text('scopes').notNull(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  connectedAt: ts('connected_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const actionKinds = ['post', 'reply'] as const;
export const actionStatuses = ['pending', 'sent', 'held', 'rejected'] as const;
export type ActionKind = (typeof actionKinds)[number];
export type ActionStatus = (typeof actionStatuses)[number];

/**
 * One row per supervisor-issued `actionId`. The row (with bodyHash and attempts) is written
 * BEFORE X is contacted, so a crash can never lead to a blind resend.
 */
export const actions = pgTable(
  'sender_actions',
  {
    actionId: text('action_id').primaryKey(),
    agentId: text('agent_id').notNull(),
    kind: text('kind', { enum: actionKinds }).notNull(),
    text: text('text').notNull(),
    replyTo: text('reply_to'),
    replyAuthorId: text('reply_author_id'),
    /** X user id of the account the action was (or would have been) posted from (L-4). */
    xUserId: text('x_user_id'),
    bodyHash: text('body_hash').notNull(),
    status: text('status', { enum: actionStatuses }).notNull(),
    providerPostId: text('provider_post_id'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
    lastCheckedAt: ts('last_checked_at'),
    /** Reconciliation bookkeeping for `held` rows. */
    checks: integer('checks').notNull().default(0),
    nextCheckAt: ts('next_check_at'),
  },
  (t) => [
    index('sender_actions_agent_created_idx').on(t.agentId, t.createdAt),
    index('sender_actions_status_next_check_idx').on(t.status, t.nextCheckAt),
    uniqueIndex('sender_actions_provider_post_idx').on(t.providerPostId),
  ],
);

/** Read metering for charge-back. Counts only: one row per (agent, kind, UTC day). */
export const reads = pgTable(
  'sender_reads',
  {
    agentId: text('agent_id').notNull(),
    kind: text('kind').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.kind, t.day] })],
);

export const inboxStatuses = [
  'pending',
  'skipped',
  'answered',
  'retrying',
  'delivery_blocked',
] as const;
export type InboxStatus = (typeof inboxStatuses)[number];

/** Mentions observed for an agent. Keyed by (agentId, postId): one post can mention many agents. */
export const inbox = pgTable(
  'sender_inbox',
  {
    agentId: text('agent_id').notNull(),
    postId: text('post_id').notNull(),
    authorId: text('author_id').notNull(),
    conversationId: text('conversation_id'),
    post: jsonb('post').notNull(),
    observedAt: ts('observed_at').notNull().defaultNow(),
    status: text('status', { enum: inboxStatuses }).notNull().default('pending'),
    reason: text('reason'),
    deferredUntil: ts('deferred_until'),
    seenAt: ts('seen_at'),
    replyId: text('reply_id'),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.postId] }),
    index('sender_inbox_agent_status_idx').on(t.agentId, t.status),
  ],
);

/** Consent state per (agent, author). `enabled = true` means the author opted out. */
export const optouts = pgTable(
  'sender_optouts',
  {
    agentId: text('agent_id').notNull(),
    authorId: text('author_id').notNull(),
    enabled: boolean('enabled').notNull(),
    postId: text('post_id'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.authorId] })],
);

/** Per-agent rate budget plus mention-read cursor. Missing row = defaults from config. */
export const quotas = pgTable('sender_quotas', {
  agentId: text('agent_id').primaryKey(),
  postsPerDay: integer('posts_per_day'),
  mentionReadIntervalSec: integer('mention_read_interval_sec'),
  lastMentionsReadAt: ts('last_mentions_read_at'),
  mentionsSinceId: text('mentions_since_id'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * Consumed OAuth `state` nonces. A state is single-use: `/oauth/callback` inserts its nonce before
 * exchanging the code and refuses a nonce that is already present. Rows are purged after `expiresAt`
 * (the state itself is rejected by then).
 */
export const oauthStates = pgTable(
  'sender_oauth_states',
  {
    nonce: text('nonce').primaryKey(),
    agentId: text('agent_id').notNull(),
    usedAt: ts('used_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('sender_oauth_states_expires_idx').on(t.expiresAt)],
);

export type AccountRow = typeof accounts.$inferSelect;
export type ActionRow = typeof actions.$inferSelect;
export type InboxRow = typeof inbox.$inferSelect;
