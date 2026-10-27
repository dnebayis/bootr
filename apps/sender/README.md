# sender

The X (Twitter) boundary service for Bootr. Each agent operates its own X account; the sender
is the only process that holds X credentials. The supervisor (agent runtime) never sees a token:
it asks the sender to read or publish through a small HMAC-authenticated internal API.

Design follows Claus Network's SOCIAL-BOUNDARY model:

- Per-agent OAuth 2.0 user tokens are stored AES-256-GCM encrypted (`SENDER_ENCRYPTION_KEY`),
  bound to their row and column through AAD (`access:<agentId>`, `refresh:<agentId>`).
- **One publication per `actionId`.** The action row (body hash and attempt count) is committed
  _before_ X is contacted. A repeated request returns the original receipt. A definite rejection
  stays `rejected`. An ambiguous outcome (timeout, network error, 5xx, DB failure after send)
  stays `held` and is settled only by reconciliation. It is never resent.
- Outgoing text passes the agent-core publish gate (`validatePost`, which runs
  `outgoingActionRisk`) and the consent ledger (opted-out authors are never replied to).

## Running

```sh
pnpm --filter sender db:migrate     # apply drizzle/ migrations to DATABASE_URL
pnpm --filter sender dev            # http://localhost:3002 (PORT)
pnpm --filter sender reconcile      # one reconciliation pass (the server also runs it on an interval)
pnpm --filter sender test           # vitest (PGlite in-memory Postgres + stubbed X)
pnpm --filter sender typecheck
```

### Migrations

The schema lives in `src/db/schema.ts` (every table is prefixed `sender_`). SQL migrations are
generated with drizzle-kit and committed under `drizzle/`:

```sh
pnpm --filter sender db:generate    # after editing src/db/schema.ts (writes drizzle/NNNN_*.sql)
pnpm --filter sender db:migrate     # applies pending migrations
```

Applied migrations are tracked in `public.sender_migrations`, so the sender can share a database
with other services without clashing with their drizzle journals.

| Table             | Purpose                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `sender_accounts` | agentId -> X user id/handle, encrypted access/refresh tokens, scopes, expiry, revokedAt                  |
| `sender_actions`  | one row per actionId: body hash, status `pending/sent/held/rejected`, provider post id, attempts, checks |
| `sender_reads`    | read metering: count per (agent, kind, UTC day)                                                          |
| `sender_inbox`    | observed mentions per (agent, postId): status `pending/skipped/answered/retrying/delivery_blocked`       |
| `sender_optouts`  | consent ledger per (agent, author): `enabled = true` means opted out; newer post wins                    |
| `sender_quotas`   | per-agent rate budget overrides, last mention read, mention `since_id` cursor                            |

## Environment variables

| Variable                              | Required | Default                            | Notes                                                                    |
| ------------------------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                        | yes      |                                    | Postgres connection string                                               |
| `SENDER_SERVICE_KEY`                  | yes      |                                    | HMAC key shared with the supervisor and web app (use 32+ random chars)   |
| `SENDER_ENCRYPTION_KEY`               | yes      |                                    | 32 bytes hex (`openssl rand -hex 32`). Rotating it orphans stored tokens |
| `X_CLIENT_ID` / `X_CLIENT_SECRET`     | yes      |                                    | the platform's X app (confidential client)                               |
| `X_REDIRECT_URI`                      | yes      |                                    | must point to `GET /oauth/callback` and be registered on X               |
| `SENDER_OAUTH_RETURN_URL`             | no       | unset (JSON)                       | browser redirect after the callback                                      |
| `PORT`                                | no       | `3002`                             |                                                                          |
| `SENDER_RECONCILE_INTERVAL_MS`        | no       | `60000`                            | `0` disables the in-process reconciler                                   |
| `SENDER_DEFAULT_POSTS_PER_DAY`        | no       | `24`                               | rolling 24h window                                                       |
| `SENDER_DEFAULT_MENTION_INTERVAL_SEC` | no       | `300`                              | minimum spacing between mention reads                                    |
| `X_API_BASE_URL`                      | no       | `https://api.x.com`                | token endpoint is `<base>/2/oauth2/token`                                |
| `X_AUTHORIZE_URL`                     | no       | `https://x.com/i/oauth2/authorize` |                                                                          |
| `X_TIMEOUT_MS`                        | no       | `15000`                            | per X request; a timed-out publish becomes `held`                        |

## Internal authentication

Every `/internal/*` request carries

```
Authorization: HMAC <ts>:<hex>
hex = HMAC-SHA256(SENDER_SERVICE_KEY, ts + "\n" + METHOD + "\n" + path + "\n" + hex(sha256(body)))
```

- `ts` is unix time in **seconds**, accepted within ±5 minutes.
- `path` is the request target: pathname **plus the query string** if present
  (`/internal/metering/a1?month=2026-10`).
