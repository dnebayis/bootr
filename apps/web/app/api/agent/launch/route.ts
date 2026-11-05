import { NextResponse, type NextRequest } from 'next/server';
import { createPublicClient, encodeFunctionData, erc20Abi, http, keccak256, parseEther, parseUnits, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { entryPointAbi } from '@/lib/gas';
import { ipfsGatewayUrl, UPLOAD_MAX_BYTES } from '@/lib/ipfs';
import { agentCardUrl, contractUriUrl } from '@/lib/agent-card';
import { checkLinks } from '@/lib/coin-link-rules';
import { clankerTokenMetadata } from '@/lib/contract-metadata';
import { contracts, USDC_DECIMALS } from '@/lib/contracts';
import { chainAddresses } from '@/lib/chains';
import { env } from '@/lib/env';
import { WORKER_TEMPLATES } from '@/lib/launch';
import { CUSTOM_WORKER_ID, customWorker, normalizeWorkerPreset, WORKER_BOUNDS } from '@bootr/shared/workers';
import { defaultsFromTuple, FALLBACK_BUYBACK, FALLBACK_STANDARD, launcherAbi, type LaunchDefaultsTuple } from '@/lib/abi/launcher';
import { filterAllowedModels, RECOMMENDED_MODEL } from '@/lib/models';
import { readConfig } from '@/lib/server/admin-config';
import { pinataEnv } from '@/lib/server/env';
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
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { error: 'image.url is not a URL: send a public https URL, or use image.dataUrl.' };
    }
    if (u.protocol !== 'https:') return { error: 'image.url must use https: host the image there, or use image.dataUrl.' };
    let res: Response;
    try {
      res = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: 'follow', headers: { accept: 'image/*' } });
    } catch {
      return { error: 'image.url could not be fetched within 8 seconds: check that it is public, or use image.dataUrl.' };
    }
    if (!res.ok) return { error: `image.url responded ${res.status}: check that it is public, or use image.dataUrl.` };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > UPLOAD_MAX_BYTES) return { error: `image is ${len} bytes: it must be at most 2 MB.` };
    bytes = new Uint8Array(await res.arrayBuffer());
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
 * (`launchThrough`: `bootr`, the default, or `clanker`; same `LaunchParams` either way), and the agent's first gas
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
  // The same list as GET /api/models: the relay's, or the built-in one when the relay is down.
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
  const launchThrough = normalizeSource(l.launchThrough);
  if (launchThrough === null) return invalid('launchThrough', `launchThrough must be bootr (default) or clanker, got ${quoted(l.launchThrough)}.`);
  const fuel = l.fuelUsdc === undefined ? '20' : typeof l.fuelUsdc === 'string' || typeof l.fuelUsdc === 'number' ? String(l.fuelUsdc) : '';
  if (!DECIMAL.test(fuel)) return invalid('fuelUsdc', `fuelUsdc must be a decimal USDC amount such as "20", got ${quoted(l.fuelUsdc)}.`);
  const devBuy = l.devBuyEth === undefined ? '0' : String(l.devBuyEth);
  if (!DECIMAL.test(devBuy)) return invalid('devBuyEth', `devBuyEth must be a decimal ETH amount such as "0.01", got ${quoted(l.devBuyEth)}.`);
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

  // Both launchers share the ABI; the Clanker one is optional per deployment (mock mode answers for both).
  const launcher = (launchThrough === 'clanker' ? contracts.clankerLauncher : contracts.launcher) ?? (env.useMock ? zeroAddress : null);
  if (!launcher) {
    return launchThrough === 'clanker'
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
    const saved = await saveDraftIdentity(draftId, identity, null, { coin: draftCoin, worker: worker.draft, source: launchThrough });
    if (!saved.ok) return refuse(500, 'store_failed', 'Could not store the launch draft. Nothing was launched: try again in a moment.');
  } catch {
    return refuse(503, 'store_unavailable', 'The launch draft store is not writable. Nothing was launched: try again in a moment.');
  }

  // Launcher state: fee and minimum fuel from the chain (fallbacks in mock mode or when the RPC is down).
  const chain = chainId === 8453 ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http((chainId === 8453 ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) || undefined) });
  const salt = keccak256(toHex(draftId));
  let feeWei = FEE_FALLBACK_WEI;
  let defaults = buyback ? FALLBACK_BUYBACK : FALLBACK_STANDARD;
  let predictedKernel: Address | null = null;
  if (!env.useMock) {
    try {
      const [fee, tuple, kernel] = await Promise.all([
        client.readContract({ address: launcher, abi: launcherAbi, functionName: 'launchFeeWei' }),
        client.readContract({ address: launcher, abi: launcherAbi, functionName: buyback ? 'buybackDefaults' : 'standardDefaults' }),
        client.readContract({ address: launcher, abi: launcherAbi, functionName: 'predictKernel', args: [creator, salt] }),
      ]);
      feeWei = fee as bigint;
      defaults = defaultsFromTuple(tuple as LaunchDefaultsTuple);
      predictedKernel = kernel as Address;
    } catch {
      return refuse(502, 'chain_unavailable', 'Could not read the launcher. Nothing was launched: try again in a moment.');
    }
  }
  const fuelUnits = parseUnits(fuel, USDC_DECIMALS);
  if (fuelUnits < defaults.minFuelUsdc) return invalid('fuelUsdc', `fuelUsdc must be at least ${Number(defaults.minFuelUsdc) / 1e6} USDC, got ${quoted(fuel)}.`);
  const devBuyWei = parseEther(devBuy);

  const params = {
    name,
    symbol,
    image: imageUrl,
    // Clanker's page reads JSON from this field; the hosted document's URL stays inside it (lib/contract-metadata.ts).
    metadata: launchThrough === 'clanker' ? clankerTokenMetadata(draftCoin, contractUriUrl(draftId)) : contractUriUrl(draftId),
    context: JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id: draftId, via: 'agent-api' }),
    salt,
    buybackBurn: buyback,
    fuelUsdc: fuelUnits,
    devBuyWei,
    workerHash: worker.hash,
    model,
    agentURI: agentCardUrl(draftId),
    supervisorSessionKey: env.supervisorSessionKey ?? zeroAddress,
  } as const;
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
      data: encodeFunctionData({ abi: launcherAbi, functionName: 'launch', args: [params] }),
      value: (devBuyWei + feeWei).toString(),
      note: `${launchThrough === 'clanker' ? 'BootrClankerLauncher' : 'BootrLauncher'}.launch: value = dev buy ${devBuy} ETH + launch fee ${feeWei.toString()} wei. Emits AgentLaunched(token, kernel, ...).`,
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
      agentURI: params.agentURI,
      metadata: params.metadata,
      image: { url: imageUrl, ipfsUri: `ipfs://${cid}` },
      model,
      worker: worker.id,
      workerHash: worker.hash,
      ...(worker.draft.kind === CUSTOM_WORKER_ID ? { workerPreset: worker.draft.preset } : {}),
      buyback,
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
