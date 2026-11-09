# Private key inventory and removal plan (2026-11-08)

The owner asked: "if the private keys are not needed, we must remove them from the server and from the project."
This is a read-only inventory of every private key, signing secret and long-lived credential the Bootr stack
holds, where each one lives, what signs with it and how often, what each on-chain key can do today, and a plan to
take off the server what no running code needs. Nothing was changed; no secret value was read or printed (the
real `.env` files were inspected for variable names only, with `grep -oE '^[A-Z_]+='`).

**Status (2026-11-09):** the owner checked the Coolify environment: none of the deployer, treasury, creator or Basescan variables is set; the only on-chain private key on the server is `ADMIN_PRIVATE_KEY` (plus the two hot keys the supervisor needs, `SESSION_SIGNER_PRIVATE_KEY` and `SPENDER_MASTER_KEY`). Step 1 of section 3.4 is therefore done on the server side; the local `.env`/`.env.mainnet` scrub remains the owner's. Next is step 2 (split the web's supervisor key), then step 3 (the admin key off the server), which must precede the Bounties and Trade contracts.

Sources: `docker-compose.coolify.yml` (which service declares which variable, and the `env -u` strip lists),
each service's zod schema (`apps/supervisor/src/config.ts`, `apps/sender/src/config.ts`,
`apps/inference/src/config.ts`, `apps/indexer/src/lib/env.ts`, `apps/web/lib/server/env.ts`), the code that signs
or authenticates, `packages/contracts/src/*.sol` and `script/*.s.sol`, `docs/deploy/coolify.md`,
`docs/deploy/mainnet.md`, the earlier reviews in this folder, and a scan of `git log -p --all`.

## 1. Inventory

How to read the "receives it" column: Coolify writes every variable of the application into one `.env` and mounts
it into every container; each service's `command` then strips, with `env -u`, the secrets it does not declare, so
"receives it" means the variable reaches that service's main process (pid 1). The container config and a
`docker exec` shell still see the full `.env` (`docs/deploy/coolify.md`, "Secrets stay with their service").

### 1.1 Private keys (secp256k1)

