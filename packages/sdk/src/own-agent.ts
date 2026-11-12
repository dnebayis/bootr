/**
 * Own agents (docs/design/byo-agent.md): the wire types, constants and error codes shared by the supervisor
 * (`/internal/own/*`), the web (`/api/agent/connect/*`, `/api/agent/run/*`, `/api/agent/[kernel]/clients/*`,
 * `/api/agent/[kernel]/runner`) and, as a byte-for-byte copy, the SDK (`packages/sdk/src/own-agent.ts`).
 * No imports: plain TypeScript, so every package can take it. Times on the wire are ISO 8601 strings in UTC.
 */

// ---------------------------------------------------------------------------
// Names and constants
// ---------------------------------------------------------------------------

/**
 * The one flag. `true` shows the feature's surfaces (the launch choice, the connect and run routes, the MCP tools) and
 * lets a coin become own. It never decides how an existing coin is run: see `runnerOf`.
 */
export const OWN_AGENT_FLAG = 'OWN_AGENT_ENABLED';
/** What an own-agent launch writes as `model` on chain and what the supervisor posts to the indexer's social store. */
export const OWN_AGENT_MODEL_ID = 'own-agent';

export type Runner = 'hosted' | 'own';
export const RUNNERS: readonly Runner[] = ['hosted', 'own'];
export type OwnRole = 'social' | 'treasury' | 'judge';
export const OWN_ROLES: readonly OwnRole[] = ['social', 'treasury', 'judge'];

/**
 * Who runs the agent, read from the stored config and nothing else. The flag is not asked: with the flag off a coin
 * whose config says `own` is still an own coin (silent, since its run routes are closed), never a hosted one.
 */
export function runnerOf(config: unknown): Runner {
  return typeof config === 'object' && config !== null && (config as { runner?: unknown }).runner === 'own' ? 'own' : 'hosted';
}

export const CREDENTIAL_PREFIX = 'bootr_agt_';
/** `bootr_agt_` and 32 random bytes as unpadded base64url (43 characters). */
export const CREDENTIAL_RE = /^bootr_agt_[A-Za-z0-9_-]{43}$/;
export const CLIENT_ID_PREFIX = 'cli_';
export const TURN_ID_PREFIX = 'otn_';
export const MCP_TOOL_PREFIX = 'bootr_agent_';
/** Twenty consonants: no vowels (so no words), no I and no O. A user code is two groups of four. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
export const DEVICE_CODE_TTL_S = 600;
export const DEVICE_POLL_INTERVAL_S = 5;
export const CLIENT_LABEL_MAX = 40;

/** Defaults of the supervisor's own-agent settings; config.ts reads the env variable of the same name. */
export const OWN_DEFAULTS = {
  OWN_TURN_IDLE_MS: 600_000,
  OWN_TURN_MAX_MS: 1_800_000,
  OWN_FORCED_TURNS_PER_DAY: 6,
  OWN_DUE_MIN_INTERVAL_MS: 20_000,
  OWN_READS_PER_DAY: 200,
  OWN_SEARCH_PER_DAY: 50,
  OWN_READ_URL_PER_DAY: 200,
  OWN_CLIENT_TTL_DAYS: 90,
  OWN_CLIENTS_PER_AGENT: 3,
  OWN_JUDGE_WAIT_MS: 172_800_000,
  OWN_STALE_MENTION_MS: 86_400_000,
  OWN_OBSERVATION_BYTES: 60_000,
  /** Turns one coin's clients may open per rolling 24 hours (a real agent needs a turn per mention and 48 posts at most). */
  OWN_TURNS_PER_DAY: 300,
  /** Tool calls of every kind, a refused `finish` included, per rolling 24 hours. */
  OWN_STEPS_PER_DAY: 2_000,
  /** `remember` calls per rolling 24 hours. */
  OWN_REMEMBER_PER_DAY: 200,
  /** `treasury_prepare` calls per rolling 24 hours. */
  OWN_TREASURY_PREPARE_PER_DAY: 100,
  /** `treasury_execute` calls per rolling 24 hours. */
  OWN_TREASURY_EXECUTE_PER_DAY: 30,
  /** `x402_fetch` and `discover_services` calls together per rolling 24 hours. */
  OWN_SERVICE_CALLS_PER_DAY: 100,
  /** Picture uploads tried per rolling 24 hours, kept or refused. */
  OWN_UPLOAD_ATTEMPTS_PER_DAY: 24,
} as const;

