/**
 * The owner's real paid check of full direct mode, from a dev wallet on their own machine, before production is touched.
 * It pays through the same code an agent does (`src/blockrun.ts`, `src/inference.ts`, `src/images.ts`,
 * `@bootr/inference/client`), so a pass here proves that path, not a copy of it. See apps/supervisor/README.md,
 * "BlockRun live check".
 *
 * The goal it judges: the agent pays BlockRun from its own wallet, at no more than the relay charges today, tool calls
 * work, pictures work, no other model answers. Whether `upto` settles less than its ceiling is reported, not judged.
 *
 * Money rules:
 *  - Nothing is signed without `--yes`. The prices shown first come from unpaid requests.
 *  - At most the ceiling shown for each call, to BlockRun's address only, in USDC on Base only.
 *  - One signature per call and no retry, ever. Whatever goes wrong after a signature (no answer, a timeout, a slow
 *    settlement) is answered by reading the chain until the nonce is spent or the signature is dead.
 *  - The first failure stops the run.
 *
 * The key comes from `BLOCKRUN_TEST_PRIVATE_KEY` only and every printed line passes through `redact`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { agentConfigSchema, buildObservation, buildSystemPrompt, maxQuoteFor, parseToolInput, toolsFor, type ChatMessage, type ToolName } from '@bootr/agent-core';
import { computeQuote, countInputTokens, DEFAULT_PRICE_TABLE } from '@bootr/inference';
import { getAddresses } from '@bootr/shared/addresses';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createPublicClient, erc20Abi, formatEther, http, isAddressEqual, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { DEADLINE_GRACE_SECONDS, directBody, directImageBody, directImageUrl, directPost, directUrl, imageAnswer, InsufficientFloatError, paymentAuthorization, paymentSettled, pollAddress, readDirectResponse, readImageJob, requireFloat, settledOnChain, settlementClaim, type DirectPayConfig, type DirectResponse, type DirectWorld } from '../src/blockrun.js';
import { BLOCKRUN_DEFAULT_PAYTO } from '../src/config.js';
import { imageRequest, parseImageResponse } from '../src/images.js';
import { buildRequest, parseAssistant } from '../src/inference.js';

export const DEFAULT_RPC_URL = 'https://mainnet.base.org';
export const DEFAULT_BLOCKRUN_URL = 'https://blockrun.ai/api/v1';
const DEFAULT_OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const CLAUDE_MODEL = 'anthropic/claude-haiku-4.5';
export const OTHER_MODEL = 'openai/gpt-4.1-mini';
export const REAL_THOUGHT_MODEL = 'anthropic/claude-sonnet-4.6';
/** The relay id of the cheapest picture BlockRun can edit from a reference, which is what an agent's picture does. */
export const IMAGE_MODEL = 'openai/gpt-5-image-mini';
export const CAP_PER_CALL_MICRO = 150_000n;
export const CAP_TOTAL_MICRO = 400_000n;
/** About what one thought of the $BOOTR agent weighs on the wire. */
export const THOUGHT_BYTES = 61_000;
/** The real system prompt and tool list with almost nothing else. */
const SMALL_THOUGHT_BYTES = 17_000;
const THOUGHT_MAX_TOKENS = 1024;
const CHAIN_ID = 8453;
const NETWORK = `eip155:${CHAIN_ID}`;
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** BlockRun's flat fee on a paid chat call. */
const BLOCKRUN_FEE_MICRO = 1000;
const SLOW_CALL_MS = 60_000;
const BETWEEN_CALLS_MS = 3_000;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;

export interface LiveCheckDeps {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  out: (line: string) => void;
  fetch?: typeof fetch;
  /** Tests inject a chain; otherwise a client on `BLOCKRUN_TEST_RPC_URL` or the public endpoint. */
  publicClient?: PublicClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

const usd = (micro: bigint | number): string => `$${(Number(micro) / 1e6).toFixed(6)}`;
const usdc = (micro: bigint): string => `${(Number(micro) / 1e6).toFixed(6)} USDC`;

class Refusal extends Error {}

/** Lines may carry an error text from a library: the key and a keyed RPC url must not get out that way. */
export function redact(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
    out = out.split(secret.replace(/^0x/, '')).join('[redacted]');
  }
  return out;
}

interface Args {
  yes: boolean;
  full: boolean;
  promptCache: boolean;
  model: string;
  maxPerCall: bigint;
  maxTotal: bigint;
}

function microOf(flag: string, value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Refusal(`${flag} must be a dollar amount such as 0.15`);
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { yes: false, full: false, promptCache: true, model: CLAUDE_MODEL, maxPerCall: CAP_PER_CALL_MICRO, maxTotal: CAP_TOTAL_MICRO };
  for (const arg of argv) {
    // Before anything else, and never echoed: an argument ends up in the shell history and the process list.
    if (/(^|=)(0x)?[0-9a-fA-F]{64}$/.test(arg)) throw new Refusal('That looks like a private key on the command line. The key is read from BLOCKRUN_TEST_PRIVATE_KEY only. Treat the key as exposed.');
    if (arg === '--yes') args.yes = true;
    else if (arg === '--full') args.full = true;
    else if (arg === '--no-prompt-cache') args.promptCache = false;
    else if (arg.startsWith('--model=')) args.model = arg.slice('--model='.length);
    else if (arg.startsWith('--max-per-call=')) args.maxPerCall = microOf('--max-per-call', arg.slice('--max-per-call='.length));
    else if (arg.startsWith('--max-total=')) args.maxTotal = microOf('--max-total', arg.slice('--max-total='.length));
    else throw new Refusal('Unknown argument. Allowed: --yes, --full, --no-prompt-cache, --model=<id>, --max-per-call=<usd>, --max-total=<usd>.');
  }
  return args;
}

