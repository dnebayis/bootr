import { NextResponse, type NextRequest } from 'next/server';
import { encodeFunctionData, erc20Abi, keccak256, parseEther, parseUnits, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { entryPointAbi } from '@/lib/gas';
import { ipfsGatewayUrl, UPLOAD_MAX_BYTES } from '@/lib/ipfs';
import { agentCardUrl, contractUriUrl } from '@/lib/agent-card';
import { checkLinks } from '@/lib/coin-link-rules';
import { clankerTokenMetadata } from '@/lib/contract-metadata';
import { CLANKER_PATHS, clankerPath, contracts, USDC_DECIMALS } from '@/lib/contracts';
import { mineLaunchSalt, SaltMiningError, type MinedSalt } from '@/lib/clanker-v5';
import { launchValue, mockDevBuyQuote, pinsOf, quoteDevBuy, readLaunchTerms, V5LaunchRefused, type DevBuyQuote, type V5LaunchTerms } from '@/lib/v5-launch';
import type { LaunchSource } from '@/lib/types';
import { addresses } from '@bootr/shared/addresses';
import { chainAddresses } from '@/lib/chains';
import { env } from '@/lib/env';
import { WORKER_TEMPLATES } from '@/lib/launch';
import { CUSTOM_WORKER_ID, customWorker, normalizeWorkerPreset, WORKER_BOUNDS } from '@bootr/shared/workers';
import { clankerLauncherV5Abi, defaultsFromTuple, fallbackDefaults, launcherAbi, type LaunchDefaultsTuple } from '@/lib/abi/launcher';
import {
  contractSettingsJson,
  DEFAULT_DEV_BUY_SLIPPAGE_PCT,
  FALLBACK_V5_BOUNDS,
  launchStringProblems,
  LAUNCH_KIND_ID,
  MAX_DEV_BUY_SLIPPAGE_PCT,
  minDevBuyOutFrom,
  parseSlippagePct,
  parseTokenSettings,
  toContractSettings,
  type ContractTokenSettings,
} from '@/lib/token-settings';
import { filterAllowedModels, RECOMMENDED_MODEL } from '@/lib/models';
import { readConfig } from '@/lib/server/admin-config';
import { serverPublicClient } from '@/lib/server/chain';
import { pinataEnv } from '@/lib/server/env';
import { fetchImageFromUrl } from '@/lib/server/image-fetch';
import { relayModels } from '@/lib/server/relay-models';
import { clientIp, PinError, pinFile, RateLimiter, sha256Hex, sniffImage, svgProblem } from '@/lib/server/ipfs';
import { MAX_IDENTITY_CHARS, MIN_IDENTITY_CHARS, normalizeIdentity, normalizeSource, saveDraftIdentity, type DraftWorker } from '@/lib/server/launch-drafts';
import { NEW_NONCE, quoted, rateLimitMessage, readJsonObject } from '@/lib/server/refusals';
import { verifySiwe } from '@/lib/server/siwe-verify';

const NO_STORE = { 'Cache-Control': 'no-store' };
const limiter = new RateLimiter(5, 60_000);
const STATEMENT = /^Prepare a Bootr launch\.$/;
const FEE_FALLBACK_WEI = 500_000_000_000_000n; // 0.0005 ETH, the value read from the mainnet launcher on 2026-10-29
const GAS_DEFAULT_ETH = '0.001';
const GAS_MIN_ETH = '0.0001';

type LaunchInput = {
  name?: unknown;
  symbol?: unknown;
  identity?: unknown;
  image?: { url?: unknown; dataUrl?: unknown } | unknown;
  model?: unknown;
  worker?: unknown;
  buyback?: unknown;
  fuelUsdc?: unknown;
  devBuyEth?: unknown;
  gasEth?: unknown;
  xHandle?: unknown;
  links?: unknown;
  launchThrough?: unknown;
  /** Clanker v5 only: the token settings (lib/token-settings.ts `parseTokenSettings`). */
  token?: unknown;
  /** Clanker v5 only: the dev buy's slippage tolerance in percent (default 3): the signed minimum is the quote less this. */
  devBuySlippagePct?: unknown;
};

function fail(status: number, error: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
}

const DECIMAL = /^\d+(\.\d+)?$/;

type ResolvedWorker = { id: string; hash: Hex; draft: DraftWorker };

/** `worker` from the request: a template id (default community), or a custom preset; null when neither is acceptable. */
function resolveWorker(input: unknown): ResolvedWorker | null {
  if (input === undefined || typeof input === 'string') {
    const t = WORKER_TEMPLATES.find((w) => w.id === (input ?? 'community'));
    return t ? { id: t.id, hash: t.hash, draft: { kind: t.id } } : null;
  }
  const preset = normalizeWorkerPreset(input);
  if (!preset) return null;
  const custom = customWorker(preset);
  return { id: custom.id, hash: custom.hash, draft: { kind: CUSTOM_WORKER_ID, preset } };
}

const IMAGE_SHAPE = 'image is required: {url} (a public https URL) or {dataUrl} (data:image/<type>;base64,<data>).';

/** The image, from an https URL (fetched here, ≤ 2 MB) or a data: URL; checked by its bytes like the form upload. */
async function loadImage(image: unknown): Promise<{ bytes: Uint8Array; type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml' } | { error: string }> {
  if (!image || typeof image !== 'object') return { error: IMAGE_SHAPE };
  const { url, dataUrl } = image as { url?: unknown; dataUrl?: unknown };
  let bytes: Uint8Array;
  if (typeof dataUrl === 'string') {
    const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return { error: 'image.dataUrl must be data:image/<type>;base64,<data>, with a lowercase type and no line breaks.' };
    bytes = Uint8Array.from(Buffer.from(m[2], 'base64'));
  } else if (typeof url === 'string') {
    // Public https hosts only, redirects checked hop by hop, the body streamed under the 2 MB cap (lib/server/image-fetch.ts).
    const fetched = await fetchImageFromUrl(url, UPLOAD_MAX_BYTES);
    if (!fetched.ok) return { error: fetched.error };
    bytes = fetched.bytes;
  } else {
    return { error: IMAGE_SHAPE };
  }
  if (bytes.length === 0 || bytes.length > UPLOAD_MAX_BYTES) return { error: `image is ${bytes.length} bytes: it must be 1 byte to 2 MB.` };
  const type = sniffImage(bytes);
  if (!type) return { error: 'image is not a PNG, JPG, WebP or SVG (checked by its bytes, not its name): send one of those.' };
  if (type === 'image/svg+xml') {
    const problem = svgProblem(bytes);
    if (problem) return { error: `SVG refused: ${problem}. Remove that from the file, or send a PNG.` };
  }
  return { bytes, type };
}

/**
 * POST /api/agent/launch {message, signature, launch: {...}}
 * The programmatic launch: an agent (any program with a wallet) proves its wallet with a SIWE message
 * (statement "Prepare a Bootr launch.", nonce from `POST /api/agent/nonce`), and this route does what the launch
 * form does before the wallet signs: pins the image, stores the Identity text and the coin metadata under a
 * new launch id (the hosted agent card and contract URI), reads the launcher's fee and minimum fuel, and
 * returns the transactions the wallet must send, in order: the USDC approval, `launch` on the chosen launcher
 * (`launchThrough`: `bootr`, the default; `clanker`, the deployment's Clanker path, which is Clanker v5 once its
 * launcher is configured and Clanker v4 until then; or `clanker-v5` by name; same `LaunchParams` on all of them, and on
 * v5 the salt is mined here so the coin's address ends in cccc, and `token` carries the creator-set token settings with
 * the same bounds as the launch form: lib/token-settings.ts), and the agent's first gas
 * (`EntryPoint.depositTo(predictedKernel)`). Nothing is sent on the caller's behalf
 * and no key ever reaches this server. 5 calls per minute per IP.
 */
export async function POST(req: NextRequest) {
  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) return fail(429, 'rate_limited', rateLimitMessage(5, retryAfter), {}, { 'Retry-After': String(retryAfter) });
  if (Number(req.headers.get('content-length') ?? 0) > 3 * 1024 * 1024) return fail(413, 'payload_too_large', 'Body must be at most 3 MB: send a smaller image, or host it and pass image.url.');
  const body = await readJsonObject<{ message?: unknown; signature?: unknown; launch?: LaunchInput }>(req);
  if (!body) return fail(400, 'invalid_json', 'Body must be a JSON object: {message, signature, launch}.');
  const v = await verifySiwe(body, { statement: STATEMENT, statementText: 'Prepare a Bootr launch.' });
  if (!v.ok) return fail(v.status, 'siwe_rejected', v.error, { reason: v.reason });
  const creator = v.address;
  const chainId = v.msg.chainId;
  // The signature has spent its nonce from here on, so every refusal also says to sign again.
  const refuse = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => fail(status, error, `${message} ${NEW_NONCE}`, extra);
  const invalid = (field: string, message: string) => refuse(400, 'invalid_request', message, { field });
  if (chainId !== env.chainId) return refuse(400, 'wrong_chain', `The message is signed for chain ${chainId}, but this deployment launches on chain ${env.chainId}: set chainId to ${env.chainId}.`);

  const platform = await readConfig().catch(() => null);
  if (platform?.launchesPaused) return refuse(503, 'launches_paused', 'Launches are paused by the platform: GET /api/platform shows launchesPaused, retry when it is false.');

  const l = (body.launch ?? {}) as LaunchInput;
  const name = typeof l.name === 'string' ? l.name.trim() : '';
  const symbol = typeof l.symbol === 'string' ? l.symbol.trim().toUpperCase() : '';
  if (!name || name.length > 48) return invalid('name', `name is required (1 to 48 characters), got ${name.length} characters.`);
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return invalid('symbol', `symbol must be 2 to 10 letters or digits, got ${quoted(l.symbol)}.`);
  const identity = normalizeIdentity(l.identity);
  if (identity === null) return invalid('identity', `identity must be plain text of ${MIN_IDENTITY_CHARS} to ${MAX_IDENTITY_CHARS} characters.`);
  // The same list as GET /api/models: the model catalog under the admin allow-list.
  const allowed = filterAllowedModels((await relayModels()).models, platform?.allowedModels ?? []);
  const model = typeof l.model === 'string' && l.model ? l.model : RECOMMENDED_MODEL;
  if (!allowed.some((m) => m.id === model)) {
    return invalid('model', `model must be one of: ${allowed.map((m) => m.id).join(', ')}; got ${quoted(l.model)}.`);
  }
  // The worker: a template id, or a custom preset {capabilities, postIntervalMs, jobLines} hashed like a template and
  // published in the agent card (`bootr.worker`) so the supervisor can verify the hash the launch writes on-chain.
  const worker = resolveWorker(l.worker);
  if (!worker) {
    return invalid(
      'worker',
      `worker must be one of ${WORKER_TEMPLATES.map((w) => w.id).join(', ')}, or {capabilities: {xRead, xReply, xPublish, research, images}, postIntervalMs: ${WORKER_BOUNDS.minPostIntervalMs}..${WORKER_BOUNDS.maxPostIntervalMs}, jobLines: up to ${WORKER_BOUNDS.maxJobLines} lines of ${WORKER_BOUNDS.maxJobLineChars} characters}; got ${quoted(l.worker)}.`,
    );
  }
  // Both are permanent or move money, so a value this route cannot read is refused, never taken for the default.
  if (l.buyback !== undefined && typeof l.buyback !== 'boolean') return invalid('buyback', `buyback must be true or false, got ${quoted(l.buyback)}.`);
  const buyback = l.buyback === true;
  const requested = normalizeSource(l.launchThrough);
  if (requested === null) return invalid('launchThrough', `launchThrough must be bootr (default), clanker or clanker-v5, got ${quoted(l.launchThrough)}.`);
  // `clanker` is this deployment's Clanker path (v5 once its launcher is configured, v4 until then); `clanker-v5` asks for v5 by name.
  const launchThrough: LaunchSource = requested === 'clanker' ? clankerPath.source : requested;
  const isV5 = launchThrough === 'clanker-v5';
  // Token settings exist on Clanker v5 only; checked here against the launcher's deploy bounds, again below against the
  // live ones, so a bad value is refused before the image is pinned.
  if (!isV5 && l.token !== undefined) return invalid('token', `token settings apply to Clanker v5 launches only (launchThrough clanker on a deployment with the v5 launcher, or clanker-v5); this launch goes through ${launchThrough}.`);
  if (isV5) {
    const first = parseTokenSettings(l.token, creator, FALLBACK_V5_BOUNDS);
    if (!first.ok) return invalid(first.field === 'token' ? 'token' : `token.${first.field}`, first.message);
  }
  const fuel = l.fuelUsdc === undefined ? '20' : typeof l.fuelUsdc === 'string' || typeof l.fuelUsdc === 'number' ? String(l.fuelUsdc) : '';
  if (!DECIMAL.test(fuel)) return invalid('fuelUsdc', `fuelUsdc must be a decimal USDC amount such as "20", got ${quoted(l.fuelUsdc)}.`);
  const devBuy = l.devBuyEth === undefined ? '0' : String(l.devBuyEth);
  if (!DECIMAL.test(devBuy)) return invalid('devBuyEth', `devBuyEth must be a decimal ETH amount such as "0.01", got ${quoted(l.devBuyEth)}.`);
  if (!isV5 && l.devBuySlippagePct !== undefined) return invalid('devBuySlippagePct', `devBuySlippagePct applies to Clanker v5 launches only; this launch goes through ${launchThrough}.`);
  const slippagePct = l.devBuySlippagePct === undefined ? DEFAULT_DEV_BUY_SLIPPAGE_PCT : parseSlippagePct(l.devBuySlippagePct);
  if (slippagePct === null) return invalid('devBuySlippagePct', `devBuySlippagePct must be a percent from 0.1 to ${MAX_DEV_BUY_SLIPPAGE_PCT} (default ${DEFAULT_DEV_BUY_SLIPPAGE_PCT}), got ${quoted(l.devBuySlippagePct)}.`);
  const gas = l.gasEth === undefined ? GAS_DEFAULT_ETH : String(l.gasEth);
  if (!DECIMAL.test(gas)) return invalid('gasEth', `gasEth must be a decimal ETH amount (0 allowed), got ${quoted(l.gasEth)}.`);
  const gasWei = parseEther(gas);
  if (gasWei !== 0n && gasWei < parseEther(GAS_MIN_ETH)) return invalid('gasEth', `gasEth must be 0 or at least ${GAS_MIN_ETH}, got ${quoted(gas)}.`);
  const xHandle = typeof l.xHandle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(l.xHandle.replace(/^@/, '')) ? l.xHandle.replace(/^@/, '') : null;
  // Optional coin links (website any https URL; x the project's account as an x.com URL or a handle; telegram on
  // t.me; discord on discord.gg / discord.com/invite).
  const checkedLinks = checkLinks(l.links);
  if (!checkedLinks.ok) return invalid(`links.${checkedLinks.field}`, `${checkedLinks.message} links must be https URLs: website, telegram (t.me), discord (discord.gg); x an x.com link or a handle.`);
  const links = checkedLinks.links;

  const pinata = pinataEnv();
  if (!pinata.jwt && !pinata.mock) return refuse(503, 'upload_unavailable', 'Image pinning is not configured on this deployment, so it cannot take a launch right now. Nothing was stored.');
  const img = await loadImage(l.image);
  if ('error' in img) return refuse(400, 'invalid_image', img.error, { field: 'image' });

  // The launchers share the `launch(LaunchParams)` ABI; the Clanker ones are optional per deployment (mock mode answers for all).
  const configured = launchThrough === 'bootr' ? contracts.launcher : CLANKER_PATHS[isV5 ? 5 : 4].launcher;
  const launcher = configured ?? (env.useMock ? zeroAddress : null);
  const v5 = contracts.clankerV5 ?? (env.useMock ? addresses[8453].clankerV5 : null);
  if (!launcher || (isV5 && !v5)) {
    return isV5
      ? refuse(503, 'clanker_v5_unavailable', 'Launching through Clanker v5 is not available on this deployment yet: set launchThrough to clanker (the deployment’s Clanker path) or bootr, or leave it out.', { field: 'launchThrough' })
      : launchThrough === 'clanker'
        ? refuse(503, 'clanker_unavailable', 'Launching through Clanker is not available on this deployment: leave launchThrough out, or set it to bootr.', { field: 'launchThrough' })
        : refuse(503, 'launcher_not_configured', 'The launcher contract is not configured on this deployment, so it cannot take a launch right now.');
  }

  const draftId = crypto.randomUUID();
  let cid: string;
  try {
    ({ cid } = await pinFile(img.bytes, img.type, `bootr/${draftId}/${(await sha256Hex(img.bytes)).slice(0, 16)}`, { draftId, creator }));
  } catch (err) {
    return refuse(502, 'pin_failed', `${err instanceof PinError ? err.message : 'Image pinning failed'}. Nothing was launched: try again in a moment.`);
  }
  const imageUrl = ipfsGatewayUrl(cid);
  const draftCoin = { name, symbol, image: imageUrl, imageIpfs: `ipfs://${cid}`, xHandle, links };
  try {
    const saved = await saveDraftIdentity(draftId, identity, null, {
      coin: draftCoin,
      worker: worker.draft,
      source: launchThrough,
      tokenSettings: isV5 ? parseTokenSettingsOrNull(l.token, creator) : null,
    });
    if (!saved.ok && saved.reason === 'full') return refuse(503, 'store_full', 'The launch draft store is full right now. Nothing was launched: try again in a few minutes.');
    if (!saved.ok) return refuse(500, 'store_failed', 'Could not store the launch draft. Nothing was launched: try again in a moment.');
  } catch {
    return refuse(503, 'store_unavailable', 'The launch draft store is not writable. Nothing was launched: try again in a moment.');
  }

  // Launcher state: fee and minimum fuel from the chain (fallbacks in mock mode or when the RPC is down).
  const client = serverPublicClient(chainId);
  const salt = keccak256(toHex(draftId));
  let feeWei = FEE_FALLBACK_WEI;
  let defaults = fallbackDefaults(launchThrough, buyback);
  // Clanker v5: the numbers the creator's pins are made of, read now, when the transaction is prepared (mock mode: the
  // deploy values, Clanker's config version 0).
  let terms: V5LaunchTerms = { launchFeeWei: FEE_FALLBACK_WEI, clankerFeeWei: 0n, configVersion: 0n, bounds: FALLBACK_V5_BOUNDS, minFuelUsdc: defaults.minFuelUsdc };
  let predictedKernel: Address | null = null;
  if (!env.useMock) {
    try {
      // One multicall, not three requests: the RPC key is shared with the indexer's block tail. On v5 the kernel is
      // predicted after the salt is mined (the salt picks the kernel address too), the launcher's bounds come from
      // `agentDefaults()` (it has no presets), and Clanker's own launch fee and config version are read.
      if (isV5) {
        terms = await readLaunchTerms(client, launcher, v5!.factory as Address);
        feeWei = terms.launchFeeWei;
        defaults = { ...defaults, minFuelUsdc: terms.minFuelUsdc };
      } else {
        const [fee, tuple, kernel] = await client.multicall({
          allowFailure: false,
          contracts: [
            { address: launcher, abi: launcherAbi, functionName: 'launchFeeWei' },
            { address: launcher, abi: launcherAbi, functionName: buyback ? 'buybackDefaults' : 'standardDefaults' },
            { address: launcher, abi: launcherAbi, functionName: 'predictKernel', args: [creator, salt] },
          ],
        });
        feeWei = fee;
        defaults = defaultsFromTuple(tuple as LaunchDefaultsTuple);
        predictedKernel = kernel;
      }
    } catch {
      return refuse(502, 'chain_unavailable', 'Could not read the launcher. Nothing was launched: try again in a moment.');
    }
  }
  // The settings against the launcher's live bounds (the owner can move the floors and the tax range for future launches).
  let tokenSettings: ContractTokenSettings | null = null;
  let tokenInput = null;
  if (isV5) {
    const checked = parseTokenSettings(l.token, creator, terms.bounds);
    if (!checked.ok) return invalid(checked.field === 'token' ? 'token' : `token.${checked.field}`, checked.message);
    tokenInput = checked.settings;
    // The pins from the terms just read; the dev buy's minimum is set from its quote once the salt is mined (1 until then).
    tokenSettings = toContractSettings(checked.settings, contractUriUrl(draftId), terms.bounds, pinsOf(terms, parseEther(devBuy) > 0n ? 1n : 0n));
    // The launcher's own checks, before anything is signed: the paired asset is allowed for agent coins,
    // `previewSlotWeights` reverts exactly as `launch` would, and a non-ETH dev buy has its route.
    if (!env.useMock) {
      const s = tokenSettings;
      const [allowed, preview, route] = await client.multicall({
        allowFailure: true,
        contracts: [
          { address: launcher, abi: clankerLauncherV5Abi, functionName: 'allowedQuote', args: [LAUNCH_KIND_ID.agent, s.quoteToken] },
          { address: launcher, abi: clankerLauncherV5Abi, functionName: 'previewSlotWeights', args: [s] },
          { address: launcher, abi: clankerLauncherV5Abi, functionName: 'devBuyRoute', args: [s.quoteToken] },
        ],
      });
      if (allowed.status === 'success' && !allowed.result) return invalid('token.pairedAsset', `The launcher does not take ${checked.settings.pairedAsset} as a paired asset right now: use ETH.`);
      if (preview.status === 'failure') {
        const reason = (preview.error as { shortMessage?: string }).shortMessage ?? 'the settings';
        return invalid('token', `The launcher refuses these settings (${reason}). Nothing was launched.`);
      }
      if (BigInt(s.quoteToken) !== 0n && parseEther(devBuy) > 0n && route.status === 'success' && BigInt(route.result[0]) === 0n) {
        return invalid('devBuyEth', `A dev buy through ${checked.settings.pairedAsset} is not available yet: set devBuyEth to 0.`);
      }
    }
  }
  const fuelUnits = parseUnits(fuel, USDC_DECIMALS);
  if (fuelUnits < defaults.minFuelUsdc) return invalid('fuelUsdc', `fuelUsdc must be at least ${Number(defaults.minFuelUsdc) / 1e6} USDC, got ${quoted(fuel)}.`);
  const devBuyWei = parseEther(devBuy);

  const params = {
    name,
    symbol,
    image: imageUrl,
    // Clanker's page reads the JSON itself from this field (description, links); the hosted document's URL stays inside it (lib/contract-metadata.ts).
    metadata: launchThrough !== 'bootr' ? clankerTokenMetadata(draftCoin, contractUriUrl(draftId), identity) : contractUriUrl(draftId),
    context: JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id: draftId, via: 'agent-api' }),
    salt,
    // The v5 launcher ignores it: the burn is `token.burnPct` there.
    buybackBurn: isV5 ? false : buyback,
    fuelUsdc: fuelUnits,
    devBuyWei,
    workerHash: worker.hash,
    model,
    agentURI: agentCardUrl(draftId),
    supervisorSessionKey: env.supervisorSessionKey ?? zeroAddress,
  };
  // The launcher's byte caps (`StringTooLong`), before the salt is mined and anything is signed. The metadata is the
  // identity (as the coin's description) and the links, so a long metadata is reported on `identity`.
  if (isV5 && tokenSettings) {
    const [tooLong] = launchStringProblems({ ...params, contractURI: tokenSettings.contractURI });
    if (tooLong) return invalid(tooLong.field === 'metadata' ? 'identity' : tooLong.field, tooLong.message);
  }
  // Clanker v5 refuses a token address that does not end in cccc: mine the salt (lib/clanker-v5.ts), check it with the
  // launcher's own predictToken, and predict the kernel from the mined salt.
  let mined: MinedSalt | null = null;
  if (isV5 && tokenSettings) {
    try {
      mined = await mineLaunchSalt({ client: env.useMock ? null : client, launcher, tokenDeployer: v5!.tokenDeployer as Address, creator, params, settings: tokenSettings });
      params.salt = mined.salt;
      if (!env.useMock) {
        predictedKernel = await client.readContract({ address: launcher, abi: launcherAbi, functionName: 'predictKernel', args: [creator, mined.salt] });
      }
    } catch (err) {
      return err instanceof SaltMiningError
        ? refuse(503, 'salt_not_found', err.message)
        : refuse(502, 'chain_unavailable', 'Could not read the launcher. Nothing was launched: try again in a moment.');
    }
  }
  // The dev buy's minimum: what the launch delivers now (a simulation of this very launch, lib/v5-launch.ts) less the
  // slippage tolerance. A launch that would revert is refused here with the launcher's reason.
  let devBuyQuote: DevBuyQuote | null = null;
  if (isV5 && tokenSettings && mined && devBuyWei > 0n) {
    try {
      const quotedOut = env.useMock
        ? mockDevBuyQuote(devBuyWei)
        : await quoteDevBuy({ client, launcher, usdc: contracts.usdc, creator, token: mined.token, params, settings: tokenSettings, value: launchValue(devBuyWei, terms) });
      devBuyQuote = { quotedOut, minOut: minDevBuyOutFrom(quotedOut, slippagePct), slippagePct };
      tokenSettings.minDevBuyOut = devBuyQuote.minOut;
    } catch (err) {
      return err instanceof V5LaunchRefused
        ? refuse(409, 'launch_would_revert', err.message, { code: err.problem.code, ...(err.problem.field ? { field: err.problem.field } : {}) })
        : refuse(502, 'quote_unavailable', 'Could not quote the dev buy (the RPC could not simulate the launch). Nothing was launched: try again in a moment, or set devBuyEth to 0.');
    }
  }
  const usdc = contracts.usdc;
  const entryPoint = chainAddresses().entryPointV07;
  const transactions: { step: string; to: Address; data: Hex; value: string; note: string }[] = [
    {
      step: 'approve',
      to: usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [launcher, fuelUnits] }),
      value: '0',
      note: `USDC.approve(launcher, ${fuel} USDC): the launch pulls the fuel into the agent's treasury.`,
    },
    {
      step: 'launch',
      to: launcher,
      data: tokenSettings
        ? encodeFunctionData({ abi: clankerLauncherV5Abi, functionName: 'launch', args: [params, tokenSettings] })
        : encodeFunctionData({ abi: launcherAbi, functionName: 'launch', args: [params] }),
      value: (isV5 ? launchValue(devBuyWei, terms) : devBuyWei + feeWei).toString(),
      note: isV5
        ? `BootrClankerLauncherV5.launch(params, settings): value = dev buy ${devBuy} ETH + launch fee ${terms.launchFeeWei.toString()} wei${terms.clankerFeeWei > 0n ? ` + Clanker's launch fee ${terms.clankerFeeWei.toString()} wei` : ''}. The salt is mined so the coin's address ends in cccc (${mined?.token}). The settings pin Clanker's config version ${terms.configVersion.toString()}, the launch fee and the locked shares${devBuyQuote ? `, and the dev buy's minimum of ${devBuyQuote.minOut.toString()} raw coins (the quote less ${slippagePct}%)` : ''}: send it soon; if any of them moved the launch reverts (StaleConfig, LaunchFeeAboveMax, LockedSharesChanged, or the dev buy's minimum) and spends nothing but gas, so call this endpoint again. Emits AgentLaunched(token, kernel, ...).`
        : `${launchThrough === 'clanker' ? 'BootrClankerLauncher' : 'BootrLauncher'}.launch: value = dev buy ${devBuy} ETH + launch fee ${feeWei.toString()} wei. Emits AgentLaunched(token, kernel, ...).`,
    },
  ];
  if (gasWei > 0n) {
    transactions.push({
      step: 'gas',
      to: entryPoint,
      data: encodeFunctionData({ abi: entryPointAbi, functionName: 'depositTo', args: [predictedKernel ?? zeroAddress] }),
      value: gasWei.toString(),
      note: predictedKernel
        ? `EntryPoint.depositTo(kernel ${predictedKernel}): the agent's first gas (${gas} ETH). Not a purchase, not refundable. Send after the launch is mined.`
        : 'EntryPoint.depositTo(kernel): replace the zero address with the kernel from the AgentLaunched event (mock mode cannot predict it).',
    });
  }

  return NextResponse.json(
    {
      launchId: draftId,
      chainId,
      creator,
      launcher,
      launchThrough,
      predictedKernel,
      salt: params.salt,
      ...(mined ? { predictedToken: mined.token, saltTries: mined.attempts } : {}),
      agentURI: params.agentURI,
      metadata: params.metadata,
      image: { url: imageUrl, ipfsUri: `ipfs://${cid}` },
      model,
      worker: worker.id,
      workerHash: worker.hash,
      ...(worker.draft.kind === CUSTOM_WORKER_ID ? { workerPreset: worker.draft.preset } : {}),
      buyback: isV5 ? false : buyback,
      ...(tokenInput && tokenSettings
        ? {
            token: tokenInput,
            tokenSettings: contractSettingsJson(tokenSettings),
          }
        : {}),
      ...(devBuyQuote ? { devBuy: { quotedOut: devBuyQuote.quotedOut.toString(), minOut: devBuyQuote.minOut.toString(), slippagePct: devBuyQuote.slippagePct } } : {}),
      launchFeeWei: feeWei.toString(),
      transactions,
      next: {
        status: `${env.indexerUrl || 'https://indexer.bootr.fun'}/graphql: tokens(where: {creator: "${creator.toLowerCase()}"}) { items { id symbol kernel agentId xHandle } }`,
        xConnect: `POST ${env.siteUrl}/api/agent/x-connect with a SIWE statement "Connect the X account of Bootr agent #<agentId> (<kernel>)." once the coin is indexed; open the returned URL in a browser logged into the agent's X account within 5 minutes.`,
        docs: `${env.siteUrl}/docs/for-agents#launching`,
      },
      ...(env.useMock ? { mock: true } : {}),
    },
    { headers: NO_STORE },
  );
}

/** The settings to keep with the draft (checked against the deploy bounds; the live check comes after the chain read). */
function parseTokenSettingsOrNull(raw: unknown, creator: Address) {
  const r = parseTokenSettings(raw, creator, FALLBACK_V5_BOUNDS);
  return r.ok ? r.settings : null;
}