| Variable | Receives it (pid 1) | What signs with it (file:line) | How often at runtime | If absent |
| --- | --- | --- | --- | --- |
| `ADMIN_PRIVATE_KEY` (guardian and launcher owner EOA, `0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3` per `docs/deploy/mainnet.md:358`) | supervisor only (stripped from sender, inference, indexer, web) | `apps/supervisor/src/admin-signer.ts:29-113` (`createLocalAdminSigner`): `guardian.approveSessionKey` :46-57, `revokeSessionKey` :58-63, `revokeAllSessionKeys` :64-69, `revokeAllSessionKeysBatch` :70-75, `EntryPoint.depositTo(kernel)` :92 and `EntryPoint.handleOps` :95-110 (self-bundled enable userOps). Built in `service.ts:21-25`. Callers: `onboarding.ts:663-745` (install), `onboarding.ts:751-766` (rotate: install + revoke the previous permission), `onboarding.ts:829-838` (`rotateExpiringSessionKeys`, scanned every tick from `tick.ts:51`), `api.ts:52-81` (`panic-revoke`), `api.ts:357` and `:370` (`session/install`, `session/rotate` on demand). Also read by the operator script `packages/contracts/script/DeployLauncher.s.sol:28,71-76` (gate wiring, pause of the old launcher). | Per new agent: one `approveSessionKey` tx, one `handleOps` tx, plus a `depositTo` when the kernel's EntryPoint deposit is short of the enable op's prefund (`ENABLE_MODE_MAX_PREFUND_WEI`). Per agent every ~27 days (`SESSION_KEY_VALIDITY_DAYS` 30 minus `SESSION_ROTATE_BEFORE_DAYS` 3): approve + handleOps + revokeSessionKey. On a panic: one batch tx. Nothing per tick otherwise. | Optional in the schema (`config.ts:64`), but production sets `ENABLE_MODE_SELF_BUNDLE=true` (compose default), which requires it (`config.ts:279`): the supervisor would refuse to start. With self-bundle off and no key: new agents stay in `onboarding` forever (`onboarding.ts:792-793`), rotation is skipped silently (`onboarding.ts:830`) and every session key expires 30 days after install, after which no agent can claim fees, swap, or fund its spender; `panic-revoke`, `session/install`, `session/rotate` answer 500. |
| `SESSION_SIGNER_PRIVATE_KEY` (one EOA, its address is public as `NEXT_PUBLIC_SUPERVISOR_SESSION_KEY`) | supervisor only | `service.ts:19` (`privateKeyToAccount`); signs every agent userOp hash in `kernel.ts:244` and the stub signature `kernel.ts:203`. Installed as the ECDSA signer of the permission on every kernel (`onboarding.ts:635`). | Every treasury userOp: the fee policy (`treasury.ts:704-800`: `claim_fees`, `fund_gas`, `swap`, `fund_model`) for each awake agent per tick and each sleeping agent per `REST_CHECK_MS`; the enable userOp at install and rotation; builder-code registration. Tens to hundreds of signatures a day across the fleet. | Required (`config.ts:57`): the supervisor does not start. |
| `SPENDER_MASTER_KEY` (master secret; one spender EOA per agent is derived from it) | supervisor only | `spender.ts:21-34` (`deriveSpenderKey`, `spenderAccount`), `service.ts:38` (`spenderFor`). Signs x402 payments (EIP-3009 `transferWithAuthorization`): relay thoughts and pictures `inference.ts:240-250`, BlockRun direct `blockrun.ts:200-215` and `:565`, paid x402 services `services.ts:163-170`; a dry probe signature in `api.ts:389-397`. | Every paid thought, chat answer, picture and service call: the most frequently used key in the stack. | Required (`config.ts:62`): the supervisor does not start. |
| Per-agent session keys | none as key material | There are no per-agent session private keys. One signer EOA is installed on every kernel as a permission; per agent the supervisor stores only `permission_id`, `validator_data` and `session_policy` in `sv_agents` (`apps/supervisor/src/db/schema.ts:30-34`), in plaintext. These are public on-chain anyway (the enable digest and validator data are emitted by `SessionKeyApproved`). | n/a | n/a. (Losing the rows means re-installing; `installSessionKey` is idempotent per permission id.) |
| `DEPLOYER_PRIVATE_KEY` (Sepolia-era name) / `PRIVATE_KEY` (forge) | no service declares it; the compose file strips it from all five services, which shows it was expected in Coolify's variable set at some point | No runtime code. Operator scripts only: `packages/contracts/script/Deploy.s.sol:75`, `DeployCallPolicy.s.sol:16`, `DeploySwapHelper.s.sol:53`, `DeployLauncher.s.sol:27`, `DeployClankerLauncher.s.sol:77` (`vm.envUint("PRIVATE_KEY")`, `vm.startBroadcast`). | Only at a contract deploy, run from the owner's Mac. | Nothing in production breaks. |
| `PLATFORM_TREASURY_PRIVATE_KEY` (Sepolia-era name) / `CREATOR_PRIVATE_KEY` (mainnet example) | no service declares it; stripped from all five | No runtime code. `packages/contracts/script/Launch.s.sol:25` (the $BOOTR launch was done from the treasury as creator, `docs/deploy/mainnet.md:267`). | Once, at a platform launch. | Nothing in production breaks. The treasury address (`PLATFORM_TREASURY_ADDRESS`) is a plain address in the supervisor; it only needs to receive. |
| Facilitator / payTo keys (`apps/inference`) | none | The relay holds no private key. `INFERENCE_PAYTO_ADDRESS` is an address; settlement is done by the CDP facilitator with `CDP_API_KEY_*` (`apps/inference/src/x402.ts:227-235`). Tests use `generatePrivateKey()` (`app.test.ts:45`). Whose wallet controls `INFERENCE_PAYTO_ADDRESS` is not in the repo. | n/a | n/a |
| BlockRun keys | none | Direct mode has no BlockRun credential: the agent's spender pays each call over x402 (compose comment on `BLOCKRUN_DIRECT_MODE`; `blockrun.ts`). | n/a | n/a |

### 1.2 Symmetric secrets, API keys and tokens

