import { NextResponse, type NextRequest } from 'next/server';
import { createPublicClient, encodeFunctionData, erc20Abi, http, keccak256, parseEther, parseUnits, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { entryPointAbi } from '@/lib/gas';
import { ipfsGatewayUrl, UPLOAD_MAX_BYTES } from '@/lib/ipfs';
import { agentCardUrl, contractUriUrl } from '@/lib/agent-card';
import { clankerTokenMetadata } from '@/lib/contract-metadata';
import { contracts, USDC_DECIMALS } from '@/lib/contracts';
import { chainAddresses } from '@/lib/chains';
import { env } from '@/lib/env';
import { WORKER_TEMPLATES } from '@/lib/launch';
import { CUSTOM_WORKER_ID, customWorker, normalizeWorkerPreset, WORKER_BOUNDS } from '@bootr/shared/workers';
import { defaultsFromTuple, FALLBACK_BUYBACK, FALLBACK_STANDARD, launcherAbi, type LaunchDefaultsTuple } from '@/lib/abi/launcher';
import { FALLBACK_MODELS, filterAllowedModels, RECOMMENDED_MODEL } from '@/lib/models';
import { readConfig } from '@/lib/server/admin-config';
import { pinataEnv } from '@/lib/server/env';
import { clientIp, PinError, pinFile, RateLimiter, sha256Hex, sniffImage, svgProblem } from '@/lib/server/ipfs';
import { MAX_IDENTITY_CHARS, MIN_IDENTITY_CHARS, normalizeIdentity, normalizeLinks, normalizeSource, saveDraftIdentity, type DraftWorker } from '@/lib/server/launch-drafts';
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

function fail(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message }, { status, headers: { ...NO_STORE, ...headers } });
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