export const PICTURE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type PictureMime = (typeof PICTURE_MIMES)[number];
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;
export const PICTURE_DESCRIPTION_MAX = 300;

// ---------------------------------------------------------------------------
// The signed approval (SIWE statements)
// ---------------------------------------------------------------------------

/** Groups: symbol, agent id, kernel, user code. */
export const CONNECT_COIN_STATEMENT =
  /^Let an AI client run the agent of Bootr coin \$([A-Za-z0-9_]{1,16}) \(#(\d{1,20}), (0x[0-9a-fA-F]{40})\)\. Code ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})\.$/;
/** Groups: draft id, user code. */
export const CONNECT_DRAFT_STATEMENT =
  /^Let an AI client run the agent of my next Bootr launch \(draft ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\. Code ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})\.$/;

export function connectCoinStatement(symbol: string, agentId: string, kernel: string, userCode: string): string {
  return `Let an AI client run the agent of Bootr coin $${symbol} (#${agentId}, ${kernel}). Code ${userCode}.`;
}

export function connectDraftStatement(draftId: string, userCode: string): string {
  return `Let an AI client run the agent of my next Bootr launch (draft ${draftId}). Code ${userCode}.`;
}

// ---------------------------------------------------------------------------
// Errors: one body shape for every route
// ---------------------------------------------------------------------------

export type OwnErrorCode =
  | 'own_agent_disabled'
  | 'invalid_request'
  | 'payload_too_large'
  | 'rate_limited'
  | 'supervisor_unavailable'
  | 'grant_not_found'
  | 'grant_expired'
  | 'grant_used'
  | 'slow_down'
  | 'siwe_rejected'
  | 'not_creator'
  | 'unknown_coin'
  | 'too_many_clients'
  | 'wrong_coin'
  | 'unauthorized'
  | 'credential_expired'
  | 'credential_revoked'
  | 'coin_not_launched'
  | 'agent_onboarding'
  | 'agent_runs_hosted'
  | 'agent_paused'
  | 'not_due'
  | 'forced_turns_used'
  | 'daily_budget_used'
  | 'turn_open'
  | 'turn_not_found'
  | 'turn_closed'
  | 'turn_expired'
  | 'tool_unavailable'
  | 'invalid_tool_call'
  | 'runtime_busy'
  | 'step_cap'
  | 'held_action'
  | 'client_not_found'
  | 'runner_unchanged'
  | 'settings_changed'
  | 'model_required'
  | 'model_not_allowed'
  | 'chat_not_available';

export interface OwnErrorBody {
  error: OwnErrorCode;
  /** Plain words for the person or the model reading it: `OWN_ERRORS[error].message`, with a detail appended after a space for `invalid_request` and `invalid_tool_call`. */
  message: string;
  /** When trying again can work (`rate_limited`, `slow_down`, `not_due`, `forced_turns_used`, `daily_budget_used`, `turn_open`, `runtime_busy`, `held_action`). */
  retryAt?: string;
  /** The offending field of an `invalid_request` or `invalid_tool_call`. */
  field?: string;
}