| Variable | Receives it (pid 1) | What uses it (file:line) | How often | If absent / what it unlocks |
| --- | --- | --- | --- | --- |
| `SUPERVISOR_SERVICE_KEY` (HMAC) | supervisor, web | supervisor verifies every `/internal/*` request with it (`api.ts:116`, `hmac.ts:51-61`); web signs calls to the supervisor from `apps/web/lib/server/supervisor.ts` and `app/api/agent/[kernel]/config/route.ts`. | Per request (coin page, creator console saves, approvals, chat). | Supervisor refuses to start (min 32 chars, distinct from the other keys, `config.ts:99,275`). A holder is a full supervisor admin: `panic-revoke`, `session/install`, `session/rotate` (makes the admin key sign), `pause`, `resume`, `tick`, config `PUT`, chat, model migration (`api.ts:118-385`). |
| `SENDER_SERVICE_KEY` (HMAC) | sender, supervisor, web | sender verifies its internal API (`apps/sender/src/auth.ts:71-81`), signs the `/oauth/start` request (`app.ts:123`) and receipts (`receipt.ts:38`); supervisor `SenderClient` (`service.ts:32`); web for X connect. | Per post, read, mention poll, receipt. | Sender fails closed at start. A holder can post and read as any connected X account through the sender, start OAuth bindings and forge receipts. |
| `INDEXER_SERVICE_KEY` (HMAC) | indexer, supervisor, web | indexer verifies `/internal/agent/:kernel/social` (`apps/indexer/src/api/index.ts:1002`) and signs `GET /api/admin/config` (`lib/admin-config.ts:19-24`); web verifies that GET (`lib/server/env.ts:70-77`); supervisor `IndexerClient` (`service.ts:33`). | Per social write and per admin-config read. | Indexer cannot read the admin config; supervisor cannot push social data. Low power. |
| `SESSION_SECRET` (HMAC) | web | admin console session tokens after SIWE (`apps/web/lib/server/session-core.ts:44-63`), approval review tokens (`app/api/agent/[kernel]/approvals/review.ts:63`). | Per admin request. | Admin console unusable. A holder can forge an admin session for any address in `ADMIN_ADDRESSES`; rotating it logs every admin out (`server-state.ts:10`). |
| `ADMIN_CONSOLE_SLUG` | web | hides the console path (`app/console-admin/page.tsx:9`). | Per request. | Not a key; obscurity only. |
| `SENDER_ENCRYPTION_KEY` (AES-256-GCM, 32 bytes) | sender only | `apps/sender/src/crypto.ts:13-48`; encrypts X access and refresh tokens and PKCE verifiers at rest (`accounts.ts:41-131`, `rebind.ts:72-81`, `oauth.ts:121,157`), AAD-bound per agent. | Every X call (decrypt the access token) and every refresh. | Sender does not start. Rotating it orphans every stored X token (every creator must reconnect); there is no key id (review L-2). |
| `X_CLIENT_SECRET` (X OAuth app) | sender only | token exchange and refresh with HTTP basic auth (`apps/sender/src/oauth.ts:179`). | Per OAuth callback and per refresh (X access tokens are short-lived). | No new connections; refreshes fail and accounts get marked revoked over the following hours. |
| Per-agent X OAuth tokens | Postgres (sender tables), encrypted | see `SENDER_ENCRYPTION_KEY`. | n/a | A holder of the DB plus the encryption key can post as every connected account. |
| `OPENROUTER_API_KEY` | inference only | upstream calls (`apps/inference/src/main.ts:41`). | Every relay call: pictures today, thoughts only when `BLOCKRUN_RELAY_FALLBACK` is on. | Relay starts but every call fails upstream; direct-mode thoughts unaffected; pictures stop. Spends OpenRouter credit. |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | inference only | x402 facilitator auth (`apps/inference/src/x402.ts:227-235`, `createFacilitatorConfig`). | Every verify and settle (per paid call). | On mainnet the schema requires them for the CDP facilitator (`config.ts:63-70`): the relay does not start. They also authenticate to the owner's CDP account (RPC, paymaster, other products). |
| Keyed URLs: `BASE_RPC_URL`, `BUNDLER_URL`, `INFERENCE_RPC_URL`, `INDEXER_BLOCKS_RPC_URL`, `BASE_RPC_FALLBACK_URL`, `ENABLE_MODE_*_URL` | per compose blocks (RPC: supervisor, indexer, web; bundler: supervisor) | the API key is part of the URL; every chain read and every userOp submission. | Constant. | Reads fail or fall back. A leaked URL burns the provider quota; no funds. Logs scrub URLs since 2026-11-08 (`fixes-2026-11-08.md` item 8). |
| `TELEGRAM_BOT_TOKEN` | supervisor only | `apps/supervisor/src/telegram.ts:55-65` (in every Bot API URL). | Per notification and per long poll. | Only the console inbox works. A holder can message creators as the bot and read what they send it. |
| `SEARCH_API_KEY` (Brave) | supervisor only | `broker/index.ts:343-344`. | Per `search_web` tool call. | The tool reports itself unavailable. Quota only. |
| `PINATA_JWT` | web only | `apps/web/lib/server/ipfs.ts:151-153`, `app/api/upload/route.ts:43`, `app/api/agent/launch/route.ts:168`, `app/api/coin/[id]/image/route.ts:94`. | Per image or metadata pin (launches). | Uploads answer 503; coins cannot launch with an image. A holder can pin and unpin on the Pinata account. |
| `SERVICE_PASSWORD_POSTGRES` | postgres, sender, inference, indexer, supervisor (inside `DATABASE_URL`) | database access. | Constant. | Everything stops. A holder reads every table: agent state, encrypted X tokens, inference receipts, Telegram links. Daily `pg_dump` copies sit in `/root/backups` on the box (`coolify.md:165-171`). |
| `BASESCAN_API_KEY` | none (stripped from all five) | `packages/contracts/foundry.toml:22-23` for `--verify`. | Only at a deploy. | Nothing. |
| Coolify API token | the host: `/root/.coolify-token` (mode 600, `coolify.md:14`); GitHub Actions secret `COOLIFY_DEPLOY_TOKEN` (`.github/workflows/images.yml:145`) | `scripts/switch-launcher.sh` prints `curl` calls that read it; the workflow's deploy step. | Per launcher switch; per push to main. | Deploys become manual. A holder of a full-permission token can read every environment variable above through the Coolify API and redeploy: it is the master key of the server. |
| `GITHUB_TOKEN` (Actions) | CI only, ephemeral | GHCR push (`images.yml:72`). | Per build. | Images do not publish. |
| Owner's SSH key for root on the box; Hermes agent (`/root/.hermes`, Anthropic OAuth, runs as root, `coolify.md:20`; its Telegram bot `@bootrhermesbot`) | the host | root on the box reads `/data/coolify/applications/<uuid>/.env`, every container's config and the backups. | On demand. | Root is everything. Hermes is an LLM with root: any instruction that reaches it is a path to every secret in this table. |

### 1.3 Where the variable names appear in env files (names only)