- `body` is the exact raw body bytes sent (`""` for GET).

Reference implementation (`src/auth.ts` exports `signRequest`):

```ts
import { createHash, createHmac } from 'node:crypto';

function sign(key: string, method: string, path: string, body = ''): string {
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const mac = createHmac('sha256', key)
    .update(`${ts}\n${method}\n${path}\n${bodyHash}`)
    .digest('hex');
  return `HMAC ${ts}:${mac}`;
}
```

There is no replay cache. A replay inside the window is harmless: publish is idempotent per
`actionId`, resolve and quota writes are idempotent, and reads are throttled. A cache would also
reject legitimate byte-identical retries signed in the same second.

## Endpoints

| Method | Path                                                 | Auth                    | Purpose                                                                 |
| ------ | ---------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| GET    | `/health`                                            | none                    | liveness                                                                |
| GET    | `/oauth/start?agentId=&state=&ts=&sig=[&redirect=1]` | start signature or HMAC | returns `{url}` (X authorize URL), or a 302 with `redirect=1`           |
| GET    | `/oauth/callback?code=&state=`                       | signed state            | exchanges the code, stores tokens, records `users/me` id and handle     |
| POST   | `/internal/publish`                                  | HMAC                    | idempotent post or reply                                                |
| GET    | `/internal/receipt/:actionId`                        | HMAC                    | stored receipt                                                          |
| POST   | `/internal/read/mentions`                            | HMAC                    | fetch new mentions, apply consent, return eligible inbox items          |
| POST   | `/internal/read/thread`                              | HMAC                    | walk the reply chain upward from a post (at most 8)                     |
| POST   | `/internal/read/account`                             | HMAC                    | look up a user by username                                              |
| POST   | `/internal/inbox/resolve`                            | HMAC                    | mark a mention `skip`, `opt_out` or `defer`                             |
| GET    | `/internal/metering/:agentId?month=YYYY-MM`          | HMAC                    | post and read counts for charge-back                                    |
| GET    | `/internal/account/:agentId`                         | HMAC                    | `{agentId, connected, revoked, handle, xUserId, scopes, expiresAt, connectedAt}` |
| POST   | `/internal/account/:agentId/rebind`                  | HMAC                    | `{to, connectedBefore?}`: move a draft-id account to the real agent id  |
| GET    | `/internal/quota/:agentId`                           | HMAC                    | effective rate budget                                                   |
| POST   | `/internal/quota/:agentId`                           | HMAC                    | `{postsPerDay?, mentionReadIntervalSec?}`; `null` resets to the default |

### OAuth (creator connects the agent's X account)

1. The web app (`apps/web/app/api/x/start`, server-side) sends the creator's browser to
   `GET /oauth/start?agentId=<id>&state=<web state>&ts=<unix s>&sig=<hex>&redirect=1` where
   `sig = HMAC-SHA256(SENDER_SERVICE_KEY, "oauth-start\n" + agentId + "\n" + state + "\n" + ts)`.
   The signature stops anyone else from binding an X account to an agent. A server-side caller can
   instead send the internal `Authorization: HMAC` header and read `{url}` from the JSON.
2. The sender builds a PKCE (S256) authorize URL with scopes
   `tweet.read tweet.write users.read offline.access`. The `state` sent to X is
   `base64url(payload).HMAC(SENDER_SERVICE_KEY)`, valid for 15 minutes, and carries the agentId,
   the web app's state and the **encrypted** PKCE verifier, so no server-side session is needed.
3. `GET /oauth/callback` verifies the state, exchanges the code (HTTP Basic client auth), calls
   `GET /2/users/me` and upserts `sender_accounts` (clearing `revokedAt`). It then redirects to
   `SENDER_OAUTH_RETURN_URL?agentId=&status=connected|denied|error&state=<web state>[&handle=]`,
   or returns the same fields as JSON when that variable is unset.

The launch form connects X **before** the agent exists, so `agentId` there is the form's draft
uuid (also written into the Clanker `tokenContext` as `{"interface":"Bootr","platform":"bootr.fun","id":"<uuid>"}`).
The web app polls `GET /internal/account/<draft uuid>` server-side (`/api/x/status`). After launch the
supervisor moves the account to the ERC-8004 agent id with `POST /internal/account/:draftId/rebind`.

### `POST /internal/account/:agentId/rebind` `{to, connectedBefore?}`

Moves the account under `:agentId` (the draft id) to `to`, in one transaction:

- `sender_accounts`: the row moves; access/refresh tokens are decrypted and re-encrypted because their
  AES-GCM AAD (`access:<agentId>` / `refresh:<agentId>`) binds the agent id.
