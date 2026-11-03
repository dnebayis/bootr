# Launch v2: custom workers, powers, post-launch control

Decided 2026-11-03 after reviewing agencypad.fun's launch and coin pages. Bootr keeps its scope (an agent that speaks
through its own X account and runs its own treasury) and its design language (`apps/web/DESIGN.md`); it borrows the
shape of agencypad's launch flow, not its feature list. This file is the contract between the three pieces that
implement it: the supervisor API, the launch form, and the coin page.

## Decisions

1. **Launch page order**: 01 Coin (name, ticker, image, links) · 02 Mind (model, grouped by provider, searchable) ·
   03 Kind (Trader, Researcher, Community, **Custom**) with **Powers** and **Cadence** · 04 Character (Instructions,
   plus the job lines) · 05 X account · 06 Fuel & options. A **sticky summary card** on the right (≥ lg; at the end
   of the form on smaller screens) shows image, name, ticker, kind, model, X status, fuel, fee split, the exact cost
   line ("Your wallet pays: launch fee + gas + fuel"), the honest risk line ("The agent can make bad decisions and
   lose money."), and the Launch button. The bottom summary table goes away.
2. **Powers** are agent-core capabilities the creator can switch: `xRead`, `xReply`, `xPublish`, `research`,
   `images` (images are ON in this version). `memory` and `treasury` are **always on** (shown as chips, not
   switches: the fee → fuel loop depends on treasury). Presets show their powers greyed; Custom makes them editable.
3. **Cadence**: minimum spacing between original posts: 30 min, 1 h, 2 h, 4 h, 8 h, 24 h. Bounds 30 min … 7 days.
4. **Character**: the existing Identity text, relabelled *Instructions* (personality, goals, strategy, what it should
   and should not do; 20–600 chars). Custom adds up to 4 **job lines** (≤ 240 chars each) that play the role of the
   presets' `preset.identity` lines; presets show theirs read-only.
5. **Custom worker on-chain**: same mechanism as presets. `workerHash = keccak256(canonical JSON of {id: "custom",
   version: 1, preset})` with `preset = {capabilities, postIntervalMs, identity: jobLines}` (`@bootr/shared/workers`,
   `customWorker()`). The launch form writes the hash into `LaunchParams.workerHash` and saves the preset with the
   draft; the agent card publishes it as `bootr.worker`. The supervisor, failing to find the hash among the presets,
   reads `bootr.worker` from the card, recomputes the hash, applies the preset only if it equals the on-chain
   hash, else falls back to the default template and logs a warning.
6. **Post-launch control** (creator only, wallet-signed): instructions, powers, cadence and model can be changed
   from the coin page. The on-chain hash stays the launch-time commitment; the current configuration lives in the
   supervisor (`revision` increments, every change is an `actions` row). The coin page shows "edited n times". No
   contract or call-policy change is needed (capabilities are off-chain agent behaviour; the session key policy
   is untouched).
7. **Coin page**: status line with the reason (`sleeping · waiting for an X account`, `sleeping · fuel below
   1 USDC`, `awake · posted 12 min ago`, `paused by creator` …); one **activity tape** (posts, replies, fee claims,
   swaps, gas top-ups, sleeps/wakes, config edits) with filters All / Posts / Treasury, replacing "Latest posts";
   a **creator console** panel (only for the creator's wallet) with the editable fields above and the existing Fuel,
   Add gas and Connect X actions. Simpler than agencypad: no mind/thesis/lab panels.

## Images (the `images` power)

`generate_image` is live end to end (2026-11-03). The supervisor pays the relay for one picture from the agent's
spender exactly like a thought (`apps/inference`: chat completion with `modalities: ["image", "text"]` on
`google/gemini-2.5-flash-image`, quoted as the prompt plus a fixed allowance of one image = 1290 output tokens at
$30/M, about 0.043 USDC; `openai/gpt-5-image-mini` is priced too), stores the base64 picture in `sv_images` and
returns an `imageId`; `publish_post` / `publish_reply` take `imageId` and the sender uploads the bytes to X
(`POST /2/media/upload` + alt text via `/2/media/metadata`, scope `media.write`) and posts with `media_ids`. At most
6 images per agent per day. The coin page's activity tape shows "Made an image: <alt>" (kind `image`). Accounts
connected before the `media.write` scope was requested must reconnect to post images.

## Shared contract: `@bootr/shared/workers`

```ts
CAPABILITY_KEYS = ['xRead','xReply','xPublish','research','memory','treasury','images']
ALWAYS_ON_CAPABILITIES = ['memory','treasury']
CAPABILITIES[key] = { label, description, alwaysOn? }          // user-facing copy for the Powers grid
WORKER_BOUNDS = { minPostIntervalMs: 30 min, maxPostIntervalMs: 7 d, maxJobLines: 4, maxJobLineChars: 240 }
CADENCE_OPTIONS = [30 min, 1 h, 2 h, 4 h, 8 h, 24 h]            // ms
CUSTOM_WORKER_ID = 'custom'; CUSTOM_WORKER_VERSION = 1
normalizeWorkerPreset(input): WorkerPreset | null              // trims, forces always-on, checks bounds
customWorker(preset): { id: 'custom', version: 1, preset, hash } // hash as above
workerFromCard(card: unknown): { preset, hash } | null         // reads bootr.worker, re-normalises, re-hashes
```

## Supervisor internal API (HMAC, same scheme as the existing `/internal/*` routes)

- `GET /internal/agents/:id/config` → `{ agentId, kernel, creator, model, instructions, worker: { kind:
  'trader'|'researcher'|'community'|'custom', capabilities, postIntervalMs, jobLines }, workerHash, revision,
  updatedAt }`.
- `PUT /internal/agents/:id/config` body `{ by: <creator address>, instructions?, model?, worker?: {
  capabilities?, postIntervalMs?, jobLines? } }` → validates (bounds; model must be in the admin allow-list the
  web passes as `allowedModels` or the relay's list; `by` must equal the stored creator), updates the stored
  config, bumps `revision`, records an `actions` row `{kind: 'config_updated', fields: [...]}`, returns the new
  config. 409 when nothing changed.
- `GET /internal/agents/:id/activity?limit=50&before=<iso>` → `{ items: [{ at, kind, summary, txHash?, url? }] }`
  merged from `actions` (posts, replies, config edits), `treasuryOps` (claims, swaps, gas), and runtime status
  changes (sleep, wake, pause). Newest first.

## Web

- Launch form: `POST /api/launch/draft` gains `worker: { kind, preset? }` (preset only for custom); agent card
  (`/agents/<id>.json`) gains `bootr.worker` for custom launches; `POST /api/agent/launch` (agent API) accepts
  `worker: 'trader' | 'researcher' | 'community' | { capabilities, postIntervalMs, jobLines }`.
- Coin page: `GET /api/agent/[kernel]/config` and `GET /api/agent/[kernel]/activity` (public reads, proxied to the
  supervisor with the web's `SUPERVISOR_SERVICE_KEY`); `POST /api/agent/[kernel]/config` with a SIWE message
  whose statement is `Update the agent of Bootr coin $SYMBOL (#agentId, kernel).` — the web verifies the signature,
  checks the signer created the coin (indexer), then calls the supervisor's PUT with `by = signer`.
- The web service gets `SUPERVISOR_SERVICE_KEY` (add it to the web service's `environment` and remove it from the
  web `env -u` list in `docker-compose.coolify.yml`; `docs/deploy/coolify.md` env table).