| Name | `.env.example` | `.env.mainnet.example` | real `.env` (Mac, 2026-10-28, mode 600) | real `.env.mainnet` (Mac, 2026-10-29, mode 600) |
| --- | --- | --- | --- | --- |
| `ADMIN_PRIVATE_KEY` | yes | yes | yes | yes |
| `SESSION_SIGNER_PRIVATE_KEY` | yes | yes | yes | yes |
| `SPENDER_MASTER_KEY` | yes | yes | yes | yes |
| `DEPLOYER_PRIVATE_KEY` | yes | no | yes | no |
| `PRIVATE_KEY` (forge deployer) | no | yes | no | yes |
| `PLATFORM_TREASURY_PRIVATE_KEY` | yes | no | yes | no |
| `CREATOR_PRIVATE_KEY` | no | yes | no | yes |
| `SENDER_ENCRYPTION_KEY`, `SENDER_SERVICE_KEY`, `SUPERVISOR_SERVICE_KEY`, `INDEXER_SERVICE_KEY`, `SESSION_SECRET` | yes | yes | yes | yes |
| `X_CLIENT_SECRET`, `OPENROUTER_API_KEY`, `PINATA_JWT`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `BASESCAN_API_KEY` | yes | yes | yes | yes |
| `TELEGRAM_BOT_TOKEN` | yes | no | no | no |
| `SEARCH_API_KEY` | yes | yes | no | yes |

Both real files are ignored by `.gitignore` (`.env`, `.env.*` except the two examples) and were never committed:
`git log --all --diff-filter=A -- .env .env.mainnet '*/.env' ...` returns nothing. Whether their values are
real keys or placeholders was not checked (values were not read). The owner's memory notes say the local
`OPENROUTER_API_KEY` differs from the production one.

### 1.4 Key material in git history

A scan of `git log -p --all` (all branches, `pnpm-lock.yaml` and `brand/` excluded) for `0x` + 64 hex next to
key-like words, `sk-or-v1-`, `BEGIN ... PRIVATE KEY`, JWT shapes and common cloud token prefixes found no real
key. Every hit is a test fixture or a constant, by file (commit of first appearance):

- Anvil's published default accounts (never secret): `apps/supervisor/test/blockrun-fork.test.ts` (fcdad169fa),
  `apps/supervisor/test/blockrun-live-check-fork.test.ts` (ac3fcbeef0), `apps/supervisor/test/helpers.ts`
  (071d0727df), `apps/supervisor/test/services-fork.test.ts` (9379dc8876), `apps/web/app/api/agent/refusals.test.ts`
  (830f32767e), `apps/web/e2e/agent-api.spec.ts` (678d1853a1), `apps/web/lib/server/siwe-verify.test.ts`
  (8ef20bff4e), `apps/web/lib/swap/swap.fork.test.ts` (b87f0492d4), `packages/sdk/src/client.test.ts` (9d4a4d1d3c).
- Three high-entropy test keys in `apps/supervisor/test/helpers.ts` (`SESSION_PK`, `ADMIN_PK`, `SPENDER_MASTER`;
  commits 071d0727df and 92205ecf87, 2026-10-27) and one in `apps/web/app/api/agent/refusals.test.ts`
  (830f32767e, 2026-11-05). They are used as test fixtures. I could not confirm that they were never used on a
  live chain (section 4); deriving their addresses and checking balances is a one-minute job for the owner.
- `packages/contracts/src/AgentGuardian.sol` (071d0727df): two 32-byte constants that are EIP-712 type hashes, not
  keys.
- `packages/agent-core/src/social/disclosure-policy.test.ts` (3e43c35523, adb7fa3d39): the strings
  `sk-or-v1-...notarealkey...` and `-----BEGIN PRIVATE KEY-----` as inputs of the disclosure filter test.
- `apps/web/lib/skill/skill-md.ts:114`: `privateKeyToAccount(process.env.BOOTR_WALLET_KEY)` is example code inside
  the generated SKILL.md text for users' own agents; the web never holds such a key.
- Foundry `broadcast/` output is git-ignored and never appeared in history.

## 2. On-chain powers of each key, today

Deployed set (Base mainnet, `packages/shared/src/addresses.ts:185-205`, `docs/deploy/mainnet.md`): AgentGuardian
`0x799Ab875294E37839883D12084aB4BE3f7633630`, BootrLauncher v3 `0x62c038dA8A409ad1CD811df980A6F9867cd453fd`
(current), BootrClankerLauncher `0x387f1B0aC128D534E822c344D829645336BDAbbB`, BootrLaunchGate
`0x7ddaf2A1FC0861B288c7b0BDfA8314621C47c3a5`, the paused launchers v1, v1.1 and v2, BootrCallPolicy, BootrSwapHelper,
BuybackBurner implementation and its clones. None of them is upgradeable (`mainnet.md:308`); owner functions are
`Ownable2Step`, so ownership can move to a hardware wallet or a Safe without a redeploy.

### 2.1 `ADMIN_PRIVATE_KEY` (owner of guardian, launchers and gate)