function readKey(env: Record<string, string | undefined>): Hex {
  const key = env.BLOCKRUN_TEST_PRIVATE_KEY;
  if (!key) throw new Refusal('Set BLOCKRUN_TEST_PRIVATE_KEY to the private key of a dev wallet.');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Refusal('BLOCKRUN_TEST_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key.');
  // This is a dev wallet's job: the service keys sign for real agents.
  for (const name of ['SPENDER_MASTER_KEY', 'SESSION_SIGNER_PRIVATE_KEY', 'ADMIN_PRIVATE_KEY']) {
    if (env[name]?.toLowerCase() === key.toLowerCase()) throw new Refusal(`BLOCKRUN_TEST_PRIVATE_KEY is the same as ${name}. Use a separate dev wallet.`);
  }
  return key as Hex;
}

const fixture = (): { config: unknown; observation: { mentionTexts: string[] } & Record<string, unknown> } => JSON.parse(readFileSync(new URL('./fixtures/blockrun-thought.json', import.meta.url), 'utf8'));

/**
 * One thought as the runtime builds it: the real system prompt and tool list for a made-up agent, an observation in the
 * real shape, grown with made-up mentions to the size asked for. Fixed time and content, so a second send is byte for
 * byte the first and a prompt cache can hit.
 */
export function thoughtRequest(model: string, bytes: number = THOUGHT_BYTES): Record<string, unknown> {
  const { config: rawConfig, observation } = fixture();
  const config = agentConfigSchema.parse(rawConfig);
  const { mentionTexts, ...rest } = observation;
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const tools = toolsFor(config);
  const build = (count: number) => {
    const mentions = Array.from({ length: count }, (_, i) => ({
      postId: String(1_900_000_000_000_001_000n + BigInt(i)),
      authorHandle: `example_user_${(i % 37) + 1}`,
      authorId: String(1_000_000_000_000_000_100n + BigInt(i % 37)),
      text: mentionTexts[i % mentionTexts.length],
      at: new Date(now - i * 240_000).toISOString(),
      eligible: i % 5 !== 0,
    }));
    const view = buildObservation({ now, extra: { ...rest, social: { unread: count, mentions }, note: 'Nothing here needs a reply from you this turn. Call finish now, with memory, agenda and summary under 30 words each and nextAt 2026-11-06T18:00:00.000Z.' } } as never, Math.max(bytes * 2, 120_000));
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(config, 'social', { phase: null }) },
      { role: 'user', content: JSON.stringify(view) },
    ];
    return buildRequest(config, messages, tools, THOUGHT_MAX_TOKENS, model) as unknown as Record<string, unknown>;
  };
  let count = 1;
  while (Buffer.byteLength(JSON.stringify(build(count))) < bytes) count += 1;
  return build(count);
}

/** A 64x64 solid PNG: the smallest real reference picture, built here so no picture is stored in the repo. */
export function referencePng(): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, sum]);
  };
  const size = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let i = 1; i < row.length; i += 3) {
    row[i] = 40;
    row[i + 1] = 120;
    row[i + 2] = 220;
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Tokens as BlockRun reports them; `prompt_tokens` includes the cached ones in OpenAI's form and leaves them out in Anthropic's. */
export function tokensOf(usage: unknown): { input: number; uncached: number; read: number; write: number; output: number } | null {
  const u = usage as { prompt_tokens?: number; completion_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; prompt_tokens_details?: { cached_tokens?: number; cached_creation_tokens?: number } } | null;
  if (typeof u?.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return null;
  const read = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0;
  const write = u.prompt_tokens_details?.cached_creation_tokens ?? u.cache_creation_input_tokens ?? 0;
  const input = u.prompt_tokens >= read + write ? u.prompt_tokens : u.prompt_tokens + read + write;
  return { input, uncached: input - read - write, read, write, output: u.completion_tokens };
}

/** Micro-USDC for these tokens at these per-million rates. */
export function costMicro(tokens: NonNullable<ReturnType<typeof tokensOf>>, rates: Rates): number {
  return tokens.uncached * rates.input + tokens.read * rates.cacheRead + tokens.write * rates.cacheWrite + tokens.output * rates.output;
}

async function readRates(doFetch: typeof fetch, url: string, shape: (model: Record<string, unknown>) => Rates | null, model: string): Promise<Rates | null> {
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(15_000) });
    const list = ((await res.json()) as { data?: Record<string, unknown>[] }).data ?? [];
    const row = list.find((m) => m.id === model);
    return row ? shape(row) : null;
  } catch {
    return null;
  }
}

