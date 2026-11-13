import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitive formats
// ---------------------------------------------------------------------------

export const evmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte address');
export const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte transaction hash');
/** X (Twitter) snowflake ids are decimal strings up to 19 digits. */
export const xIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/, 'expected an X id');
export const xHandleSchema = z.string().regex(/^[a-zA-Z0-9_]{1,15}$/, 'expected an X handle without @');
export const isoDateSchema = z.string().refine((v) => Number.isFinite(Date.parse(v)), 'expected an ISO date');
export const httpsUrlSchema = z
  .string()
  .max(2000)
  .refine((v) => {
    try {
      const url = new URL(v);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'expected a public https url');

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export const ownerRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  text: z.string().trim().min(1).max(4000),
  enabled: z.boolean(),
});
export type OwnerRule = z.infer<typeof ownerRuleSchema>;

export const CAPABILITIES = ['xRead', 'xReply', 'xPublish', 'research', 'memory', 'treasury', 'images', 'services', 'bounties'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const capabilitiesSchema = z.object({
  xRead: z.boolean().default(false),
  xReply: z.boolean().default(false),
  xPublish: z.boolean().default(false),
  research: z.boolean().default(false),
  memory: z.boolean().default(false),
  treasury: z.boolean().default(false),
  images: z.boolean().default(false),
  /** Paid services: `discover_services` and `x402_fetch` (pays any x402 endpoint from the agent's own float, under `services`). */
  services: z.boolean().default(false),
  /**
   * Bounties: `bounty_post`, `bounty_cancel` (the treasury turn) and `bounty_list` (both turns); the agent posts a
   * small job in public, code collects the entries and the judge rules (apps/supervisor/src/bounties.ts; bounds under
   * `bounties`). Stage A: the verdict is a proposal the creator pays by hand; nothing on chain.
   */
  bounties: z.boolean().default(false),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/**
 * The money bounds of the `services` power (apps/supervisor/src/services.ts enforces them; the creator sets them in
 * the console). Amounts are micro-USDC (6 dp). `allow` and `deny` are host patterns: a hostname, or `*.example.com`
 * for a host and every subdomain; an empty `allow` list means any public https host not in `deny`. The ceilings here
 * are hard: the console cannot set more, so the worst case of a day on this power is `dailyMicroUsdc` whatever the
 * model or a leaked spender key does, and never more than the float the treasury funds (50 USDC per day).
 */
export const SERVICES_PER_CALL_MAX_MICRO_USDC = 5_000_000;
export const SERVICES_DAILY_MAX_MICRO_USDC = 50_000_000;
export const SERVICES_DEFAULT_PER_CALL_MICRO_USDC = 50_000;
export const SERVICES_DEFAULT_DAILY_MICRO_USDC = 1_000_000;
export const hostPatternSchema = z.string().max(253).regex(/^(\*\.)?[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/i, 'expected a hostname or *.example.com');
export const servicesPolicySchema = z.object({
  perCallMicroUsdc: z.number().int().min(1).max(SERVICES_PER_CALL_MAX_MICRO_USDC).default(SERVICES_DEFAULT_PER_CALL_MICRO_USDC),
  dailyMicroUsdc: z.number().int().min(1).max(SERVICES_DAILY_MAX_MICRO_USDC).default(SERVICES_DEFAULT_DAILY_MICRO_USDC),
  allow: z.array(hostPatternSchema).max(64).default([]),
  deny: z.array(hostPatternSchema).max(64).default([]),
});
export type ServicesPolicy = z.infer<typeof servicesPolicySchema>;
export const DEFAULT_SERVICES_POLICY: ServicesPolicy = servicesPolicySchema.parse({});

/** Whether `host` matches a pattern: exact (case-insensitive) or `*.example.com` for the host itself and its subdomains. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  return h === p;
}

/** `deny` wins; then an empty `allow` list allows every host, a non-empty one only what it names. */
export function servicesHostAllowed(policy: Pick<ServicesPolicy, 'allow' | 'deny'>, host: string): boolean {
  if (policy.deny.some((p) => hostMatches(host, p))) return false;
  if (policy.allow.length === 0) return true;
  return policy.allow.some((p) => hostMatches(host, p));
}

/**
 * The bounds of the `bounties` power (docs/design/agent-capabilities.md section 3.3; apps/supervisor/src/bounties.ts
 * enforces them, the creator sets the policy in the console). Amounts are micro-USDC (6 dp). The ceilings are hard:
 * the console cannot set more, and a job's amount, the day's reservations and the open jobs are checked in code before
 * anything is posted. Stage A pays nothing itself; the creator pays a proposed verdict by hand.
 */
export const BOUNTY_MIN_AMOUNT_MICRO_USDC = 100_000;
export const BOUNTY_MAX_AMOUNT_MICRO_USDC = 1_000_000;
export const BOUNTY_DAILY_MAX_MICRO_USDC = 20_000_000;
export const BOUNTY_DEFAULT_DAILY_MICRO_USDC = 5_000_000;
export const BOUNTY_MAX_OPEN_CEILING = 5;
export const BOUNTY_DEFAULT_MAX_OPEN = 2;
export const BOUNTY_DEFAULT_COOLDOWN_SECONDS = 7 * 24 * 3600;
export const BOUNTY_MAX_COOLDOWN_SECONDS = 365 * 24 * 3600;
export const BOUNTY_MIN_HOURS_OPEN = 1;
export const BOUNTY_MAX_HOURS_OPEN = 72;
export const BOUNTY_DEFAULT_HOURS_OPEN = 6;
/** Entries the judge sees at most (the first eligible ones by time). */
export const BOUNTY_MAX_CONSIDERED = 12;
/** A proposed verdict the creator does not act on within this long expires unpaid. */
export const BOUNTY_PAY_GRACE_MS = 48 * 3_600_000;
export const BOUNTY_MAX_CRITERIA = 4;
export const BOUNTY_MAX_TASK_CHARS = 300;
export const BOUNTY_MAX_CRITERION_CHARS = 300;
/** Words a job text may not carry: a job asks for work, never for promotion (decision 15 of section 9). */
export const BOUNTY_FORBIDDEN_WORDS: readonly string[] = ['buy', 'post', 'tweet', 'promote', 'shill', 'follow', 'like', 'retweet'];

export const bountiesPolicySchema = z.object({
  dailyCapMicroUsdc: z.number().int().min(0).max(BOUNTY_DAILY_MAX_MICRO_USDC).default(BOUNTY_DEFAULT_DAILY_MICRO_USDC),
  maxOpen: z.number().int().min(0).max(BOUNTY_MAX_OPEN_CEILING).default(BOUNTY_DEFAULT_MAX_OPEN),
  /** How long a paid address waits before it may win again; 0 allows repeats. */
  cooldownSeconds: z.number().int().min(0).max(BOUNTY_MAX_COOLDOWN_SECONDS).default(BOUNTY_DEFAULT_COOLDOWN_SECONDS),
  defaultHoursOpen: z.number().int().min(BOUNTY_MIN_HOURS_OPEN).max(BOUNTY_MAX_HOURS_OPEN).default(BOUNTY_DEFAULT_HOURS_OPEN),
  /** Decision 16: every job text goes through the creator's approval queue before it is posted. */
  review: z.boolean().default(false),
});
export type BountiesPolicy = z.infer<typeof bountiesPolicySchema>;
export const DEFAULT_BOUNTIES_POLICY: BountiesPolicy = bountiesPolicySchema.parse({});

/**
 * Economy mode: a turn starts on a cheaper `decideModel` (reading, deciding, memory and treasury work) and switches
 * to `model` (the writer) only once the decide model calls `draft_intent`. `decideModel` null = off, the whole turn
 * runs on `model`. A decide model equal to `model` is accepted and behaves as off.
 */
export const routingSchema = z.object({ decideModel: z.string().min(1).max(128).nullable() });
export type Routing = z.infer<typeof routingSchema>;

export const DEFAULT_POST_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_DORMANCY_PERIOD_MS = 90 * 24 * 60 * 60 * 1000;

/** Free-text style notes the creator can attach to the agent's pictures ("flat colours, no text"). */
export const MAX_IMAGE_STYLE_NOTES_CHARS = 200;

/**
 * How the agent's pictures should look: `reference` is a public https picture the image model sees next to every
 * prompt and matches in style and palette (by default the coin's own image, read from the agent card at onboarding;
 * null = none), `notes` are the creator's words on top.
 */
export const imageStyleSchema = z.object({
  reference: httpsUrlSchema.nullable().default(null),
  notes: z.string().trim().max(MAX_IMAGE_STYLE_NOTES_CHARS).default(''),
});
export type ImageStyle = z.infer<typeof imageStyleSchema>;

/** Who gets a reply (`agentConfigSchema.replyAudience`). */
export const REPLY_AUDIENCES = ['verified', 'own_threads'] as const;
export type ReplyAudience = (typeof REPLY_AUDIENCES)[number];
/** The most X accounts a creator may ask a coin's agent to follow (`agentConfigSchema.watchlist`). */
export const MAX_WATCHLIST_HANDLES = 5;

export const agentConfigSchema = z
  .object({
    agentId: z.string().min(1).max(128),
    token: z.object({
      address: evmAddressSchema,
      symbol: z.string().min(1).max(32),
      name: z.string().min(1).max(128),
      chainId: z.union([z.literal(8453), z.literal(84532)]),
    }),
    kernel: z.object({ address: evmAddressSchema }),
    creator: z.object({ address: evmAddressSchema, xHandle: xHandleSchema.optional(), xUserId: xIdSchema.optional() }),
    xHandle: xHandleSchema,
    xUserId: xIdSchema,
    model: z.string().min(1).max(128),
    /** Image generation model (relay id) for `generate_image`; unset = the supervisor's default. */
    imageModel: z.string().min(1).max(128).optional(),
    /**
     * The model the judge role rules with (apps/supervisor/src/judge.ts); unset = `model`. Design decision 10: the
     * judge runs on the agent's own model and the console may pin a cheaper one.
     */
    judgeModel: z.string().min(1).max(128).optional(),
    /**
     * Runs the treasury turn (apps/supervisor/src/roles.ts) for this agent although no power needs it yet: the owner's
     * trial switch before Bounties exists. The turn is on anyway when the `trade` or `bounties` power is on; absent or
     * false means the powers alone decide.
     */
    treasuryTurn: z.boolean().optional(),
    /** Economy mode (see `routingSchema`); absent = off. */
    routing: routingSchema.optional(),
    /** Reference picture and notes every `generate_image` prompt carries; unset = no reference, no notes. */
    imageStyle: imageStyleSchema.optional(),
    identityText: z.string().max(20000),
    /** True for the platform's own account (the launchpad's voice), false for a coin's agent. */
    platform: z.boolean().default(false),
    ownerRules: z.array(ownerRuleSchema).max(64).default([]),
    capabilities: capabilitiesSchema.default({}),
    /** Bounds of the `services` power; absent = `DEFAULT_SERVICES_POLICY` (the power itself is `capabilities.services`). */
    services: servicesPolicySchema.optional(),
    /** Bounds of the `bounties` power; absent = `DEFAULT_BOUNTIES_POLICY` (the power itself is `capabilities.bounties`). */
    bounties: bountiesPolicySchema.optional(),
    /** Minimum spacing between original posts. */
    postIntervalMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1000).default(DEFAULT_POST_INTERVAL_MS),
    /**
     * The creator's daily budget of posts and replies (the sender's rolling 24 h quota, `@bootr/shared/workers`
     * POSTS_PER_DAY); `postIntervalMs` is derived from it when the creator sets it. Absent = the sender's default.
     */
    postsPerDay: z.number().int().min(1).max(2400).optional(),
    /** How long without any activity before the agent is considered dormant. */
    dormancyPeriodMs: z.number().int().min(60_000).default(DEFAULT_DORMANCY_PERIOD_MS),
    /** When the social loop started; original-post scheduling anchors here. */
    socialStartedAt: isoDateSchema.optional(),
    /** Stable X author ids allowed to receive replies without a verified badge. */
    replyAuthorIds: z.array(xIdSchema).max(16).default([]),
    /** Stable X author ids the owner never wants answered. */
    blockedAuthorIds: z.array(xIdSchema).max(64).default([]),
    /**
     * Whether the agent may comment on a post it read, as a post of its own (`publish_post` with `about`;
     * docs/design/agent-tools-2.md section 4). Absent = on; the creator switches it off in the console.
     */
    comments: z.boolean().optional(),
    /**
     * Who gets a reply: `verified` (verified accounts, the creator's list and other Bootr agents, as before the field
     * existed) or `own_threads`, which also answers anyone who replies directly under one of the agent's own posts.
     * Absent = the deployment's default (`REPLY_AUDIENCE_DEFAULT`).
     */
    replyAudience: z.enum(REPLY_AUDIENCES).optional(),
    /**
     * X accounts the creator asked the agent to follow: handles without the `@`, lower-case, at most
     * `MAX_WATCHLIST_HANDLES`. Their latest posts reach the agent as the `watchlist` observation section
     * (apps/supervisor/src/watchlist.ts). Absent or empty = none.
     */
    watchlist: z.array(z.string().regex(/^[a-z0-9_]{1,15}$/, 'expected a lower-case X handle without @')).max(MAX_WATCHLIST_HANDLES).optional(),
    /** Bumped by the control plane whenever anything above changes. */
    revision: z.number().int().min(0).default(0),
  })
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    for (const rule of config.ownerRules) {
      if (ids.has(rule.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate owner rule id ${rule.id}`, path: ['ownerRules'] });
      ids.add(rule.id);
    }
    if (new Set(config.replyAuthorIds).size !== config.replyAuthorIds.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate reply author id', path: ['replyAuthorIds'] });
  });
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentConfigInput = z.input<typeof agentConfigSchema>;

export function parseAgentConfig(value: unknown): AgentConfig {
  return agentConfigSchema.parse(value);
}

// ---------------------------------------------------------------------------
// X posts as the brain sees them (already normalised by the X adapter)
// ---------------------------------------------------------------------------

export const xAuthorSchema = z.object({
  id: xIdSchema,
  username: xHandleSchema.optional(),
  verified: z.boolean().optional(),
  verifiedType: z.enum(['blue', 'business', 'government', 'none']).optional(),
});
export type XAuthor = z.infer<typeof xAuthorSchema>;

export const xPostSchema = z.object({
  id: xIdSchema,
  text: z.string(),
  authorId: xIdSchema,
  createdAt: isoDateSchema.optional(),
  conversationId: xIdSchema.optional(),
  inReplyToUserId: xIdSchema.nullable().optional(),
  referencedPosts: z.array(z.object({ type: z.enum(['replied_to', 'quoted', 'retweeted']), id: xIdSchema })).optional(),
  mentions: z.array(z.object({ username: xHandleSchema, id: xIdSchema.optional() })).optional(),
  urls: z.array(z.object({ url: z.string(), expandedUrl: z.string() })).optional(),
  mediaKeys: z.array(z.string()).optional(),
  author: xAuthorSchema.optional(),
});
export type XPost = z.infer<typeof xPostSchema>;

export const attributionSchema = z.object({
  username: xHandleSchema,
  sourceUrl: httpsUrlSchema,
});
export type Attribution = z.infer<typeof attributionSchema>;

export const INBOX_STATUSES = ['pending', 'skipped', 'answered', 'retrying', 'delivery_blocked'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export interface InboxEntry {
  postId: string;
  authorId: string;
  conversationId: string;
  status: InboxStatus;
  reason?: string | null;
  /** Epoch ms when the entry was last shown to the model. */
  seenAt?: number | null;
  /** Epoch ms before which the entry must not be presented again. */
  deferredUntil?: number | null;
  observedAt: number;
  post: XPost;
}

// ---------------------------------------------------------------------------
// Tool inputs (one zod schema per tool; the catalog lives in tools.ts)
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max);

/** Most ids one `resolve_mentions` call takes. */
export const MAX_RESOLVE_BATCH = 20;
/** The most characters the note of `note_what_works` holds. */
export const WHAT_WORKS_NOTE_MAX_CHARS = 600;

export const toolInputSchemas = {
  read_mentions: z.object({}).strict(),
  read_x_thread: z.object({ postId: xIdSchema }).strict(),
  read_x_account: z
    .object({
      username: xHandleSchema,
      originalsOnly: z.boolean().optional(),
      paginationToken: z.string().max(2000).optional(),
    })
    .strict(),
  recall_conversation: z
    .object({ authorId: xIdSchema, query: z.string().max(200).optional(), beforePostId: xIdSchema.optional() })
    .strict(),
  publish_reply: z
    .object({
      postId: xIdSchema,
      text: text(280),
      attributions: z.array(attributionSchema).max(3).optional(),
      imageId: z.string().max(128).optional(),
    })
    .strict(),
  resolve_mention: z
    .object({
      postId: xIdSchema,
      outcome: z.enum(['skip', 'opt_out', 'defer']),
      reason: text(1000),
      reviewAt: isoDateSchema.optional(),
    })
    .strict(),
  // One reason for the whole list, at most what the sender stores for a mention (apps/sender/src/inbox.ts).
  resolve_mentions: z
    .object({
      postIds: z.array(xIdSchema).min(1).max(MAX_RESOLVE_BATCH),
      outcome: z.enum(['skip', 'opt_out', 'defer']),
      reason: text(500),
      reviewAt: isoDateSchema.optional(),
    })
    .strict(),
  publish_post: z
    .object({
      text: text(4000),
      /** More posts connected under this one, in order: a thread. With it, `text` is the first part and is 280 at most. */
      thread: z.array(z.object({ text: text(280) }).strict()).min(1).max(3).optional(),
      attributions: z.array(attributionSchema).max(3).optional(),
      imageId: z.string().max(128).optional(),
      /** The post this one comments on: a post the agent read in this turn (apps/supervisor/src/comment-posts.ts). */
      about: z.object({ postId: xIdSchema }).strict().optional(),
      /** The agent's own word for what the post is about; code only keeps it. */
      topic: z.string().regex(/^[a-z0-9-]{1,24}$/).optional(),
    })
    .strict(),
  remember: z
    .object({
      text: text(8000),
      sources: z.array(httpsUrlSchema).max(8).optional(),
      tags: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(8).optional(),
    })
    .strict(),
  recall: z
    .object({ query: z.string().max(200).optional(), id: z.string().max(128).optional(), offset: z.number().int().min(0).optional() })
    .strict(),
  // The agent's one note on what works for its coin (apps/supervisor/src/what-works.ts): replaced, never added to.
  note_what_works: z.object({ text: text(WHAT_WORKS_NOTE_MAX_CHARS) }).strict(),
  finish: z
    .object({
      memory: z.string().max(16000),
      agenda: z.string().max(12000),
      summary: z.string().max(4000),
      nextAt: isoDateSchema,
    })
    .strict(),
  // A post decided now and sent later by the supervisor's clock. It names nobody: no credits, and an `@` in it is refused.
  schedule_post: z
    .object({
      text: text(4000),
      /** More posts connected under this one, in order: a thread. With it, `text` is the first part and is 280 at most. */
      thread: z.array(z.object({ text: text(280) }).strict()).min(1).max(3).optional(),
      imageId: z.string().max(128).optional(),
      /** The agent's own word for what the post is about. */
      topic: z.string().regex(/^[a-z0-9-]{1,24}$/).optional(),
      sendAt: isoDateSchema,
    })
    .strict(),
  scheduled_list: z.object({}).strict(),
  scheduled_cancel: z.object({ id: z.string().regex(/^sch_[0-9a-f]{16}$/) }).strict(),
  read_url: z.object({ url: httpsUrlSchema, render: z.boolean().optional() }).strict(),
  search_web: z.object({ query: text(400) }).strict(),
  read_market: z.object({ tokenAddress: evmAddressSchema.optional(), pairId: z.string().max(80).optional() }).strict(),
  read_coin: z.object({ symbolOrAddress: text(64) }).strict(),
  read_chain: z
    .object({
      method: z.enum(['balance', 'contract_call', 'transaction', 'block']),
      address: evmAddressSchema.optional(),
      signature: z.string().max(400).optional(),
      args: z.array(z.union([z.string(), z.number(), z.boolean()])).max(16).optional(),
      txHash: txHashSchema.optional(),
      blockNumber: z.number().int().min(0).optional(),
    })
    .strict(),
  treasury_read: z.object({}).strict(),
  treasury_prepare: z
    .object({
      operation: z.enum(['transfer', 'swap', 'burn', 'buyback']),
      asset: z.union([z.literal('ETH'), evmAddressSchema]).optional(),
      amount: z.string().regex(/^\d+(\.\d+)?$/, 'decimal amount as string'),
      to: evmAddressSchema.optional(),
      maxSlippageBps: z.number().int().min(0).max(5000).optional(),
      memo: z.string().max(280).optional(),
    })
    .strict(),
  treasury_execute: z
    .object({
      preparedId: z.string().min(1).max(128),
      /** Hash of the prepared call data the model observed; the executor refuses mismatches. */
      expectedHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    })
    .strict(),
  generate_image: z.object({ prompt: text(2000), altText: text(1000) }).strict(),
  discover_services: z
    .object({
      query: text(200),
      /** Only services priced at or under this, in micro-USDC; default: your per-call cap. */
      maxPriceMicroUsdc: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  x402_fetch: z
    .object({
      url: httpsUrlSchema,
      method: z.enum(['GET', 'POST']).optional(),
      /** JSON body of a POST (an object), or query parameters of a GET (string values). */
      body: z.record(z.unknown()).optional(),
      /** The most you will pay for this call, in micro-USDC; never above your per-call cap. */
      maxPriceMicroUsdc: z.number().int().min(1).optional(),
      /** Why you need it, in plain words: it goes on the public ledger next to the amount. */
      reason: text(200),
    })
    .strict(),
  bounty_post: z
    .object({
      /** What you want made, in plain words; it is published as is inside a fixed template. */
      task: text(BOUNTY_MAX_TASK_CHARS),
      /** 1 to 4 acceptance criteria the judge marks pass or fail, as written here. */
      criteria: z.array(text(BOUNTY_MAX_CRITERION_CHARS)).min(1).max(BOUNTY_MAX_CRITERIA),
      deliverable: z.enum(['image', 'link']),
      /** 0.1 to 1 USDC, at most two decimals. */
      amountUsdc: z.number().min(0.1).max(1),
      /** 1 to 72 hours; your policy's default when absent. */
      hoursOpen: z.number().int().min(BOUNTY_MIN_HOURS_OPEN).max(BOUNTY_MAX_HOURS_OPEN).optional(),
    })
    .strict(),
  bounty_cancel: z.object({ jobId: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a job id') }).strict(),
  bounty_list: z.object({}).strict(),
} as const;

export type ToolName = keyof typeof toolInputSchemas;

/**
 * `draft_intent`: the only way out of the decide phase of economy mode. It is not a catalog tool (it never executes
 * anything and never reaches the broker); the supervisor swaps it in for the publishing tools while the cheap model
 * runs, and swaps it out again once the writer takes over (apps/supervisor/src/routing.ts).
 */
export const DRAFT_INTENT_TOOL_NAME = 'draft_intent' as const;
export const draftIntentInputSchema = z
  .object({
    kind: z.enum(['post', 'reply']),
    /** The mention (post id) a reply answers; required for a reply, ignored for a post. */
    target: xIdSchema.optional(),
    /** What to say and the facts to use, for the writer (max 300 characters). */
    about: text(300),
    /** A picture the post should carry: the writer makes it with `generate_image` from this brief and attaches it. */
    picture: z.object({ brief: text(300) }).strict().optional(),
    /** The creator request (creatorRequests) this post or reply fulfils; it closes once the publish goes out. */
    requestId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((v) => v.kind !== 'reply' || !!v.target, { message: 'a reply intent needs the target post id', path: ['target'] });
export type DraftIntent = z.infer<typeof draftIntentInputSchema>;
export const TOOL_NAMES = Object.keys(toolInputSchemas) as ToolName[];

export type ToolInput<N extends ToolName = ToolName> = z.infer<(typeof toolInputSchemas)[N]>;

/** Discriminated union of every tool call the model may request. */
export type Action = { [N in ToolName]: { tool: N; input: ToolInput<N> } }[ToolName];

export const actionSchema: z.ZodType<Action> = z.discriminatedUnion(
  'tool',
  TOOL_NAMES.map((name) => z.object({ tool: z.literal(name), input: toolInputSchemas[name] })) as unknown as [
    z.ZodDiscriminatedUnionOption<'tool'>,
    ...z.ZodDiscriminatedUnionOption<'tool'>[],
  ],
) as unknown as z.ZodType<Action>;

export function parseAction(value: unknown): Action {
  return actionSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Action lifecycle
// ---------------------------------------------------------------------------

export const ACTION_STATUSES = ['sending', 'sent', 'held', 'completed', 'failed'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface ActionReceipt {
  txHash?: string;
  postId?: string;
  [key: string]: unknown;
}

export type ActionOutcome =
  | { kind: 'completed'; result: unknown; receipt?: ActionReceipt }
  | { kind: 'failed'; error: string; retryAt?: number }
  | { kind: 'unknown'; error: string };

export interface ActionResult {
  actionId: string;
  tool: ToolName;
  status: 'completed' | 'failed' | 'unknown';
  result?: unknown;
  error?: string;
  receipt?: ActionReceipt;
}

export interface PendingAction {
  id: string;
  cycleKey: string;
  action: Action;
  status: ActionStatus;
  createdAt: number;
  /** Number of times the same original request was (re)sent. */
  attempts: number;
  /** Earliest time a resumable action may be resent. */
  nextAt?: number;
  /** Why the action is held or failed. */
  reason?: string;
  result?: ActionResult;
  /** Set when the worker said `done: true` together with this action. */
  completeAfter?: boolean;
}

// ---------------------------------------------------------------------------
// Worker contract
// ---------------------------------------------------------------------------

export interface WorkerInput<State = unknown, Observation = unknown> {
  state: State;
  observation: Observation | null;
  cycle: number;
}

export interface WorkerOutput<State = unknown> {
  state: State;
  action?: Action;
  done?: boolean;
}

export const workerOutputSchema = z.object({
  state: z.unknown(),
  action: actionSchema.optional(),
  done: z.boolean().optional(),
});