| Contract and function | What it does | Hot or cold |
| --- | --- | --- |
| `AgentGuardian.approveSessionKey(kernel, permissionId, validatorData)` (`AgentGuardian.sol:187-201`) | Approves any validator data for any registered kernel. With `[SudoPolicy, ECDSASigner(attacker)]` it installs an unrestricted session on a kernel and can drain it; the guardian does not pin a policy template (review C-03, `mainnet.md:321-324`). | Hot: per install and per rotation. |
| `AgentGuardian.revokeSessionKey`, `revokeAllSessionKeys`, `revokeAllSessionKeysBatch` (`:215-253`) | Uninstalls or invalidates session permissions; the panic path. | Hot on a panic, otherwise per rotation (revoke of the previous permission). |
| `AgentGuardian.revokeSessionKeyApproval` (`:203`) | Withdraws an approved digest. | Cold; no caller in `apps/`. |
| `AgentGuardian.setLauncher`, `setPlatformTreasury` (`:146-156`) | Which launcher may register agents (the gate today); where dormant sweeps go. | Cold; deploy-time wiring only. |
| `AgentGuardian.claimDormant(kernel, extraTokens)` (`:255`) | Sweeps a kernel idle for `dormancyPeriod` (90 days) to `platformTreasury` and burns its coin. | Cold; no caller in `apps/`. |
| `EntryPoint.depositTo(kernel)` and `handleOps` (as a plain EOA) | Pays a kernel's prefund and bundles enable-mode ops itself. | Hot: per install and rotation. |
| `BootrLauncher` / `BootrClankerLauncher`: `setDefaults`, `setMinPlatformBps`, `setLaunchFee`, `setPlatformLpFeeBps`, `setMevModule`, `pause`, `unpause` (`BootrLauncher.sol:224-247`, `BootrClankerLauncher.sol:241-277`) | Fee presets, launch fee, MEV module, intake stop. The admin console's "Launch fee" panel sends `setLaunchFee` from the admin's browser wallet (`apps/web/components/console/ConsoleView.tsx:283-304`), which only works if that wallet is the owner. | Cold. |
| `BootrLaunchGate.addLauncher`, `removeLauncher` (`BootrLaunchGate.sol:31-45`) | Which launchers may register agents. | Cold; `DeployLauncher.s.sol:71-76` runs them at a launcher switch. |
| `BuybackBurner.swapAndBurn` on every clone: `keeper() == Ownable(launcher).owner()` (`BuybackBurner.sol:102-116`) | Swap a burner's WETH into the coin and burn it. | Cold; no caller in `apps/`. |
| Upgrade rights | None today. The design notes for Trade and Payouts (commits 9b2dd0c, 0dacf79) make this same admin wallet the upgrade key of UUPS proxies with no timelock. If that ships before the key leaves the server, a hot server key would also be able to replace contract code. | Future. |
| `pauseAgent` / `unpauseAgent` | Creator-only (`AgentGuardian.sol:322-337`), not the admin. | n/a |

Hot for the running service: `approveSessionKey`, `revokeSessionKey`, `depositTo`, `handleOps` (and the revoke
batch for a panic). Everything else is used by the operator a few times a month at most.

### 2.2 `SESSION_SIGNER_PRIVATE_KEY`

One EOA, installed as a ZeroDev permission on every kernel with: `BootrCallPolicy` (claims from the RWAGMI locker or
the Clanker lockers to the kernel, `WETH.approve(swapHelper)` + `swapWethToUsdc`, `USDC.transfer(spender, n)` under
`SESSION_USDC_TRANSFER_CAP` 50 USDC per 24 h window, WETH withdraw for gas), `GasPolicy` 0.1 ETH cumulative,
`RateLimitPolicy` 100,000 ops lifetime, `TimestampPolicy` 30 days; ERC-1271 is refused (`kernel.ts:16`,
`onboarding.ts:604-645`). A leak moves at most the cap per agent per window into spenders the attacker does not
control, plus swap slippage, plus each kernel's gas allowance. Always hot. Revoked fleet-wide by the admin key.

### 2.3 `SPENDER_MASTER_KEY`

Derives one plain EOA per agent (`spender.ts:9-14`). No on-chain role; each spender holds a USDC float the fee
policy tops up to `SPENDER_TARGET_USDC` (20 USDC) when it drops under `SPENDER_MIN_USDC` (5), never above the window
budget. A leak of the master exposes every float (about 20 USDC x agents) and whatever the session keys refill until
they are revoked. Always hot. Note for rotation: the spender address is baked into each agent's call-policy rule
(`onboarding.ts:628`), so a new master means a session-key re-install on every agent, signed by the admin key.

### 2.4 Deployer (`PRIVATE_KEY` / `DEPLOYER_PRIVATE_KEY`)

No on-chain role after a deploy: every script hands ownership to `PLATFORM_ADMIN` and the admin accepts
(`mainnet.md:154-165`). It holds leftover ETH for the next deploy (about 0.02 ETH budgeted, `mainnet.md:86`).
Entirely cold.

### 2.5 Treasury / creator key (`PLATFORM_TREASURY_PRIVATE_KEY` / `CREATOR_PRIVATE_KEY`)