const blockrunRates = (m: Record<string, unknown>): Rates | null => {
  const p = m.pricing as { input?: number; output?: number; cache_read?: number; cache_write?: number } | undefined;
  if (typeof p?.input !== 'number' || typeof p.output !== 'number') return null;
  return { input: p.input, output: p.output, cacheRead: p.cache_read ?? p.input, cacheWrite: p.cache_write ?? p.input };
};

const openRouterRates = (m: Record<string, unknown>): Rates | null => {
  const p = m.pricing as { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string } | undefined;
  if (!p?.prompt || !p.completion) return null;
  const perM = (v: string) => Number(v) * 1e6;
  return { input: perM(p.prompt), output: perM(p.completion), cacheRead: perM(p.input_cache_read ?? p.prompt), cacheWrite: perM(p.input_cache_write ?? p.prompt) };
};

type Kind = 'claude' | 'other' | 'image';

interface CallPlan {
  name: string;
  kind: Kind;
  model: string;
  /** What the relay would be sent, and what it would charge for it. */
  request: Record<string, unknown>;
  relayQuote: bigint | null;
  /** For a picture: BlockRun's own request. */
  imageBody?: Record<string, unknown>;
  ceiling: bigint;
  requirement: PaymentRequirements;
  bytes: number;
}

function relayQuoteOf(request: Record<string, unknown>): bigint | null {
  const quote = computeQuote(DEFAULT_PRICE_TABLE, request as never);
  return quote.ok ? quote.quote.quoteMicroUsdc : null;
}

/** The unpaid request: BlockRun's price, refused unless it names exactly what is expected. Prefers `upto`, as production does. */
async function quoteOf(doFetch: typeof fetch, url: string, body: Record<string, unknown>, payTo: Address, asset: Address): Promise<PaymentRequirements> {
  const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const header = res.headers.get('payment-required');
  if (res.status !== 402 || !header) throw new Refusal(`BlockRun answered ${res.status} to the unpaid request for ${String(body.model)} instead of a price: ${(await res.text()).slice(0, 300)}`);
  const accepts = decodePaymentRequiredHeader(header).accepts;
  for (const row of accepts) {
    if (row.network !== NETWORK) throw new Refusal(`BlockRun's 402 names another chain: ${row.network}, expected ${NETWORK}.`);
    if (!isAddressEqual(row.asset as Address, asset)) throw new Refusal(`BlockRun's 402 names another token: ${row.asset}, expected USDC ${asset}.`);
    if (!isAddressEqual(row.payTo as Address, payTo)) throw new Refusal(`BlockRun's 402 names another recipient: ${row.payTo}, expected ${payTo}.`);
  }
  const row = accepts.find((r) => r.scheme === 'upto') ?? accepts.find((r) => r.scheme === 'exact');
  if (!row) throw new Refusal(`BlockRun offers neither upto nor exact for ${String(body.model)}: ${accepts.map((a) => a.scheme).join(', ')}.`);
  return row;
}

type Chain = { state: 'moved'; amount: bigint; tx: Hex | null } | { state: 'unsettled' } | { state: 'unknown'; why: string };

interface CallResult {
  plan: CallPlan;
  /** No signature ever left: nothing to read on chain. */
  unsigned?: string;
  status?: number;
  latencyMs?: number;
  read?: DirectResponse;
  transportError?: string;
  chain?: Chain;
  claimed?: bigint | null;
  scheme?: string;
  usedPermit: boolean;
  tokens: ReturnType<typeof tokensOf>;
  /** The tool the model called, when it called one. */
  tool?: { name: string; valid: boolean; truncated: boolean; error?: string } | null;
  text?: string | null;
  picture?: { ok: boolean; detail: string };
  listMicro?: number | null;
  failure: string | null;
}

export async function runLiveCheck(deps: LiveCheckDeps): Promise<number> {
  const secrets: string[] = [];
  const out = (line: string) => deps.out(redact(line, secrets));
  try {
    return await run(deps, secrets, out);
  } catch (err) {
    if (err instanceof Refusal) {
      out(`REFUSED: ${err.message}`);
      out('Nothing was signed.');
      return EXIT_REFUSED;
    }
    out(`STOPPED: ${errorText(err)}`);
    return EXIT_FAILED;
  }
}

function errorText(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0]!.slice(0, 300);
}