/** HTTP status and message per code. No route invents another text for these codes. */
export const OWN_ERRORS: { readonly [C in OwnErrorCode]: { readonly status: number; readonly message: string } } = {
  own_agent_disabled: { status: 404, message: 'Own agents are switched off on this site for now. Nothing was done.' },
  invalid_request: { status: 400, message: 'The request is not valid.' },
  payload_too_large: { status: 413, message: 'The request body is too large.' },
  rate_limited: { status: 429, message: 'Too many requests. Try again after retryAt.' },
  supervisor_unavailable: { status: 503, message: 'The agent service is unavailable right now. Try again in a moment.' },
  grant_not_found: { status: 404, message: 'No connection request has that code. Start again from your AI client.' },
  grant_expired: { status: 410, message: 'That connection request ran out after 10 minutes. Start again from your AI client.' },
  grant_used: { status: 410, message: 'That connection request was already used. Start again from your AI client.' },
  slow_down: { status: 429, message: 'Asked too soon. Wait for the interval, then ask again.' },
  siwe_rejected: { status: 401, message: 'The wallet signature was not accepted. Sign again.' },
  not_creator: { status: 403, message: 'Only the wallet that launched the coin can connect a client to its agent.' },
  unknown_coin: { status: 404, message: 'No Bootr coin matches that.' },
  too_many_clients: { status: 409, message: 'This coin already has as many clients as it may have. Disconnect one in the creator console first.' },
  wrong_coin: { status: 409, message: 'This connection request is for another coin. Approve it for the coin it names, or start again from your AI client.' },
  unauthorized: { status: 401, message: 'Missing or unknown credential. Connect this client to Bootr again.' },
  credential_expired: { status: 401, message: "This client's connection ran out. Connect it to Bootr again." },
  credential_revoked: { status: 401, message: 'This client was disconnected, from the client itself or in the creator console. Connect it to Bootr again to use it.' },
  coin_not_launched: { status: 409, message: 'This client is connected to a launch that has not happened yet. Launch the coin, then try again.' },
  agent_onboarding: { status: 409, message: "The agent is still being set up. The coin's page shows what is missing." },
  agent_runs_hosted: { status: 409, message: "This coin's agent is run by Bootr right now. Switch it to your own agent in the creator console first." },
  agent_paused: { status: 409, message: 'The agent is paused. Nothing runs until it is resumed.' },
  not_due: { status: 409, message: 'Nothing is due for this role now. Look again at retryAt.' },
  forced_turns_used: { status: 429, message: "Today's turns outside the schedule are used up. The next turn is due at retryAt." },
  daily_budget_used: { status: 429, message: "This coin's agent has used the turns or the tool calls it may make in 24 hours. Nothing was done; look again at retryAt." },
  turn_open: { status: 409, message: 'Another turn is open. Finish it, or wait until it runs out at retryAt.' },
  turn_not_found: { status: 404, message: 'No such turn. Open one first.' },
  turn_closed: { status: 410, message: 'That turn has ended. Open a new one if something is due.' },
  turn_expired: { status: 410, message: 'That turn was closed after 10 minutes without a call. Open a new one if something is due.' },
  tool_unavailable: { status: 409, message: "That tool is not part of this turn: its role, the coin's powers or the creator's rules leave it out. Use only the tools the turn lists." },
  invalid_tool_call: { status: 400, message: 'The tool input is not valid.' },
  runtime_busy: { status: 409, message: 'The previous action has not settled yet. Repeat that same call after retryAt.' },
  step_cap: { status: 409, message: 'This turn has used all its steps. Finish it.' },
  held_action: { status: 409, message: 'An earlier action is waiting for its receipt. The server settles it; look again at retryAt.' },
  client_not_found: { status: 404, message: 'No such client on this coin.' },
  runner_unchanged: { status: 409, message: 'The agent is already run that way.' },
  settings_changed: { status: 409, message: "The agent's settings changed since they were read. Nothing was done; read them again, then retry." },
  model_required: { status: 400, message: 'Choose the model the Bootr agent should think with.' },
  model_not_allowed: { status: 400, message: 'That model is not offered right now. Choose another.' },
  chat_not_available: { status: 409, message: "This coin's agent runs in its creator's own AI client. Talk to it there." },
};