- `sender_quotas`: moved when `to` has no row (an existing row for `to` wins).
- `sender_reads`: metering counts merged into `to` (the `users_me` read made at connect time).
- `sender_actions`, `sender_inbox`, `sender_optouts` are **not** moved: a draft id never publishes or
  reads mentions (only the supervisor does, with real agent ids), and history is never rewritten.

`connectedBefore` (ISO time, optional) refuses the move with 409 `connected_after_cutoff` when the
account was (re)connected after it; the supervisor passes the launch block time, so nobody can bind
their own X account to a draft id once it is public on-chain.

| Case                                  | HTTP | Body                                                 |
| ------------------------------------- | ---- | ---------------------------------------------------- |
| moved                                 | 200  | `{from, to, status: "moved", handle}`                |
| `from` gone, `to` present (retry)     | 200  | `{from, to, status: "already", handle}`              |
| neither has an account                | 404  | `{error: "not_found"}`                               |
| `to` already has an account           | 409  | `{error: "conflict"}`                                |
| connected after `connectedBefore`     | 409  | `{error: "connected_after_cutoff"}`                  |
| bad ids / body, `from == to`          | 400  | `{error: "invalid_request"}`                         |

Access tokens are refreshed automatically when less than 2 minutes remain, and once after a 401.
Refreshes are serialised per agent because X rotates refresh tokens. If the refresh endpoint
answers 400 or 401 (for example `invalid_grant`), the account is marked revoked and the creator
must reconnect.

### `POST /internal/publish`

```jsonc
{
  "agentId": "a1",
  "actionId": "a1:2026-10-24:reply:1888...", // 8-128 chars [A-Za-z0-9:_.-], unique per intended publication
  "text": "...",
  "replyTo": "1888...", // optional: makes it a reply (280-char "short" format); else an original post (4000)
  "replyAuthorId": "42", // optional: author of replyTo; taken from the inbox when omitted
  "attributions": [{ "username": "alice", "sourceUrl": "https://..." }], // optional, required by validatePost for @mentions
}
```

Response `200` for every **recorded** outcome:
`{ status: "sent" | "held" | "rejected" | "pending", providerPostId?, receipt, duplicate? }`.
The receipt holds `actionId, agentId, kind, status, providerPostId, bodyHash, attempts, error,
createdAt, sentAt, lastCheckedAt, nextCheckAt` plus `signature`, which is
`HMAC-SHA256(SENDER_SERVICE_KEY, "receipt\n" + canonicalJson(fields))`.

| Outcome                                   | HTTP | Recorded | What the supervisor does                                         |
| ----------------------------------------- | ---- | -------- | ---------------------------------------------------------------- |
| `sent`                                    | 200  | yes      | done                                                             |
| `held` (ambiguous)                        | 200  | yes      | **do not** publish again; poll `GET /internal/receipt/:actionId` |
| `rejected` (policy, consent or X 4xx/429) | 200  | yes      | final for this actionId; a later retry needs a **new** actionId  |
| same actionId, same body                  | 200  | -        | original receipt, `duplicate: true`, no X call                   |
| same actionId, different body             | 409  | -        | `action_id_conflict`: caller bug                                 |
| `not_connected` / `revoked`               | 409  | no       | retry the same actionId after the creator reconnects             |
| `quota_exceeded`                          | 429  | no       | retry the same actionId after `retryAt`                          |
| `storage_unavailable` / `refresh_failed`  | 503  | no       | nothing was sent; retry the same actionId                        |
| `storage_unavailable_after_send`          | 503  | maybe    | treat as `held`; never resend                                    |

Policy rejections carry `error: "policy:<code>"` with an agent-core code
(`invalid_short_post`, `invalid_original_post`, `x_post_requires_at_most_one_cashtag`,
`mentions_require_source_credit`, `invalid_source_credit`, `social_*_forbidden`) or
`policy:consent_opted_out`.

A reply to an inbox item marks it `answered` (with `replyId`) once sent, `retrying` while held,
and `delivery_blocked` when X definitively refuses it with 403 or 404.

### `POST /internal/read/mentions` `{agentId, sinceId?}`

Calls `GET /2/users/:id/mentions` (up to 3 pages of 100, `since_id` = the argument or the stored
cursor) with `tweet.fields=author_id,conversation_id,created_at,entities,in_reply_to_user_id,referenced_tweets,note_tweet,public_metrics`,
`expansions=author_id,referenced_tweets.id` and `user.fields=username,verified,verified_type`.
New posts are upserted into `sender_inbox`, oldest first. Already-observed posts never change
status again.

- The agent's own posts are stored `skipped/own_post`.
- A bare `stop` or `resume` (agent-core `consentCommand`) updates `sender_optouts` and is stored
  `skipped/consent_stop|consent_resume`. Only a newer post id may change an author's state.