async function run(deps: LiveCheckDeps, secrets: string[], out: (line: string) => void): Promise<number> {
  const args = parseArgs(deps.argv);
  const key = readKey(deps.env);
  secrets.push(key);
  delete deps.env.BLOCKRUN_TEST_PRIVATE_KEY;
  const account = privateKeyToAccount(key);
  const rpcUrl = deps.env.BLOCKRUN_TEST_RPC_URL || DEFAULT_RPC_URL;
  const rpcHost = new URL(rpcUrl).host;
  if (rpcUrl !== DEFAULT_RPC_URL) secrets.push(rpcUrl);
  const publicClient = deps.publicClient ?? (createPublicClient({ chain: base, transport: http(rpcUrl, { retryCount: 5, retryDelay: 1000 }) }) as unknown as PublicClient);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 10_000;
  const baseUrl = deps.env.BLOCKRUN_TEST_BASE_URL || DEFAULT_BLOCKRUN_URL;
  const addresses = getAddresses(CHAIN_ID);
  const world: DirectWorld & { resolveHost?: undefined } = { chain: { chainId: CHAIN_ID, publicClient: publicClient as never, addresses }, fetch: doFetch };
  const config: DirectPayConfig = { BLOCKRUN_BASE_URL: baseUrl, BLOCKRUN_PAYTO_ADDRESS: BLOCKRUN_DEFAULT_PAYTO, BLOCKRUN_ALLOW_EXACT: true, BLOCKRUN_PROMPT_CACHE: args.promptCache, BLOCKRUN_TIMEOUT_MS: deps.timeoutMs ?? 150_000 };
  const payTo = BLOCKRUN_DEFAULT_PAYTO as Address;

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Refusal(`The RPC is on chain ${chainId}; this check runs on Base (${CHAIN_ID}) only.`);

  const balanceOf = (holder: Address) => publicClient.readContract({ address: addresses.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
  const allowanceNow = () => publicClient.readContract({ address: addresses.usdc, abi: erc20Abi, functionName: 'allowance', args: [account.address, PERMIT2] });
  const [usdcBefore, ethBalance, allowanceBefore] = await Promise.all([balanceOf(account.address), publicClient.getBalance({ address: account.address }), allowanceNow()]);

  // Prices from unpaid requests: nothing is signed for these.
  const chatPlan = async (name: string, kind: Kind, model: string, bytes: number): Promise<CallPlan> => {
    const request = thoughtRequest(model, bytes);
    const body = directBody(config, request);
    const requirement = await quoteOf(doFetch, directUrl(config), body, payTo, addresses.usdc);
    return { name, kind, model, request, relayQuote: relayQuoteOf(request), ceiling: BigInt(requirement.amount), requirement, bytes: Buffer.byteLength(JSON.stringify(body)) };
  };
  const imagePlan = async (): Promise<CallPlan> => {
    const reference = referencePng();
    const request = imageRequest(IMAGE_MODEL, { prompt: 'A small blue circle on a white background.', altText: 'a blue circle' } as never, { reference, notes: '' });
    const translated = directImageBody(request)!;
    const imageBody: Record<string, unknown> = { ...translated.body, image: reference };
    const requirement = await quoteOf(doFetch, directImageUrl(config, 'image2image'), imageBody, payTo, addresses.usdc);
    return { name: 'picture from a reference', kind: 'image', model: String(imageBody.model), request, relayQuote: relayQuoteOf(request), imageBody, ceiling: BigInt(requirement.amount), requirement, bytes: Buffer.byteLength(JSON.stringify(imageBody)) };
  };
  const plans: CallPlan[] = [await chatPlan('tool call on Claude', 'claude', args.model, SMALL_THOUGHT_BYTES), await chatPlan('tool call on another model, thought size', 'other', OTHER_MODEL, THOUGHT_BYTES), await imagePlan()];
  if (args.full) {
    const real = await chatPlan('a real thought on Sonnet', 'claude', REAL_THOUGHT_MODEL, THOUGHT_BYTES);
    plans.push(real, { ...real, name: 'the same again, for the prompt cache' });
  }
  const totalCeiling = plans.reduce((sum, p) => sum + p.ceiling, 0n);
  const uptoCeilings = plans.filter((p) => p.requirement.scheme === 'upto').map((p) => p.ceiling);
  const largestPermit = uptoCeilings.reduce((m, c) => (c > m ? c : m), 0n);

  out('BlockRun live check');
  out(`  Wallet      ${account.address}`);
  out(`  Balances    ${usdc(usdcBefore)}, ${formatEther(ethBalance)} ETH on Base (read through ${rpcHost})`);
  out(`  Pays to     ${payTo}`);
  out(`  Token       USDC ${addresses.usdc}`);
  if (baseUrl !== DEFAULT_BLOCKRUN_URL) out(`  Endpoint    ${baseUrl} (not BlockRun's own)`);
  plans.forEach((plan, i) => out(`  Call ${i + 1}      ${plan.name}: ${plan.model}, ${plan.requirement.scheme}, ${(plan.bytes / 1000).toFixed(1)} kB, ceiling ${usd(plan.ceiling)}, relay would charge ${plan.relayQuote === null ? 'nothing it can quote' : usd(plan.relayQuote)}`));
  out(`  Total ceiling ${usd(totalCeiling)} (caps: ${usd(args.maxPerCall)} per call, ${usd(args.maxTotal)} in total). This is the worst case for this run.`);
  out('What this wallet needs');
  out(`  USDC        at least ${usdc(totalCeiling)} on Base. It holds ${usdc(usdcBefore)}.`);
  out('  ETH         none. The facilitator pays the gas.');
  if (largestPermit > 0n) {
    out('  Approval    no transaction. An upto call signs two gasless messages: a USDC permit letting Permit2 use exactly');
    out(`              that call's ceiling (at most ${usd(largestPermit)}), valid 300 s, and a Permit2 payment to the address above, at most the same amount.`);
    out(`              Permit2 allowance now: ${usdc(allowanceBefore)}. What a settled call leaves stays as allowance; Permit2 cannot use it without another signature from this key.`);
  }
  out('              An exact call signs one gasless USDC transfer of exactly its ceiling to the address above, and needs no approval.');

  for (const plan of plans) {
    if (plan.ceiling > args.maxPerCall) throw new Refusal(`Call "${plan.name}" could cost ${usd(plan.ceiling)}, above the ${usd(args.maxPerCall)} cap per call.`);
  }
  if (totalCeiling > args.maxTotal) throw new Refusal(`The calls could cost ${usd(totalCeiling)}, above the ${usd(args.maxTotal)} total cap.`);
  if (usdcBefore < totalCeiling) throw new Refusal(`The wallet holds ${usdc(usdcBefore)} and needs at least ${usdc(totalCeiling)}.`);
  if (!args.yes) {
    out('Not paying without --yes. Nothing was signed. The prices above came from unpaid requests.');
    return EXIT_OK;
  }

  const rates = new Map<string, { blockrun: Rates | null; openrouter: Rates | null }>();
  await Promise.all(
    [...new Set(plans.filter((p) => p.kind !== 'image').map((p) => p.model))].map(async (model) => {
      const [blockrun, openrouter] = await Promise.all([
        readRates(doFetch, `${baseUrl.replace(/\/+$/, '')}/models`, blockrunRates, model),
        readRates(doFetch, deps.env.BLOCKRUN_TEST_OPENROUTER_MODELS_URL || DEFAULT_OPENROUTER_MODELS_URL, openRouterRates, model),
      ]);
      rates.set(model, { blockrun, openrouter });
    }),
  );

  const results: CallResult[] = [];
  for (const plan of plans) {
    out('');
    out(`Call ${results.length + 1}: ${plan.name}`);
    const result = await payCall(plan, results.length);
    results.push(result);
    printCall(result);
    if (result.failure) {
      out(`  FAILED: ${result.failure}`);
      out('  Stopping here. Nothing is retried and no further call is made.');
      break;
    }
    // Lets the next read of the USDC permit nonce see this settlement on a load-balanced RPC.
    await sleep(BETWEEN_CALLS_MS);
  }

  const usdcAfter = await balanceOf(account.address).catch(() => null);
  const allowanceAfter = await allowanceNow().catch(() => null);
  const ethAfter = await publicClient.getBalance({ address: account.address }).catch(() => null);
  const moved = results.reduce((sum, r) => sum + (r.chain?.state === 'moved' ? r.chain.amount : 0n), 0n);
  out('');
  out('Totals');
  out(`  Moved on chain      ${usd(moved)} (the most it could have been: ${usd(results.reduce((s, r) => s + r.plan.ceiling, 0n))})`);
  if (usdcAfter !== null) out(`  Wallet USDC         ${usdc(usdcBefore)} -> ${usdc(usdcAfter)}`);
  if (allowanceAfter !== null && allowanceAfter > 0n) out(`  Permit2 allowance   ${usdc(allowanceAfter)} left. It needs another signature from this key to be used.`);
  return printVerdicts(results, plans.length, usdcAfter === null ? null : usdcBefore - usdcAfter, moved, ethAfter !== null ? ethBalance - ethAfter : null);

  async function payCall(plan: CallPlan, index: number): Promise<CallResult> {
    const result: CallResult = { plan, usedPermit: false, tokens: null, failure: null };
    const startBlock = await publicClient.getBlockNumber().catch(() => null);
    const holder: { payment: PaymentPayload | null } = { payment: null };
    const started = now();
    let res: Response | null = null;
    try {
      res = await directPost(world, config, {
        signer: account,
        key: `live-check:${index}:${started}`,
        request: plan.imageBody ?? plan.request,
        ...(plan.imageBody ? { imagePath: 'image2image' as const } : {}),
        // The ceiling shown above: a price that has moved since is refused, not paid.
        maxQuoteMicroUsdc: plan.ceiling,
        onPayment: async (payload) => {
          const a = payload.accepted;
          if (a.network !== NETWORK || !isAddressEqual(a.asset as Address, addresses.usdc) || !isAddressEqual(a.payTo as Address, payTo)) throw new Refusal(`BlockRun's price changed what it asks for: ${a.scheme}, ${a.network}, ${a.asset}, ${a.payTo}.`);
          await requireFloat(world, account.address, BigInt(a.amount));
          const auth = paymentAuthorization(payload);
          if (!auth) throw new Refusal('The signed payment cannot be read back, so its outcome could not be checked. Not sending it.');
          result.scheme = a.scheme;
          result.usedPermit = !!(payload.extensions as { eip2612GasSponsoring?: { info?: { signature?: string } } } | undefined)?.eip2612GasSponsoring?.info?.signature;
          out(`  Signed ${a.scheme} for at most ${usd(BigInt(a.amount))}, usable until ${new Date(auth.deadline * 1000).toISOString()}.${result.usedPermit ? ' With a USDC permit for exactly that amount.' : ''}`);
          holder.payment = payload;
        },
      });
    } catch (err) {
      result.latencyMs = now() - started;
      if (!holder.payment) {
        result.unsigned = err instanceof InsufficientFloatError ? 'the wallet no longer holds the ceiling' : errorText(err);
        result.failure = `no signature left this machine: ${result.unsigned}`;
        return result;
      }
      result.transportError = errorText(err);
      out(`  No response: ${result.transportError}. Reading the chain instead of retrying.`);
    }
    result.latencyMs = now() - started;
    if (res) result.status = res.status;
    if (!holder.payment) {
      result.unsigned = `BlockRun answered ${res?.status} before any payment was signed`;
      result.failure = `no signature left this machine: ${result.unsigned}`;
      return result;
    }
    const payment = holder.payment;
    const claim = res ? settlementClaim(res) : { tx: null, claimed: null };
    result.claimed = claim.claimed;
    let tx = claim.tx;

    if (plan.kind === 'image') {
      if (res) tx = (await readPicture(res, payment, result)) ?? tx;
    } else {
      if (res) result.read = await readDirectResponse(res);
      if (result.read?.answer) readThought(result, result.read.answer);
    }
    if (tx === null || result.read?.settled === false) out('  Settlement not confirmed in the response. Reading the chain until it lands or the signature expires.');
    result.chain = await readChain(payment, tx, startBlock);
    const rate = rates.get(plan.model)?.blockrun;
    if (result.tokens && rate) result.listMicro = costMicro(result.tokens, rate) + BLOCKRUN_FEE_MICRO;
    result.failure = failureOf(result);
    return result;
  }

  function readThought(result: CallResult, body: Record<string, unknown>): void {
    result.tokens = tokensOf(body.usage);
    const { message, toolCall, truncated } = parseAssistant(body);
    result.text = typeof message.content === 'string' ? message.content : null;
    if (!toolCall) {
      result.tool = null;
      return;
    }
    try {
      parseToolInput(toolCall.name as ToolName, toolCall.input);
      result.tool = { name: toolCall.name, valid: true, truncated };
    } catch (err) {
      result.tool = { name: toolCall.name, valid: false, truncated, error: errorText(err) };
    }
  }

  /** A picture answer, read and parsed as `images.ts` does. Returns the settlement transaction when the body names one. */
  async function readPicture(res: Response, payment: PaymentPayload, result: CallResult): Promise<Hex | null> {
    const body = (await res.json().catch(() => null)) as { status?: unknown; poll_url?: unknown; data?: { url?: unknown }[]; price?: unknown; code?: unknown; error?: unknown; payment?: { tx_hash?: unknown } } | null;
    let answer: Record<string, unknown> | null = null;
    let tx: Hex | null = typeof body?.payment?.tx_hash === 'string' ? (body.payment.tx_hash as Hex) : null;
    if (res.status === 202) {
      const url = pollAddress(config, body?.poll_url);
      if (!url) {
        result.picture = { ok: false, detail: 'a slow picture with no poll address on BlockRun’s origin' };
        return null;
      }
      out('  A slow picture. Polling; it is paid on the first poll that sees it done.');
      const auth = paymentAuthorization(payment)!;
      while (now() / 1000 <= auth.deadline) {
        const job = await readImageJob(world, payment, url);
        if (job.state === 'done') {
          answer = job.answer;
          tx = (job.tx as Hex | null) ?? tx;
          break;
        }
        if (job.state === 'failed') {
          result.picture = { ok: false, detail: 'BlockRun could not make the picture' };
          return null;
        }
        await sleep(pollMs);
      }
    } else if (res.ok && Array.isArray(body?.data)) {
      answer = await imageAnswer(world, body);
    }
    if (!answer) {
      result.picture = result.picture ?? { ok: false, detail: `HTTP ${res.status}${typeof body?.code === 'string' ? ` ${body.code}` : ''}: no picture` };
      return tx;
    }
    const parsed = parseImageResponse(answer);
    result.picture = parsed.ok ? { ok: true, detail: `${parsed.mime}, ${parsed.bytes.length} bytes` } : { ok: false, detail: parsed.error };
    return tx;
  }

  /** The chain alone says what happened to a signature: its nonce spent, or its deadline passed unspent. Never a second payment. */
  async function readChain(payment: PaymentPayload, tx: Hex | null, startBlock: bigint | null): Promise<Chain> {
    const auth = paymentAuthorization(payment)!;
    let lastError = '';
    for (;;) {
      let spent = false;
      try {
        spent = await paymentSettled(world, auth);
        lastError = '';
      } catch (err) {
        lastError = errorText(err);
      }
      if (spent) {
        const amount = tx ? await settledOnChain(world, tx, account.address, payTo) : null;
        if (amount !== null) return { state: 'moved', amount, tx };
        const found = await findTransfer(startBlock);
        if (found) return { state: 'moved', ...found };
        // Spent, and the transfer not readable yet: the RPC may be behind. Keep reading until the deadline.
      }
      if (now() / 1000 > auth.deadline + DEADLINE_GRACE_SECONDS) {
        if (spent) return { state: 'unknown', why: 'the payment is spent on chain but its USDC transfer could not be read' };
        return lastError ? { state: 'unknown', why: `the chain could not be read: ${lastError}` } : { state: 'unsettled' };
      }
      await sleep(pollMs);
    }
  }

  async function findTransfer(startBlock: bigint | null): Promise<{ amount: bigint; tx: Hex } | null> {
    try {
      const logs = await publicClient.getLogs({ address: addresses.usdc, event: TRANSFER, args: { from: account.address, to: payTo }, ...(startBlock !== null ? { fromBlock: startBlock } : {}), toBlock: 'latest' });
      const last = logs.at(-1);
      return last?.args.value !== undefined && last.transactionHash ? { amount: last.args.value, tx: last.transactionHash } : null;
    } catch {
      return null;
    }
  }

  function failureOf(r: CallResult): string | null {
    const ceiling = r.plan.ceiling;
    if (r.chain?.state === 'moved' && r.chain.amount > ceiling) return `BlockRun moved ${usd(r.chain.amount)}, above the signed ${usd(ceiling)}. Stop and report this.`;
    const answered = r.plan.kind === 'image' ? !!r.picture?.ok : !!r.read?.answer;
    if (!answered) {
      const why = r.transportError ?? r.picture?.detail ?? r.read?.error ?? 'no answer';
      if (r.chain?.state === 'moved') return `${why}. The money moved and no answer came back: lost ${usd(r.chain.amount)}.`;
      if (r.chain?.state === 'unsettled') return `${why}. The signature expired unused: nothing was charged.`;
      return `${why}. Outcome unknown: ${(r.chain as { why?: string } | undefined)?.why}. Check the wallet on basescan.org before running this again.`;
    }
    if (r.read?.fallback) return `BlockRun answered with another model: ${String(r.read.servedModel)}.`;
    if (r.chain?.state === 'unsettled') return 'BlockRun answered but never settled, so nothing moved and the cost could not be measured.';
    if (r.chain?.state === 'unknown') return `The answer came, but the cost could not be read: ${r.chain.why}. Check the wallet on basescan.org before running this again.`;
    if (r.plan.kind !== 'image') {
      if (!r.tool) return 'the model answered with text instead of a tool call.';
      // A call cut off at the limit is no rejection: the tools were accepted, and production retries it. Reported below.
      if (!r.tool.valid && !r.tool.truncated) return `the model called ${r.tool.name} with arguments the tool rejects: ${r.tool.error}`;
    }
    return null;
  }

  function printCall(r: CallResult): void {
    if (r.unsigned) return;
    const plan = r.plan;
    out(`  HTTP        ${r.status ?? 'no response'}${r.latencyMs !== undefined ? ` in ${(r.latencyMs / 1000).toFixed(1)} s` : ''}`);
    if (r.read) out(`  Served by   ${String(r.read.servedModel ?? 'not reported')}, fallback: ${r.read.fallback ? 'YES' : 'no'}${r.read.contextTruncated ? ', prompt TRIMMED by BlockRun' : ''}`);
    if (r.tool) out(`  Answer      tool call ${r.tool.name}, ${r.tool.truncated ? `CUT OFF at the output limit of ${THOUGHT_MAX_TOKENS} tokens` : r.tool.valid ? 'arguments valid' : `arguments INVALID: ${r.tool.error}`}`);
    else if (r.read?.answer) out(`  Answer      text: ${(r.text ?? '').slice(0, 120)}`);
    else if (r.read) out(`  Answer      none (${r.read.error})`);
    if (r.picture) out(`  Picture     ${r.picture.ok ? 'readable' : 'NOT readable'}: ${r.picture.detail}`);
    if (r.tokens) out(`  Tokens      input ${r.tokens.input} (cache read ${r.tokens.read}, cache write ${r.tokens.write}), output ${r.tokens.output}`);
    else if (r.read?.answer) out('  Tokens      not reported');
    out(`  Ceiling     ${usd(plan.ceiling)} (${r.scheme ?? plan.requirement.scheme})`);
    if (r.chain?.state === 'moved') out(`  Moved       ${usd(r.chain.amount)}, tx ${r.chain.tx ?? 'not found'}`);
    else if (r.chain?.state === 'unsettled') out('  Moved       $0.000000: the signature expired unused');
    else if (r.chain) out(`  Moved       unknown: ${r.chain.why}`);
    if (r.claimed !== undefined) out(`  BlockRun says it settled ${r.claimed === null ? 'nothing it reports' : usd(r.claimed)}`);
    if (r.listMicro != null) out(`  BlockRun list price for these tokens + $0.001: ${usd(Math.round(r.listMicro))}`);
    const openrouter = rates.get(plan.model)?.openrouter;
    if (r.tokens && openrouter) out(`  OpenRouter for the same tokens: ${usd(Math.round(costMicro(r.tokens, openrouter)))}`);
    out(`  Relay charge for this request: ${plan.relayQuote === null ? 'none it can quote' : usd(plan.relayQuote)}`);
  }

  function printVerdicts(all: CallResult[], planned: number, walletDelta: bigint | null, movedTotal: bigint, ethSpent: bigint | null): number {
    type Result = 'PASS' | 'FAIL' | 'NOT REACHED';
    const moved = (r: CallResult | undefined) => (r?.chain?.state === 'moved' ? r.chain.amount : null);
    const paid = all.filter((r) => r.chain?.state === 'moved');
    const goals: { goal: string; result: Result; detail: string }[] = [];
    const add = (goal: string, result: Result, detail: string) => goals.push({ goal, result, detail });

    if (paid.length === 0) add('It pays from its own wallet, with no ETH', all.length ? 'FAIL' : 'NOT REACHED', all[0]?.failure ?? 'nothing settled');
    else if (walletDelta === null) add('It pays from its own wallet, with no ETH', 'FAIL', 'the wallet balance could not be read at the end');
    else if (walletDelta !== movedTotal) add('It pays from its own wallet, with no ETH', 'FAIL', `the wallet went down by ${usd(walletDelta)}; the settled calls add up to ${usd(movedTotal)}`);
    else if (ethSpent !== null && ethSpent > 0n) add('It pays from its own wallet, with no ETH', 'FAIL', `the wallet spent ${formatEther(ethSpent)} ETH`);
    else add('It pays from its own wallet, with no ETH', 'PASS', `${paid.length} payment${paid.length === 1 ? '' : 's'}, one per signature, ${usd(movedTotal)} in all`);

    const compared = paid.filter((r) => r.plan.relayQuote !== null);
    const dearer = compared.find((r) => moved(r)! > r.plan.relayQuote!);
    if (compared.length === 0) add('It costs no more than the relay charges', 'NOT REACHED', '');
    else if (dearer) add('It costs no more than the relay charges', 'FAIL', `${dearer.plan.name}: ${usd(moved(dearer)!)} against ${usd(dearer.plan.relayQuote!)}`);
    else add('It costs no more than the relay charges', 'PASS', compared.map((r) => `${usd(moved(r)!)} against ${usd(r.plan.relayQuote!)}`).join(', '));

    const tools = (goal: string, kind: Kind) => {
      const r = all.find((x) => x.plan.kind === kind);
      if (!r) add(goal, 'NOT REACHED', '');
      else if (r.tool?.valid && !r.tool.truncated) add(goal, 'PASS', `${r.plan.model} called ${r.tool.name} with valid arguments`);
      else if (r.tool?.truncated) add(goal, 'PASS', `${r.plan.model} accepted the tools; its ${r.tool.name} call was cut off at the output limit, which production retries`);
      else add(goal, 'FAIL', r.failure ?? 'no valid tool call');
    };
    tools('Tool calls work on Claude', 'claude');
    tools('Tool calls work on other models', 'other');

    const picture = all.find((r) => r.plan.kind === 'image');
    if (!picture) add('Pictures work', 'NOT REACHED', '');
    else add('Pictures work', picture.picture?.ok && picture.chain?.state === 'moved' ? 'PASS' : 'FAIL', picture.picture?.detail ?? picture.failure ?? 'no picture');

    const answered = all.filter((r) => r.read?.answer);
    if (answered.length === 0) add('The model asked for is the model that answers', 'NOT REACHED', '');
    else {
      const fell = answered.find((r) => r.read?.fallback);
      add('The model asked for is the model that answers', fell ? 'FAIL' : 'PASS', fell ? `answered by ${String(fell.read?.servedModel)}` : `${answered.length} of ${answered.length} without a fallback`);
    }
    if (all.length < planned) add('Every planned call ran', 'FAIL', `stopped after ${all.length} of ${planned}`);

    out('');
    out('Verdict against the goal');
    for (const g of goals) out(`  ${g.result.padEnd(11)} ${g.goal}${g.detail ? `: ${g.detail}` : ''}`);

    out('');
    out('Measured, not judged');
    const uptoPaid = paid.filter((r) => r.scheme === 'upto');
    if (uptoPaid.length) out(`  upto settled ${uptoPaid.map((r) => `${usd(moved(r)!)} of ${usd(r.plan.ceiling)}${r.listMicro != null ? ` (list price ${usd(Math.round(r.listMicro))})` : ''}`).join(', ')}`);
    const reported = paid.filter((r) => r.claimed !== undefined && r.claimed !== null).length;
    out(`  PAYMENT-RESPONSE named the settled amount on ${reported} of ${paid.length} payments`);
    const slowest = Math.max(0, ...all.map((r) => r.latencyMs ?? 0));
    out(`  Slowest call ${(slowest / 1000).toFixed(1)} s${slowest > SLOW_CALL_MS ? ', slow' : ''}`);
    const real = all.find((r) => r.plan.name === 'a real thought on Sonnet');
    const repeat = all.find((r) => r.plan.name === 'the same again, for the prompt cache');
    if (real?.tokens) {
      const local = countInputTokens(real.plan.request as never);
      out(`  A real thought: billed ${real.tokens.input} input tokens, counted ${local} here (o200k), output ${real.tokens.output}`);
    }
    if (repeat?.tokens) out(`  Prompt cache on the repeat: ${repeat.tokens.read} tokens read, ${repeat.tokens.write} written; moved ${moved(repeat) === null ? 'unknown' : usd(moved(repeat)!)} against ${moved(real) === null ? 'unknown' : usd(moved(real)!)} the first time`);
    const cap = maxQuoteFor(all[0]?.plan.model ?? CLAUDE_MODEL);
    if (all[0]) out(`  ${all[0].plan.model}: this call's ceiling ${usd(all[0].plan.ceiling)}, production's cap ${usd(cap)}`);
    out("  OpenRouter's reported 5.5% purchase fee cannot be seen from here.");

    const failed = goals.filter((g) => g.result !== 'PASS').length;
    out('');
    out(failed === 0 ? 'PASS' : `FAIL (${failed} of ${goals.length} failed or were not reached)`);
    return failed === 0 ? EXIT_OK : EXIT_FAILED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runLiveCheck({ env: process.env, argv: process.argv.slice(2), out: (line) => console.log(line) });
}