// ---------------------------------------------------------------------------
// Connecting a client
// ---------------------------------------------------------------------------

export interface CoinRef {
  agentId: string;
  kernel: string;
  token: string;
  symbol: string;
  name: string;
}

export type ConnectTarget = { kind: 'coin'; coin: CoinRef } | { kind: 'draft'; draftId: string };

export interface ConnectStartRequest {
  /** What the client calls itself (MCP `clientInfo.name`), shown on the approval page; at most CLIENT_LABEL_MAX characters. */
  clientName?: string;
  /**
   * A coin the user named (symbol, token or kernel address). When it names exactly one coin the request is bound to that
   * coin (`ConnectStartResponse.coin`); otherwise it is a hint the approval page puts first, and never trusted.
   */
  coin?: string;
}

export interface ConnectStartResponse {
  /** Secret, for the token route only; never shown to the user or the model. */
  deviceCode: string;
  userCode: string;
  /** `<site>/connect` */
  verificationUri: string;
  /** `<site>/connect/<userCode>` */
  verificationUriComplete: string;
  /** Seconds: DEVICE_CODE_TTL_S. */
  expiresIn: number;
  /** Seconds between token polls: DEVICE_POLL_INTERVAL_S. */
  interval: number;
  /**
   * The one coin the request's `coin` named, when it named exactly one (a kernel or token address, or a symbol only one
   * coin has). The request is then for that coin alone: an approval for anything else is refused with `wrong_coin`.
   * Absent when no coin was named or the name fits none or several; the creator then chooses on the approval page.
   */
  coin?: CoinRef;
}

export interface ConnectGrantView {
  userCode: string;
  clientName: string;
  coinHint: string | null;
  status: 'pending' | 'approved' | 'redeemed' | 'expired';
  expiresAt: string;
  /** The one coin this request is for (`ConnectStartResponse.coin`): the approval page shows it fixed, with no other choice. */
  coin?: CoinRef | null;
}

export interface ConnectApproveRequest {
  userCode: string;
  /** The SIWE message whose statement is `connectCoinStatement(...)` or `connectDraftStatement(...)`. */
  message: string;
  signature: string;
  /** The creator's own name for this client; the grant's `clientName` when absent. */
  label?: string;
}

export interface ConnectApproveResponse {
  ok: true;
  target: ConnectTarget;
  label: string;
}

export interface ConnectTokenRequest {
  deviceCode: string;
}

/** `approved` is answered once; the same device code afterwards is `grant_used`. */
export type ConnectTokenResponse =
  | { status: 'pending' }
  | { status: 'approved'; credential: string; clientId: string; label: string; target: ConnectTarget; expiresAt: string };