/** The image, from an https URL (fetched here, ≤ 2 MB) or a data: URL; checked by its bytes like the form upload. */
async function loadImage(image: unknown): Promise<{ bytes: Uint8Array; type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml' } | { error: string }> {
  if (!image || typeof image !== 'object') return { error: 'image must be {url} or {dataUrl}' };
  const { url, dataUrl } = image as { url?: unknown; dataUrl?: unknown };
  let bytes: Uint8Array;
  if (typeof dataUrl === 'string') {
    const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return { error: 'dataUrl must be data:image/<type>;base64,<data>' };
    bytes = Uint8Array.from(Buffer.from(m[2], 'base64'));
  } else if (typeof url === 'string') {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { error: 'image.url is not a URL' };
    }
    if (u.protocol !== 'https:') return { error: 'image.url must be https' };
    let res: Response;
    try {
      res = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: 'follow', headers: { accept: 'image/*' } });
    } catch {
      return { error: 'image.url could not be fetched' };
    }
    if (!res.ok) return { error: `image.url responded ${res.status}` };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > UPLOAD_MAX_BYTES) return { error: 'image must be at most 2 MB' };
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    return { error: 'image must be {url} or {dataUrl}' };
  }
  if (bytes.length === 0 || bytes.length > UPLOAD_MAX_BYTES) return { error: 'image must be 1 byte to 2 MB' };
  const type = sniffImage(bytes);
  if (!type) return { error: 'image must be a PNG, JPG, WebP or SVG' };
  if (type === 'image/svg+xml') {
    const problem = svgProblem(bytes);
    if (problem) return { error: `SVG refused: ${problem}` };
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
  if (retryAfter) return fail(429, 'rate_limited', 'Too many requests. Try again in a minute.', { 'Retry-After': String(retryAfter) });
  if (Number(req.headers.get('content-length') ?? 0) > 3 * 1024 * 1024) return fail(413, 'payload_too_large', 'Body must be at most 3 MB.');
  let body: { message?: unknown; signature?: unknown; launch?: LaunchInput };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return fail(400, 'invalid_json', 'Body is not valid JSON.');
  }
  const v = await verifySiwe(body, { statement: STATEMENT });
  if (!v.ok) return fail(v.status, 'siwe_rejected', v.error);
  const creator = v.address;
  const chainId = v.msg.chainId;
  if (chainId !== env.chainId) return fail(400, 'wrong_chain', `This deployment launches on chain ${env.chainId}.`);

  const platform = await readConfig().catch(() => null);
  if (platform?.launchesPaused) return fail(503, 'launches_paused', 'Launches are paused by the platform.');

  const l = (body.launch ?? {}) as LaunchInput;
  const name = typeof l.name === 'string' ? l.name.trim() : '';
  const symbol = typeof l.symbol === 'string' ? l.symbol.trim().toUpperCase() : '';
  if (!name || name.length > 48) return fail(400, 'invalid_request', 'name is required (1 to 48 characters).');
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return fail(400, 'invalid_request', 'symbol must be 2 to 10 letters or digits.');
  const identity = normalizeIdentity(l.identity);
  if (identity === null) return fail(400, 'invalid_request', `identity must be plain text of ${MIN_IDENTITY_CHARS} to ${MAX_IDENTITY_CHARS} characters.`);
  const allowed = filterAllowedModels(FALLBACK_MODELS, platform?.allowedModels ?? []);
  const model = typeof l.model === 'string' && l.model ? l.model : RECOMMENDED_MODEL;
  if (!allowed.some((m) => m.id === model)) {
    return fail(400, 'invalid_request', `model must be one of: ${allowed.map((m) => m.id).join(', ')}`);
  }
  // The worker: a template id, or a custom preset {capabilities, postIntervalMs, jobLines} hashed like a template and
  // published in the agent card (`bootr.worker`) so the supervisor can verify the hash the launch writes on-chain.
  const worker = resolveWorker(l.worker);
  if (!worker) {
    return fail(
      400,
      'invalid_request',
      `worker must be one of ${WORKER_TEMPLATES.map((w) => w.id).join(', ')}, or {capabilities: {xRead, xReply, xPublish, research, images}, postIntervalMs: ${WORKER_BOUNDS.minPostIntervalMs}..${WORKER_BOUNDS.maxPostIntervalMs}, jobLines: up to ${WORKER_BOUNDS.maxJobLines} lines of ${WORKER_BOUNDS.maxJobLineChars} characters}`,
    );
  }
  const buyback = l.buyback === true;
  const launchThrough = normalizeSource(l.launchThrough);
  if (launchThrough === null) return fail(400, 'invalid_request', 'launchThrough must be bootr (default) or clanker.');
  const fuel = typeof l.fuelUsdc === 'string' || typeof l.fuelUsdc === 'number' ? String(l.fuelUsdc) : '20';
  if (!DECIMAL.test(fuel)) return fail(400, 'invalid_request', 'fuelUsdc must be a decimal USDC amount.');
  const devBuy = l.devBuyEth === undefined ? '0' : String(l.devBuyEth);
  if (!DECIMAL.test(devBuy)) return fail(400, 'invalid_request', 'devBuyEth must be a decimal ETH amount.');
  const gas = l.gasEth === undefined ? GAS_DEFAULT_ETH : String(l.gasEth);
  if (!DECIMAL.test(gas)) return fail(400, 'invalid_request', 'gasEth must be a decimal ETH amount (0 allowed).');
  const gasWei = parseEther(gas);
  if (gasWei !== 0n && gasWei < parseEther(GAS_MIN_ETH)) return fail(400, 'invalid_request', `gasEth must be 0 or at least ${GAS_MIN_ETH}.`);
  const xHandle = typeof l.xHandle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(l.xHandle.replace(/^@/, '')) ? l.xHandle.replace(/^@/, '') : null;
  // Optional coin links (website any https URL; x the project's account as an x.com URL or a handle; telegram on
  // t.me; discord on discord.gg / discord.com/invite).
  const links = normalizeLinks(l.links);
  if (!links) return fail(400, 'invalid_request', 'links must be https URLs: website, telegram (t.me), discord (discord.gg); x an x.com link or a handle.');

  const pinata = pinataEnv();
  if (!pinata.jwt && !pinata.mock) return fail(503, 'upload_unavailable', 'Image pinning is not configured on this deployment.');
  const img = await loadImage(l.image);
  if ('error' in img) return fail(400, 'invalid_image', img.error);

  // Both launchers share the ABI; the Clanker one is optional per deployment (mock mode answers for both).
  const launcher = (launchThrough === 'clanker' ? contracts.clankerLauncher : contracts.launcher) ?? (env.useMock ? zeroAddress : null);
  if (!launcher) {
    return launchThrough === 'clanker'
      ? fail(503, 'clanker_unavailable', 'Launching through Clanker is not available on this deployment.')
      : fail(503, 'launcher_not_configured', 'The launcher contract is not configured on this deployment.');
  }

  const draftId = crypto.randomUUID();
  let cid: string;
  try {
    ({ cid } = await pinFile(img.bytes, img.type, `bootr/${draftId}/${(await sha256Hex(img.bytes)).slice(0, 16)}`, { draftId, creator }));
  } catch (err) {
    return fail(502, 'pin_failed', err instanceof PinError ? err.message : 'Image pinning failed.');
  }
  const imageUrl = ipfsGatewayUrl(cid);
  const draftCoin = { name, symbol, image: imageUrl, imageIpfs: `ipfs://${cid}`, xHandle, links };
  try {
    const saved = await saveDraftIdentity(draftId, identity, null, { coin: draftCoin, worker: worker.draft, source: launchThrough });
    if (!saved.ok) return fail(500, 'store_failed', 'Could not store the launch draft.');
  } catch {
    return fail(503, 'store_unavailable', 'The launch draft store is not writable.');
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
      return fail(502, 'chain_unavailable', 'Could not read the launcher. Try again in a moment.');
    }
  }
  const fuelUnits = parseUnits(fuel, USDC_DECIMALS);
  if (fuelUnits < defaults.minFuelUsdc) return fail(400, 'invalid_request', `fuelUsdc must be at least ${Number(defaults.minFuelUsdc) / 1e6} USDC.`);
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