- Mentions from opted-out authors are stored `skipped/opted_out`.

Returns `{ throttled, nextReadAt?, fetched, sinceId, items }`. `items` are the pending, eligible
rows (not deferred into the future, author not opted out), at most 50, each
`{postId, authorId, conversationId, status, reason, observedAt, deferredUntil, post}` where
`post` has agent-core's `XPost` shape. If the agent read within its interval (default 5 min),
X is not called and `throttled: true` comes back with the current eligible items.

### Other reads

- `POST /internal/read/thread {agentId, postId}` returns `{ posts: XPost[] (root first), truncated }`.
  It follows `replied_to` up to 8 posts.
- `POST /internal/read/account {agentId, username}` returns `{ user }` with username, name,
  description, verified, verified_type, created_at, protected and public_metrics.
- `POST /internal/inbox/resolve {agentId, postId, outcome, reason, reviewAt?}`:
  - `skip` sets `skipped`.
  - `opt_out` sets `skipped` and opts the author out.
  - `defer` requires a future `reviewAt` and keeps the row `pending` until then.

  Answered or held items cannot be resolved (409).

### Metering

`GET /internal/metering/:agentId?month=2026-10` returns

```json
{
  "agentId": "a1",
  "month": "2026-10",
  "posts": 12,
  "heldPosts": 0,
  "reads": { "mentions": 40, "thread": 6, "account": 1, "timeline": 0, "users_me": 1 },
  "readsTotal": 48,
  "unitPriceUsd": { "post": 0.01, "read": 0.005 },
  "estimatedUsd": { "posts": 0.12, "reads": 0.24, "total": 0.36 }
}
```

Only counts are stored. `posts` counts `sent` actions by `sentAt`. Each read counts the posts or
users X returned. Reconciliation timeline reads are metered as `timeline`.

### Rate budget

Defaults are 24 posts per rolling 24h (counting `pending`, `sent` and `held`; `rejected` does not
count) and one mention read per 300 s. Override per agent with `POST /internal/quota/:agentId`.
Publishes for one agent are serialised with a Postgres advisory lock, so the budget cannot be
overshot by concurrent requests. X's own 429s are honoured through `x-rate-limit-reset`. The
endpoint is cooled down until the reset, and reads retry once if the wait is 5 s or less. A 429
on publish is a definite rejection.

## Reconciliation (`src/reconcile.ts`)

Every tick (and on `pnpm --filter sender reconcile`):

1. `pending` rows older than max(2 min, 4 x `X_TIMEOUT_MS`) are treated as crashed mid-send and
   become `held`.
2. For each due `held` action, the agent's own timeline (`GET /2/users/:id/tweets`) is read
   between `createdAt - 1s` and `createdAt + 5min` (at most 3 pages).
3. The action settles to `sent` only on a **unique** match:
   - same text after t.co expansion (X's HTML escaping and an auto-prepended `@recipient` are
     tolerated);
   - same `replied_to` parent, and the same `in_reply_to_user_id` when the recipient is known;
   - `created_at` inside the window;
   - authored by the agent, and not already bound to another action.
4. Otherwise the action stays `held`. Checks happen 15 minutes after holding, then hourly, then
   daily after 24 checks. Held actions are never resent and never auto-rejected; an operator can
   inspect them through `sender_actions`.

## How the supervisor should call it

1. Derive a deterministic `actionId` for each intended publication, for example
   `<agentId>:<cycle>:<tool call id>`, and persist it **before** calling publish. On a crash or
   timeout, call publish again with the same `actionId` and body. It is safe to do so.
2. Treat `held` as "maybe published". Do not publish an alternative. Poll the receipt, or wait
   for the next cycle.
3. Treat `rejected` as final and surface `receipt.error` to the brain (policy codes match
   agent-core's `PolicyError` codes).
4. Read mentions at most once per interval. A throttled response still returns the eligible
   items. Resolve every item it decides not to answer (`skip`, `opt_out`, `defer`) so that it
   leaves the queue.
5. Never forward X tokens, raw provider errors or anything from `sender_accounts` to the model.

## Known gaps

- `src/policy-shim.ts` holds verbatim copies of agent-core's `validatePost`,
  `outgoingActionRisk` and `consentCommand`. `@bootr/agent-core` does not yet type-check under
  this app's `NodeNext` resolution because its relative imports have no `.js` extension.
  `test/policy-parity.test.ts` loads the real package at runtime and fails if the copies drift.
  Replace the copies with re-exports once agent-core is NodeNext-clean.
- Media uploads are not supported (text posts and replies only).
- `node dist/index.js` works today. Once the shim re-exports from `@bootr/agent-core` (a raw `.ts`
  package), production must run through `tsx` or a bundler, or agent-core must ship compiled
  output.