export interface ClientView {
  clientId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

/**
 * An approval the creator signed whose client has not collected its credential yet: it can until `expiresAt`, ten
 * minutes after the client asked. It takes one of the coin's places and can be cancelled like a client.
 */
export interface WaitingApprovalView {
  /** The code the creator approved; names the approval when it is cancelled (it opens nothing by itself). */
  userCode: string;
  label: string;
  approvedAt: string;
  expiresAt: string;
}

export interface ClientsResponse {
  clients: ClientView[];
  /** OWN_CLIENTS_PER_AGENT. */
  max: number;
  /** Approvals waiting to be collected, oldest first. Absent from a server that does not list them. */
  waiting?: WaitingApprovalView[];
}

export interface DraftClientsResponse {
  connected: boolean;
  clients: { clientId: string; label: string; createdAt: string }[];
}

/** The coins a wallet launched, newest first: what the approval page offers once the wallet is connected. */
export interface ConnectCoinsResponse {
  coins: CoinRef[];
}

// ---------------------------------------------------------------------------
// Running the agent
// ---------------------------------------------------------------------------

export type HoldReason = 'x_quota' | 'x_credits' | 'x_forbidden' | 'paused_by_creator' | 'paused_by_platform' | 'held_action' | 'x_not_connected';

export interface HoldView {
  reason: HoldReason;
  until: string | null;
  message: string;
}

export interface JudgeJobRef {
  jobId: string;
  /** When the job's window closed. */
  closedAt: string;
  /** After this the job closes with no winner (OWN_JUDGE_WAIT_MS after `closedAt`). */
  ruleBy: string;
  entries: number;
}

export interface DueRole {
  /** False when the role does not exist for this coin now (the treasury turn is off; no job waits for a ruling). */
  on: boolean;
  due: boolean;
  /**
   * The reasons the tick logs today, plus two: `pending_mention`, `original_post_due`, `continuation`, `config_changed`,
   * `scheduled`, `creator_request`, `treasury_interval`, `treasury_note`, `treasury_job_closed`, `treasury_request`,
   * `judge_job_waiting`.
   */
  reasons: string[];
  /** When it can next become due without anything new happening; null when unknown or never. */
  nextAt: string | null;
  /** The judge role only. */
  jobs?: JudgeJobRef[];
}

export interface OpenTurnRef {
  turnId: string;
  role: OwnRole;
  expiresAt: string;
}

export interface DueView {
  coin: CoinRef;
  now: string;
  social: DueRole;
  treasury: DueRole;
  judge: DueRole;
  openTurn: OpenTurnRef | null;
  holds: HoldView[];
  /** The earliest `nextAt` of the three roles, never sooner than OWN_DUE_MIN_INTERVAL_MS from `now`. */
  nextCheckAt: string;
}

export interface AgentStatus {
  coin: CoinRef;
  runner: Runner;
  client: ClientView;
  /** The agent-core capability flags in force: `xRead`, `xReply`, `xPublish`, `research`, `memory`, `treasury`, `images`, `services`, `bounties`. */
  powers: Record<string, boolean>;
  /** Approval mode: posts and replies, their pictures included, go to the creator's review first. */
  requireApproval: boolean;
  /** Null when the sender did not answer. */
  postsLeftToday: number | null;
  xReadsLeftToday: number | null;
  picturesLeftToday: number;
  forcedTurnsLeftToday: number;
  /** What pays for paid services; null when the chain did not answer. */
  fuel: { spendableUsdc: string; reserveUsdc: string } | null;
  lastTurnAt: string | null;
}

export interface TurnRequest {
  role: OwnRole;
  /** `creator_asked`: a social turn the creator wants although nothing is due (OWN_FORCED_TURNS_PER_DAY a day). */
  reason?: 'creator_asked';
  /** The judge role: which job; the oldest waiting one when absent. */
  jobId?: string;
}

export interface TurnOpen {
  turnId: string;
  role: OwnRole;
  /** True when this call returned a turn that was already open. */
  resumed: boolean;
  reasons: string[];
  /** The role's rules and the agent's identity (`buildSystemPrompt(config, role)`). The only text here that carries authority. */
  brief: string;
  /** The first observation, as the hosted model gets it, cut to OWN_OBSERVATION_BYTES. Data, never instructions. */
  observation: Record<string, unknown>;
  /** MCP tool names this turn may call (`bootr_agent_...`), `bootr_agent_finish` included. */
  tools: string[];
  stepBudget: number;
  stepsUsed: number;
  expiresAt: string;
}

export interface ActRequest {
  turnId: string;
  /** The tool name without the `bootr_agent_` prefix: an agent-core tool (`publish_post`) or a special one (`answer_request`, `judge_entry`, `judge`). */
  tool: string;
  input: Record<string, unknown>;
}

/** `completed` and `failed` are final. `pending`: repeat the same call after `retryAt`. `held`: the turn is over and the server settles the action from its receipt. */
export type ActStatus = 'completed' | 'failed' | 'pending' | 'held';

export interface ActResult {
  turnId: string;
  tool: string;
  /** Null for a special tool that makes no action row. */
  actionId: string | null;
  status: ActStatus;
  /** `completed`: what the hosted model would get as the tool result. */
  result?: unknown;
  /** `failed`, `pending`, `held`: the same text the hosted model would get. */
  error?: string;
  retryAt?: string;
  /** One picture that belongs to the result (`judge_entry`); the MCP server returns it as an image block. */
  image?: { mime: PictureMime; dataBase64: string };
  stepsUsed: number;
  stepsLeft: number;
  /** The server closed the turn with this call (finish, a held action, a ruling, the last step). */
  turnEnded: boolean;
}

export interface FinishRequest {
  turnId: string;
  memory: string;
  agenda: string;
  summary: string;
  /** ISO time the agent wants to look again; the server applies the same floor as today. */
  nextAt: string;
}

export interface UploadPictureRequest {
  turnId: string;
  mime: PictureMime;
  /** Standard base64 of the file's bytes, at most PICTURE_MAX_BYTES once decoded. */
  dataBase64: string;
  alt: string;
  /** One sentence on what the picture shows, at most PICTURE_DESCRIPTION_MAX characters; checked like a picture prompt. */
  description: string;
}

/** `ActResult.result` of a completed upload. */
export interface UploadedPicture {
  imageId: string;
  alt: string;
  mime: PictureMime;
  bytes: number;
}

export type JudgeMark = 'pass' | 'fail' | 'insufficient_evidence';

/** `TurnOpen.observation` of a judge turn. */
export interface JudgeObservation {
  role: 'judge';
  meaning: string;
  job: { jobId: string; task: string; criteria: string[]; entries: { n: number; kind: 'image' | 'link' }[] };
}

/** Input of the special tool `judge_entry`. */
export interface JudgeEntryInput {
  n: number;
}

/** `ActResult.result` of `judge_entry`; a picture arrives in `ActResult.image`. */
export interface JudgeEntryView {
  n: number;
  kind: 'image' | 'link';
  /** The linked page's bounded text, for a `link` entry. */
  excerpt?: string;
}

/** Input of the special tool `judge`. */
export interface JudgeRulingInput {
  /** The winning entry's number, or null when none meets every criterion. */
  winner: number | null;
  /** Entry number (as a string key) to one mark per criterion, in the criteria's order. */
  perCriterion: Record<string, JudgeMark[]>;
  /** At most 200 characters; no address, cashtag, link or handle. */
  reason: string;
}

/** `ActResult.result` of `judge`. */
export interface JudgeOutcome {
  jobId: string;
  /** False when code refused the ruling; the job then closes with no winner. */
  accepted: boolean;
  winner: number | null;
  /** The judge.ts `JudgeInvalidCode` when `accepted` is false. */
  invalid?: string;
}

/** Input of the special tool `answer_request`. */
export interface AnswerRequestInput {
  requestId: string;
  outcome: 'done' | 'not_done';
  /** At most 300 characters. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Switching the runner, and what the console and the coin page read
// ---------------------------------------------------------------------------

/** `runner: 'own'` is refused with `own_agent_disabled` while the flag is off; `runner: 'hosted'` is always taken. */
export interface RunnerSwitchRequest {
  runner: Runner;
  /** Switching to `hosted`: the model to think with; required when the stored one is not on the allowed list. */
  model?: string;
  /**
   * The config revision the caller read before it asked. When the stored revision is another one the switch answers
   * `settings_changed` and does nothing, so the same request sent a second time (a switch bumps the revision) is refused.
   */
  expectedRevision?: number;
}

export interface RunnerSwitchResponse {
  runner: Runner;
  revision: number;
  /** What the creator should know now, in plain words (fuel is needed to think, pictures are back on the paid path, connect a client). */
  notes: string[];
}

/** Added to the supervisor's `AgentConfigView` and to the web's copy of it, as the field `runner` and the field `own`; read from the config, with the flag on or off. */
export interface RunnerView {
  runner: Runner;
  /** Null for a hosted coin. */
  own: { lastTurnAt: string | null; clients: number } | null;
}