Receives the platform's fee slot payouts (RWAGMI locker slot, Clanker reward recipient), the launch fees, and the
proceeds of `claimDormant`; as creator of the platform coin it holds `pauseAgent` / `unpauseAgent` on the $BOOTR
kernel and its creator fee claims. It is the wallet with the money. Entirely cold; nothing on the server needs it.

## 3. Removal plan, ranked by risk reduction per effort

### 3.1 Keys that can leave the server entirely (no runtime path signs with them)

**A. Deployer, treasury/creator, Basescan (`DEPLOYER_PRIVATE_KEY`, `PRIVATE_KEY`, `PLATFORM_TREASURY_PRIVATE_KEY`,
`CREATOR_PRIVATE_KEY`, `BASESCAN_API_KEY`).** Zero code paths in `apps/` read them; the compose file strips them
from every service, which means Coolify was expected to hold them. Steps: open the application's Environment
Variables in Coolify and delete any of these names that are set; redeploy nothing (pid 1 never saw them; the
container config and `.env` on disk do); then confirm with `grep -c '^DEPLOYER_PRIVATE_KEY=' /data/coolify/applications/<uuid>/.env`
= 0 as root. Keep the values in a password manager or, better, on a hardware wallet for the deployer and the
treasury (both are only ever used from the Mac with `forge script` / `cast send`, which take `--ledger`). Nothing
breaks. Effort: half a day, including moving the treasury balance to a fresh hardware-backed address if the old key
was ever on a server or in a shared file (the treasury address is an env value and a guardian setter, so it can
change: `guardian.setPlatformTreasury`, the launcher presets' recipient via `setDefaults`, `PLATFORM_TREASURY_ADDRESS`).

**B. `ADMIN_PRIVATE_KEY`.** The only hot uses are `approveSessionKey` + enable-op bundling at install and
rotation, the per-rotation `revokeSessionKey`, and the panic batch. Three ways to take it off the box:

1. *Operator-run CLI on the Mac, supervisor prepares, operator signs.* The supervisor already stores the pending
   permission before confirming it and skips the admin tx when the digest is already approved
   (`onboarding.ts:664-700`), so the pieces exist. Work: (a) a `pending approvals` list: agents in `onboarding`
   without `sessionKeyInstalledAt`, plus agents whose `sessionValidUntil` is inside the rotation window, each with
   kernel, permission id, validator data and the expected digest (`enableDigest`); exposed on `/internal/*` and
   pushed to the owner on Telegram; (b) `installSessionKey` and `rotateSessionKey` split into "prepare" (no admin)
   and "finish" (reads `approvedEnableDigests`, sends the enable op); (c) the enable op goes through
   `ENABLE_MODE_BUNDLER_URL` (ZeroDev accepts enable mode, `config.ts:39-46`) instead of self-bundle, or the CLI also
   sends `handleOps` after the approval; the kernel pays its own prefund (self-funded gas) so `depositTo` by the
   admin is only needed for kernels with no gas, which the install already waits for (`onboarding.ts:796-803`);
   (d) a small CLI (`bootr-admin approve|rotate|revoke-all|deposit`) signing with a hardware wallet or the macOS
   keychain, never a file. Operational change: a new agent is live only after the owner approves (minutes to
   hours instead of one tick); rotation becomes a weekly batch, so raise `SESSION_ROTATE_BEFORE_DAYS` from 3 to
   7-10 so one missed week does not expire keys; `panic-revoke` becomes a CLI command (one `revokeAllSessionKeysBatch`
   tx), which is fine because today it also needs the operator to call the endpoint. Effort: 3-5 days including
   tests on Sepolia.
2. *Pre-signed batch.* Not workable: the approval digest depends on the kernel's current nonce and a permission id
   chosen at install, and the admin EOA's own nonce fixes the order, so approvals cannot be signed ahead for
   unknown agents. Only `revokeAllSessionKeysBatch(kernels)` could be pre-signed, and it would go stale as agents
   are added. Skip.
3. *Remote signer behind `AdminSigner`.* `admin-signer.ts:5-6` was written for a KMS or HSM swap. The key is
   then not on disk, but a credential that can ask the signer to sign anything is, so misuse by a compromised
   supervisor is unchanged; only exfiltration is prevented. 2-3 days plus a provider. Worth it only as a stopgap if
   option 1 waits.

Also move the cold powers off the key regardless of 1-3: `transferOwnership` of the guardian, both live launchers,
the paused launchers and the gate to a hardware wallet (or a Safe) and `acceptOwnership` from it (`Ownable2Step`;
the burner keeper follows the launcher owner automatically). Because `approveSessionKey` is `onlyOwner`, the owner
and the approver are the same key until the guardian gains an installer role, so this move and option 1 go
together: the server stops holding the owner key, the owner key signs approvals from the Mac. Effort: half a day
of transactions (one `transferOwnership` + `acceptOwnership` pair per contract: guardian, the two live launchers,
the gate, and the three paused launchers) on top of option 1.

Longer term (closes C-03 for good): the next guardian release, or the upgradeable Trade/Payouts contracts, should
split `owner` (cold, Safe) from an `installer` that can only approve digests built from an owner-pinned policy
template. Then an installer key can be hot again with little power. Until then, do not make the admin wallet the
upgrade key of anything while it is on the server.

### 3.2 Keys that must stay hot, and how to shrink their blast radius

| Key | Why it stays | Shrink |
| --- | --- | --- |
| `SESSION_SIGNER_PRIVATE_KEY` | Signs every treasury op. | Caps already bound it (50 USDC/day/agent to the agent's own spender, 0.1 ETH gas, 30-day validity). Next steps in order: alert on `SessionKey*` and unexpected userOps from the indexer; rotate the signer itself on a schedule (a rotation installs a fresh permission, so a signer change is one rotation pass, admin-signed); later, per-agent signers held by a policy-enforcing signer service (review H-02). Rotate it now once if it was ever in a shared file or the Sepolia `.env`. |
| `SPENDER_MASTER_KEY` | Signs every x402 payment. | Keep floats small (`SPENDER_TARGET_USDC` 20); lower `SESSION_USDC_TRANSFER_CAP` if 50/day is more than agents spend; rotation needs one session re-install per agent (admin), so schedule it with the admin batch of 3.1-B. Direct-mode BlockRun calls add no new key. |
| `SUPERVISOR_SERVICE_KEY` | Web must read config and activity. | The web is a public process holding a full-admin key. Give the web its own read-mostly key: a second variable (`SUPERVISOR_WEB_KEY`) accepted only on the config, activity, fuel, approvals, notifications and chat routes, and keep `SUPERVISOR_SERVICE_KEY` for `panic-revoke`, `session/*`, `tick`, `pause`, `resume`, model routes, held by the operator only. About one day; `hmacAuth` already takes the key per route group (`api.ts:116`). |
| `SENDER_SERVICE_KEY`, `INDEXER_SERVICE_KEY` | Service-to-service HMAC. | Already per service; rotation is an env change plus restart. Rotate on any suspicion. |
| `SENDER_ENCRYPTION_KEY`, X tokens | Sender must decrypt per call. | Add a key id to the ciphertext (`v1.` prefix exists in `crypto.ts:10`) so a new key can be introduced and old rows re-encrypted at next refresh (review L-2). Half a day. |
| `X_CLIENT_SECRET`, `OPENROUTER_API_KEY`, `CDP_API_KEY_*`, `PINATA_JWT`, `TELEGRAM_BOT_TOKEN`, `SEARCH_API_KEY` | Provider credentials. | Each is already scoped to one service. Set spend limits at the provider (OpenRouter credit, CDP, Brave), use a Pinata key with `files:write` only (`ipfs.ts:6`), and keep a rotation note per key. |
| `SERVICE_PASSWORD_POSTGRES` | Every service. | The daily dumps in `/root/backups` hold the whole database in clear (X tokens are encrypted inside it, the rest is not); encrypt the dump with a key the box does not hold (`age` with the owner's public key) before copying it off. Half a day. |
| Secrets at rest on the box | Coolify writes one `.env` for the application and mounts it everywhere. | The `env -u` lists keep pid 1 clean but root, `docker inspect` and `docker exec` see everything. Options: (1) read the three supervisor keys from files (`*_FILE` variables pointing at a root-only path mounted into the supervisor only) with a 20-line change in `config.ts`; compose `secrets:` would do the same if Coolify's compose handling passes them through (not verified); (2) restrict what runs as root: Hermes has root and an LLM in the loop, so either run it as a user without access to `/data/coolify` and `/root/backups`, or accept that any instruction injected into Hermes can read every key. |
| Coolify API token, `COOLIFY_DEPLOY_TOKEN` | Deploys. | Use a deploy-scoped token in GitHub if Coolify's token permissions allow it (check in Keys & Tokens), keep the root token on the box only, and treat its rotation as part of any incident. |

### 3.3 Keys in the project folder on the Mac

`/Users/mehmet/Desktop/OnchainPrimitive/.env` (Sepolia era, 2026-10-28) and `.env.mainnet` (2026-10-29) both carry
every private key name and every API secret name, mode 600, never committed. Whether the values are real was not
checked. Recommended:

- Delete the private-key lines from both files (`ADMIN_PRIVATE_KEY`, `SESSION_SIGNER_PRIVATE_KEY`,
  `SPENDER_MASTER_KEY`, `DEPLOYER_PRIVATE_KEY`, `PRIVATE_KEY`, `PLATFORM_TREASURY_PRIVATE_KEY`, `CREATOR_PRIVATE_KEY`)
  and keep the address lines. Nothing in the repo runs against production from these files; the services get their
  env from Coolify.
- Keep the values in a password manager and load them at call time only: `PRIVATE_KEY=$(op read ...) forge script ...`,
  or `forge script --ledger` / `cast send --ledger` for the deployer and admin, which never puts the key in a process
  environment at all. `docs/deploy/mainnet.md:132` already says "exported for the command only"; make that the only
  way.
- API secrets (`OPENROUTER_API_KEY`, `PINATA_JWT`, `X_CLIENT_SECRET`, `CDP_*`, `SEARCH_API_KEY`) in the local files
  should be local test keys, not the production ones; if any production value is in them, rotate it at the
  provider.
- If any of the keys in these files were also pasted into Coolify (the admin, signer and spender keys were, by
  design), assume the Mac file and the server share the same material and plan the rotation together (3.4).
- Test fixtures in `apps/supervisor/test/helpers.ts` and `apps/web/app/api/agent/refusals.test.ts` are fine to keep
  once the owner has confirmed their addresses never held funds.

Effort: half a day.

### 3.4 Recommended order

| # | Step | Size | What it removes |
| --- | --- | --- | --- |
| 1 | Delete deployer, treasury/creator and Basescan variables from Coolify if present; scrub key lines from `.env` and `.env.mainnet`; move the deployer and the treasury to hardware-backed addresses (treasury address change via `setPlatformTreasury`, `setDefaults`, `PLATFORM_TREASURY_ADDRESS`). | 0.5-1 day | The two keys that hold or can receive real money and have no reason to be near the server. |
| 2 | Split the supervisor HMAC key (web gets a read-mostly key); check the Coolify token scopes; encrypt the DB dumps with an off-box key. | 1-1.5 days | A public web process as supervisor admin; cleartext backups. |
| 3 | Admin key off the server: pending-approvals queue, prepare/finish split, enable ops through the ZeroDev bundler, `bootr-admin` CLI with a hardware wallet, `SESSION_ROTATE_BEFORE_DAYS` 7-10, `transferOwnership` of guardian, launchers and gate to the hardware wallet, `ENABLE_MODE_SELF_BUNDLE=false`, then remove `ADMIN_PRIVATE_KEY` from Coolify and from the compose `environment` block. Rehearse on Sepolia. | 3-5 days | The one key that can drain every kernel (C-03) and, if the Trade/Payouts design ships as written, replace contract code. |
| 4 | Rotate what the Mac and the server shared: `SESSION_SIGNER_PRIVATE_KEY` and `SPENDER_MASTER_KEY` (one session re-install per agent, approved in a single CLI batch from step 3; fund the new spenders, let the old ones drain), the three HMAC keys, `SESSION_SECRET`, `SENDER_ENCRYPTION_KEY` once it has a key id. | 1 day plus the re-install pass | Any copy that ever sat in a file on the Mac, in the Sepolia `.env`, or in a chat. |
| 5 | Supervisor keys from root-only files (or compose secrets if Coolify passes them); Hermes without read access to `/data/coolify` and `/root/backups`. | 1 day | Every-process and root visibility of the hot keys on the box. |
| 6 | Guardian installer role with a pinned policy template (next contract release, or in the upgradeable set), owner to a Safe; per-agent signers in a signer service. | later, 1-2 weeks | Makes any remaining hot key low-power. |

Steps 1 and 2 need no code beyond one HMAC route split and change nothing for creators. Step 3 is the one that
changes the product: an agent goes live when the owner approves, not within a minute of the launch. If that wait is
not acceptable, option 3.1-B.3 (remote signer) keeps the automation and still gets the key off the disk, at the cost
of not fixing misuse.

## 4. What I could not verify

- Which variables are actually set in Coolify today (no server access from this session). The compose `env -u` lists
  name `DEPLOYER_PRIVATE_KEY`, `PLATFORM_TREASURY_PRIVATE_KEY` and `BASESCAN_API_KEY`, which suggests they were set;
  `docs/security/fixes-2026-11-08.md` item 8 says they are dropped from every service, not that they are absent.
- Whether the values in the Mac's `.env` and `.env.mainnet` are real production keys, Sepolia keys or placeholders
  (by instruction the files were read for names only), and whether any of them equals a value in Coolify.
- That the admin EOA in Coolify is the owner `0x2C97C20FAD740cCf60d4Eeb54260F3BFE899D9b3`: `docs/deploy/mainnet.md:87`
  says `PLATFORM_ADMIN` is `ADMIN_PRIVATE_KEY` on the supervisor, and the console's `setLaunchFee` panel implies the
  same key is also in a browser wallet. If so, the owner key exists in at least two places today.
- Whether the four high-entropy test keys in `apps/supervisor/test/helpers.ts` and
  `apps/web/app/api/agent/refusals.test.ts` were ever funded or used outside tests (derive the addresses and check).
- The wallet behind `INFERENCE_PAYTO_ADDRESS` and the Clanker fee-locker recipient: not in the repo.
- Whether Coolify's compose handling honours `secrets:` or per-service `env_file`, and whether its API tokens can be
  scoped to deploy only (both decide the shape of step 5 and the GitHub token in step 2).
- Where Hermes keeps its Telegram bot token and Anthropic OAuth credential on the box (`/root/.hermes` per the docs),
  and whether the daily backups have left the box yet (`coolify.md:171` says not yet as of writing).
- GitHub repository secrets other than `COOLIFY_DEPLOY_TOKEN` and the build-time `vars.*`, and whether any CI run ever
  printed an environment.
- The exact behaviour of ZeroDev's bundler for enable-mode ops under the current call-policy layout, which step 3
  relies on instead of self-bundling (`config.ts:39-46` says ZeroDev accepts it; CDP's does not).
