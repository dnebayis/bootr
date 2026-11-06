/**
 * The owner's first real paid call to BlockRun, from a dev wallet on their own machine, before production is touched.
 * It pays through the same code an agent does (`src/blockrun.ts`, `src/inference.ts`, `@bootr/inference/client`), so a
 * pass here proves that path, not a copy of it. See apps/supervisor/README.md, "BlockRun live check".
 *
 * Money rules:
 *  - Nothing is signed without `--yes`. The prices shown first come from unpaid requests.
 *  - `upto` only, at most the ceiling shown for each call, to BlockRun's address only, in USDC on Base only.
 *  - One signature per call and no retry, ever. Whatever goes wrong after a signature (no answer, a timeout, a slow
 *    settlement) is answered by reading the chain until the nonce is spent or the signature is dead.
 *  - The first failure stops the run.
 *
 * The key comes from `BLOCKRUN_TEST_PRIVATE_KEY` only and every printed line passes through `redact`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { agentConfigSchema, buildObservation, buildSystemPrompt, parseToolInput, toolsFor, type ChatMessage, type ToolName } from '@bootr/agent-core';
import { computeQuote, countInputTokens, DEFAULT_PRICE_TABLE } from '@bootr/inference';
import { getAddresses } from '@bootr/shared/addresses';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createPublicClient, erc20Abi, formatEther, http, isAddressEqual, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { DEADLINE_GRACE_SECONDS, directBody, directPost, directUrl, InsufficientFloatError, paymentAuthorization, paymentSettled, readDirectResponse, requireFloat, settledOnChain, settlementClaim, type DirectPayConfig, type DirectResponse, type DirectWorld } from '../src/blockrun.js';
import { BLOCKRUN_DEFAULT_PAYTO } from '../src/config.js';
import { buildRequest, parseAssistant } from '../src/inference.js';

export const DEFAULT_RPC_URL = 'https://mainnet.base.org';
export const DEFAULT_BLOCKRUN_URL = 'https://blockrun.ai/api/v1';
const DEFAULT_OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';
export const CAP_PER_CALL_MICRO = 150_000n;
export const CAP_TOTAL_MICRO = 400_000n;
/** About what one thought of the $BOOTR agent weighs on the wire. */
export const THOUGHT_BYTES = 61_000;
const THOUGHT_MAX_TOKENS = 1024;
const TINY_MAX_TOKENS = 32;
const CHAIN_ID = 8453;
const NETWORK = `eip155:${CHAIN_ID}`;
const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** BlockRun's flat fee on a paid chat call. */
const BLOCKRUN_FEE_MICRO = 1000;
/** How far above the list price a settlement may be and still count as "the real cost". */
const REAL_COST_TOLERANCE = 1.25;
const TOKEN_PROXY_TOLERANCE = 0.25;
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
  const args: Args = { yes: false, model: DEFAULT_MODEL, maxPerCall: CAP_PER_CALL_MICRO, maxTotal: CAP_TOTAL_MICRO };
  for (const arg of argv) {
    // Before anything else, and never echoed: an argument ends up in the shell history and the process list.
    if (/(^|=)(0x)?[0-9a-fA-F]{64}$/.test(arg)) throw new Refusal('That looks like a private key on the command line. The key is read from BLOCKRUN_TEST_PRIVATE_KEY only. Treat the key as exposed.');
    if (arg === '--yes') args.yes = true;
    else if (arg.startsWith('--model=')) args.model = arg.slice('--model='.length);
    else if (arg.startsWith('--max-per-call=')) args.maxPerCall = microOf('--max-per-call', arg.slice('--max-per-call='.length));
    else if (arg.startsWith('--max-total=')) args.maxTotal = microOf('--max-total', arg.slice('--max-total='.length));
    else throw new Refusal(`Unknown argument. Allowed: --yes, --model=<id>, --max-per-call=<usd>, --max-total=<usd>.`);
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

const fixture = (): { config: unknown; observation: { mentionTexts: string[] } & Record<string, unknown> } =>
  JSON.parse(readFileSync(new URL('./fixtures/blockrun-thought.json', import.meta.url), 'utf8'));

/** The small first call: no tools, a word of output. */
export function tinyRequest(model: string): Record<string, unknown> {
  const config = agentConfigSchema.parse(fixture().config);
  return buildRequest(config, [{ role: 'user', content: 'Reply with the single word ok.' }], [], TINY_MAX_TOKENS, model) as unknown as Record<string, unknown>;
}

/**
 * One thought as the runtime builds it: the real system prompt and tool list for a made-up agent, an observation in the
 * real shape, grown with made-up mentions to the size of a real one. Fixed time and content, so the second send is
 * byte for byte the first and a prompt cache can hit.
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
    const view = buildObservation({ now, extra: { ...rest, social: { unread: count, mentions }, note: 'Nothing here needs a reply from you this turn. Call finish with a short checkpoint: memory, agenda, summary and nextAt 2026-11-06T18:00:00.000Z.' } } as never, bytes * 2);
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

interface CallPlan {
  name: string;
  request: Record<string, unknown>;
  ceiling: bigint;
  requirement: PaymentRequirements;
  bytes: number;
}

/** The unpaid request: BlockRun's price, refused unless it names exactly what is expected. */
async function quoteOf(doFetch: typeof fetch, config: DirectPayConfig, asset: Address, request: Record<string, unknown>): Promise<PaymentRequirements> {
  const res = await doFetch(directUrl(config), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(directBody(config, request)), signal: AbortSignal.timeout(15_000) });
  const header = res.headers.get('payment-required');
  if (res.status !== 402 || !header) throw new Refusal(`BlockRun answered ${res.status} to the unpaid request instead of a price: ${(await res.text()).slice(0, 300)}`);
  const accepts = decodePaymentRequiredHeader(header).accepts;
  for (const row of accepts) {
    if (row.network !== NETWORK) throw new Refusal(`BlockRun's 402 names another chain: ${row.network}, expected ${NETWORK}.`);
    if (!isAddressEqual(row.asset as Address, asset)) throw new Refusal(`BlockRun's 402 names another token: ${row.asset}, expected USDC ${asset}.`);
    if (!isAddressEqual(row.payTo as Address, config.BLOCKRUN_PAYTO_ADDRESS as Address)) throw new Refusal(`BlockRun's 402 names another recipient: ${row.payTo}, expected ${config.BLOCKRUN_PAYTO_ADDRESS}.`);
  }
  const upto = accepts.find((row) => row.scheme === 'upto');
  if (!upto) throw new Refusal(`BlockRun does not offer upto for this model (offered: ${accepts.map((a) => a.scheme).join(', ')}). This check pays upto only.`);
  return upto;
}

type Chain = { state: 'moved'; amount: bigint; tx: Hex | null } | { state: 'unsettled' } | { state: 'unknown'; why: string };

interface CallResult {
  name: string;
  /** No signature ever left: nothing to read on chain. */
  unsigned?: string;
  status?: number;
  latencyMs?: number;
  read?: DirectResponse;
  transportError?: string;
  chain?: Chain;
  ceiling: bigint;
  claimed?: bigint | null;
  usedPermit: boolean;
  tokens: ReturnType<typeof tokensOf>;
  /** The tool the model called, when it called one. */
  tool?: { name: string; valid: boolean; error?: string } | null;
  text?: string | null;
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
  const e = err as { shortMessage?: string; message?: string; name?: string };
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
  const world: DirectWorld = { chain: { chainId: CHAIN_ID, publicClient: publicClient as never, addresses }, fetch: doFetch };
  const config: DirectPayConfig = { BLOCKRUN_BASE_URL: baseUrl, BLOCKRUN_PAYTO_ADDRESS: BLOCKRUN_DEFAULT_PAYTO, BLOCKRUN_ALLOW_EXACT: false, BLOCKRUN_PROMPT_CACHE: true, BLOCKRUN_TIMEOUT_MS: deps.timeoutMs ?? 150_000 };
  const payTo = BLOCKRUN_DEFAULT_PAYTO as Address;

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) throw new Refusal(`The RPC is on chain ${chainId}; this check runs on Base (${CHAIN_ID}) only.`);

  const balanceOf = (holder: Address) => publicClient.readContract({ address: addresses.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
  const allowanceNow = () => publicClient.readContract({ address: addresses.usdc, abi: erc20Abi, functionName: 'allowance', args: [account.address, PERMIT2] });
  const [usdcBefore, ethBalance, allowanceBefore] = await Promise.all([balanceOf(account.address), publicClient.getBalance({ address: account.address }), allowanceNow()]);

  // Prices from unpaid requests: nothing is signed for these.
  const tiny = tinyRequest(args.model);
  const thought = thoughtRequest(args.model);
  const tinyQuote = await quoteOf(doFetch, config, addresses.usdc, tiny);
  const thoughtQuote = await quoteOf(doFetch, config, addresses.usdc, thought);
  const plans: CallPlan[] = [
    { name: '1 tiny', request: tiny, ceiling: BigInt(tinyQuote.amount), requirement: tinyQuote, bytes: Buffer.byteLength(JSON.stringify(directBody(config, tiny))) },
    { name: '2 realistic', request: thought, ceiling: BigInt(thoughtQuote.amount), requirement: thoughtQuote, bytes: Buffer.byteLength(JSON.stringify(directBody(config, thought))) },
    { name: '3 same again (prompt cache)', request: thought, ceiling: BigInt(thoughtQuote.amount), requirement: thoughtQuote, bytes: Buffer.byteLength(JSON.stringify(directBody(config, thought))) },
  ];
  const totalCeiling = plans.reduce((sum, p) => sum + p.ceiling, 0n);

  out('BlockRun live check');
  out(`  Wallet      ${account.address}`);
  out(`  Balances    ${usdc(usdcBefore)}, ${formatEther(ethBalance)} ETH on Base (read through ${rpcHost})`);
  out(`  Model       ${args.model}`);
  out('  Scheme      upto: pays the real cost of the call, never more than the ceiling');
  out(`  Pays to     ${payTo}`);
  out(`  Token       USDC ${addresses.usdc}`);
  if (baseUrl !== DEFAULT_BLOCKRUN_URL) out(`  Endpoint    ${baseUrl} (not BlockRun's own)`);
  for (const plan of plans) out(`  Call ${plan.name.padEnd(28)} ${(plan.bytes / 1000).toFixed(1).padStart(5)} kB   ceiling ${usd(plan.ceiling)}`);
  out(`  Total ceiling ${usd(totalCeiling)} (caps: ${usd(args.maxPerCall)} per call, ${usd(args.maxTotal)} in total)`);
  out('What this wallet needs');
  out(`  USDC        at least ${usdc(totalCeiling)} on Base. It holds ${usdc(usdcBefore)}.`);
  out('  ETH         none. The facilitator pays the gas.');
  out('  Approval    no transaction. For each call the key signs two gasless messages:');
  out(`              a USDC permit letting Permit2 use exactly that call's ceiling (at most ${usd(plans[1]!.ceiling)}), valid 300 s,`);
  out('              and a Permit2 payment to the address above, at most the same amount, valid 300 s.');
  out(`              Permit2 allowance now: ${usdc(allowanceBefore)}. ${allowanceBefore > 0n ? 'If it already covers a call, that call needs no permit. ' : ''}What a settled call leaves behind (ceiling minus cost) stays as allowance; Permit2 cannot use it without another signature from this key.`);

  for (const plan of plans) {
    if (plan.ceiling > args.maxPerCall) throw new Refusal(`Call ${plan.name} could cost ${usd(plan.ceiling)}, above the ${usd(args.maxPerCall)} cap per call.`);
  }
  if (totalCeiling > args.maxTotal) throw new Refusal(`The three calls could cost ${usd(totalCeiling)}, above the ${usd(args.maxTotal)} total cap.`);
  if (usdcBefore < totalCeiling) throw new Refusal(`The wallet holds ${usdc(usdcBefore)} and needs at least ${usdc(totalCeiling)}.`);
  if (!args.yes) {
    out('Not paying without --yes. Nothing was signed. The prices above came from unpaid requests.');
    return EXIT_OK;
  }

  const [blockrun, openrouter] = await Promise.all([
    readRates(doFetch, `${baseUrl.replace(/\/+$/, '')}/models`, blockrunRates, args.model),
    readRates(doFetch, deps.env.BLOCKRUN_TEST_OPENROUTER_MODELS_URL || DEFAULT_OPENROUTER_MODELS_URL, openRouterRates, args.model),
  ]);

  const results: CallResult[] = [];
  for (const plan of plans) {
    out('');
    out(`Call ${plan.name}`);
    const result = await payCall(plan, results.length);
    results.push(result);
    printCall(result, plan);
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
  const moved = results.reduce((sum, r) => sum + (r.chain?.state === 'moved' ? r.chain.amount : 0n), 0n);
  out('');
  out('Totals');
  out(`  Moved on chain      ${usd(moved)} (the most it could have been: ${usd(results.reduce((s, r) => s + r.ceiling, 0n))})`);
  if (usdcAfter !== null) out(`  Wallet USDC         ${usdc(usdcBefore)} -> ${usdc(usdcAfter)}`);
  if (allowanceAfter !== null) out(`  Permit2 allowance   ${usdc(allowanceAfter)} left. It needs another signature from this key to be used.`);
  return printVerdicts(results, plans, usdcAfter === null ? null : usdcBefore - usdcAfter, moved);

  async function payCall(plan: CallPlan, index: number): Promise<CallResult> {
    const result: CallResult = { name: plan.name, ceiling: plan.ceiling, usedPermit: false, tokens: null, failure: null };
    const startBlock = await publicClient.getBlockNumber().catch(() => null);
    const holder: { payment: PaymentPayload | null } = { payment: null };
    const started = now();
    let res: Response | null = null;
    try {
      res = await directPost(world, config, {
        signer: account,
        key: `live-check:${index}:${started}`,
        request: plan.request,
        // The ceiling shown above: a price that has moved since is refused, not paid.
        maxQuoteMicroUsdc: plan.ceiling,
        onPayment: async (payload) => {
          const a = payload.accepted;
          if (a.scheme !== 'upto' || a.network !== NETWORK || !isAddressEqual(a.asset as Address, addresses.usdc) || !isAddressEqual(a.payTo as Address, payTo)) throw new Refusal(`BlockRun's price changed what it asks for: ${a.scheme}, ${a.network}, ${a.asset}, ${a.payTo}.`);
          await requireFloat(world, account.address, BigInt(a.amount));
          const auth = paymentAuthorization(payload);
          if (!auth) throw new Refusal('The signed payment cannot be read back, so its outcome could not be checked. Not sending it.');
          result.usedPermit = !!(payload.extensions as { eip2612GasSponsoring?: { info?: { signature?: string } } } | undefined)?.eip2612GasSponsoring?.info?.signature;
          out(`  Signed for at most ${usd(BigInt(a.amount))}, usable until ${new Date(auth.deadline * 1000).toISOString()}. ${result.usedPermit ? `With a USDC permit for exactly that amount.` : 'No permit: the allowance already covers it.'}`);
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
    if (res) result.read = await readDirectResponse(res);
    if (result.read?.answer) {
      const body = result.read.answer;
      result.tokens = tokensOf(body.usage);
      const { message, toolCall } = parseAssistant(body);
      result.text = typeof message.content === 'string' ? message.content : null;
      if (toolCall) {
        try {
          parseToolInput(toolCall.name as ToolName, toolCall.input);
          result.tool = { name: toolCall.name, valid: true };
        } catch (err) {
          result.tool = { name: toolCall.name, valid: false, error: errorText(err) };
        }
      } else {
        result.tool = null;
      }
    }
    if (claim.tx === null || result.read?.settled === false) out('  Settlement not confirmed in the response. Reading the chain until it lands or the signature expires.');
    result.chain = await readChain(payment, claim.tx, startBlock);
    if (result.tokens && blockrun) result.listMicro = costMicro(result.tokens, blockrun) + BLOCKRUN_FEE_MICRO;
    result.failure = failureOf(result, plan);
    return result;
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

  function failureOf(r: CallResult, plan: CallPlan): string | null {
    if (r.chain?.state === 'moved' && r.chain.amount > r.ceiling) return `BlockRun moved ${usd(r.chain.amount)}, above the signed ${usd(r.ceiling)}. Stop and report this.`;
    if (!r.read?.answer) {
      const why = r.transportError ?? r.read?.error ?? 'no answer';
      if (r.chain?.state === 'moved') return `${why}. The money moved and no answer came back: lost ${usd(r.chain.amount)}.`;
      if (r.chain?.state === 'unsettled') return `${why}. The signature expired unused: nothing was charged.`;
      return `${why}. Outcome unknown: ${(r.chain as { why?: string } | undefined)?.why}. Check the wallet on basescan.org before running this again.`;
    }
    if (r.read.fallback) return `BlockRun answered with another model: ${String(r.read.servedModel)}.`;
    if (r.chain?.state === 'unsettled') return 'BlockRun answered but never settled, so nothing moved and the cost could not be measured.';
    if (r.chain?.state === 'unknown') return `The answer came, but the cost could not be read: ${r.chain.why}. Check the wallet on basescan.org before running this again.`;
    if (plan.name !== '1 tiny' && (!r.tool || !r.tool.valid)) return r.tool ? `the model called ${r.tool.name} with arguments the tool rejects: ${r.tool.error}` : 'the model answered with text instead of a tool call.';
    return null;
  }

  function printCall(r: CallResult, plan: CallPlan): void {
    if (r.unsigned) return;
    out(`  HTTP        ${r.status ?? 'no response'}${r.latencyMs !== undefined ? ` in ${(r.latencyMs / 1000).toFixed(1)} s` : ''}`);
    if (r.read) out(`  Served by   ${String(r.read.servedModel ?? 'not reported')}, fallback: ${r.read.fallback ? 'YES' : 'no'}${r.read.contextTruncated ? ', prompt TRIMMED by BlockRun' : ''}`);
    if (r.tool) out(`  Answer      tool call ${r.tool.name}, arguments ${r.tool.valid ? 'valid' : `INVALID: ${r.tool.error}`}`);
    else if (r.read?.answer) out(`  Answer      text: ${(r.text ?? '').slice(0, 120)}`);
    else if (r.read) out(`  Answer      none (${r.read.error})`);
    if (r.tokens) out(`  Tokens      input ${r.tokens.input} (cache read ${r.tokens.read}, cache write ${r.tokens.write}), output ${r.tokens.output}`);
    else if (r.read?.answer) out('  Tokens      not reported');
    out(`  Ceiling     ${usd(r.ceiling)}`);
    if (r.chain?.state === 'moved') out(`  Moved       ${usd(r.chain.amount)}, tx ${r.chain.tx ?? 'not found'}`);
    else if (r.chain?.state === 'unsettled') out('  Moved       $0.000000: the signature expired unused');
    else if (r.chain) out(`  Moved       unknown: ${r.chain.why}`);
    if (r.claimed !== undefined) out(`  BlockRun says it settled ${r.claimed === null ? 'nothing it reports' : usd(r.claimed)}`);
    if (r.listMicro != null) out(`  BlockRun list price for these tokens + $0.001: ${usd(Math.round(r.listMicro))}`);
    if (r.tokens && openrouter) out(`  OpenRouter for the same tokens: ${usd(Math.round(costMicro(r.tokens, openrouter)))}`);
    const quote = computeQuote(DEFAULT_PRICE_TABLE, plan.request as never);
    out(`  Relay quote for this request: ${quote.ok ? usd(quote.quote.quoteMicroUsdc) : `none (${quote.error.code})`}`);
  }

  function printVerdicts(all: CallResult[], plansRun: CallPlan[], walletDelta: bigint | null, movedTotal: bigint): number {
    const paid = all.filter((r) => r.chain?.state === 'moved');
    const realistic = all[1];
    const cached = all[2];
    const moved = (r: CallResult | undefined) => (r?.chain?.state === 'moved' ? r.chain.amount : null);
    const verdicts: { risk: string; result: 'PASS' | 'FAIL' | 'NOT REACHED' | 'NOT TESTED'; detail: string }[] = [];
    const add = (risk: string, result: 'PASS' | 'FAIL' | 'NOT REACHED' | 'NOT TESTED', detail: string) => verdicts.push({ risk, result, detail });

    const permitCall = all.find((r) => r.usedPermit);
    if (!all[0]?.chain && !all[0]?.read) add('BlockRun accepts our upto payment', 'FAIL', all[0]?.failure ?? 'no call was made');
    else if (paid.length === 0) add('BlockRun accepts our upto payment', 'FAIL', all[0]?.failure ?? 'nothing settled');
    else add('BlockRun accepts our upto payment', 'PASS', 'a signed upto payment settled on chain');
    if (!permitCall) add('A wallet with no ETH and no approval can pay (sponsored permit)', paid.length ? 'NOT TESTED' : 'FAIL', paid.length ? 'this wallet already had enough Permit2 allowance, so no permit was sent; rerun from a fresh wallet to test it' : 'no call settled');
    else add('A wallet with no ETH and no approval can pay (sponsored permit)', permitCall.chain?.state === 'moved' ? 'PASS' : 'FAIL', permitCall.chain?.state === 'moved' ? 'a call with a permit settled' : (permitCall.failure ?? 'the call with a permit did not settle'));

    if (paid.length === 0) add('upto settles the real cost, not the ceiling', 'FAIL', 'nothing settled');
    else {
      const overCeiling = paid.find((r) => moved(r)! >= r.ceiling);
      const overList = paid.find((r) => r.listMicro != null && Number(moved(r)!) > r.listMicro * REAL_COST_TOLERANCE);
      const unmeasured = paid.every((r) => r.listMicro == null);
      if (overCeiling) add('upto settles the real cost, not the ceiling', 'FAIL', `call ${overCeiling.name} moved its whole ceiling`);
      else if (overList) add('upto settles the real cost, not the ceiling', 'FAIL', `call ${overList.name} moved ${usd(moved(overList)!)}, over ${REAL_COST_TOLERANCE}x the list price of ${usd(Math.round(overList.listMicro!))}`);
      else if (unmeasured) add('upto settles the real cost, not the ceiling', 'NOT TESTED', 'moved less than the ceiling, but BlockRun reported no tokens or prices to compare with');
      else add('upto settles the real cost, not the ceiling', 'PASS', paid.map((r) => `${usd(moved(r)!)} of ${usd(r.ceiling)}`).join(', '));
    }

    if (paid.length === 0) add('BlockRun reports the settled amount in PAYMENT-RESPONSE', 'NOT REACHED', '');
    else {
      const wrong = paid.find((r) => r.claimed !== undefined && r.claimed !== null && r.claimed !== moved(r));
      const silent = paid.find((r) => r.claimed === null || r.claimed === undefined);
      if (wrong) add('BlockRun reports the settled amount in PAYMENT-RESPONSE', 'FAIL', `said ${usd(wrong.claimed!)}, the chain says ${usd(moved(wrong)!)}`);
      else if (silent) add('BlockRun reports the settled amount in PAYMENT-RESPONSE', 'FAIL', 'it does not; production reads the amount from the chain, so this only costs one RPC read per thought');
      else add('BlockRun reports the settled amount in PAYMENT-RESPONSE', 'PASS', 'it matches the chain');
    }

    if (!realistic) add('Claude accepts our tool request through BlockRun', 'NOT REACHED', '');
    else if (realistic.tool?.valid) add('Claude accepts our tool request through BlockRun', 'PASS', `called ${realistic.tool.name} with valid arguments`);
    else add('Claude accepts our tool request through BlockRun', 'FAIL', realistic.failure ?? 'no valid tool call');

    if (!cached) add('The prompt cache is read and billed at cache rates', 'NOT REACHED', '');
    else if (!cached.tokens || cached.tokens.read === 0) add('The prompt cache is read and billed at cache rates', 'FAIL', 'the repeated request reported no cache read');
    else if (moved(cached) === null) add('The prompt cache is read and billed at cache rates', 'FAIL', cached.failure ?? 'nothing settled');
    else if (moved(realistic) !== null && moved(cached)! >= moved(realistic)!) add('The prompt cache is read and billed at cache rates', 'FAIL', `the repeat moved ${usd(moved(cached)!)}, no less than the first ${usd(moved(realistic)!)}`);
    else if (cached.listMicro != null && Number(moved(cached)!) > cached.listMicro * REAL_COST_TOLERANCE) add('The prompt cache is read and billed at cache rates', 'FAIL', `moved ${usd(moved(cached)!)}, over ${REAL_COST_TOLERANCE}x the cache-rate price of ${usd(Math.round(cached.listMicro))}`);
    else add('The prompt cache is read and billed at cache rates', 'PASS', `${cached.tokens.read} tokens read from cache, ${usd(moved(cached)!)} against ${moved(realistic) === null ? 'unknown' : usd(moved(realistic)!)} for the first`);

    const answered = all.filter((r) => r.read?.answer);
    if (answered.length === 0) add('Latency is acceptable', 'NOT REACHED', '');
    else {
      const slowest = Math.max(...answered.map((r) => r.latencyMs ?? 0));
      add('Latency is acceptable', slowest <= SLOW_CALL_MS ? 'PASS' : 'FAIL', `slowest answer ${(slowest / 1000).toFixed(1)} s, limit ${SLOW_CALL_MS / 1000} s`);
      const fell = answered.find((r) => r.read?.fallback);
      add('The model asked for is the model that answers', fell ? 'FAIL' : 'PASS', fell ? `answered by ${String(fell.read?.servedModel)}` : `${answered.length} of ${answered.length} without a fallback`);
    }

    if (!realistic?.tokens) add('Local token count is close to what is billed', 'NOT REACHED', '');
    else {
      const local = countInputTokens(plansRun[1]!.request as never);
      const off = Math.abs(realistic.tokens.input - local) / local;
      add('Local token count is close to what is billed', off <= TOKEN_PROXY_TOLERANCE ? 'PASS' : 'FAIL', `billed ${realistic.tokens.input}, counted ${local} (o200k), ${(off * 100).toFixed(0)}% apart`);
    }

    if (walletDelta === null) add('One signature, one payment', 'NOT TESTED', 'the wallet balance could not be read at the end');
    else add('One signature, one payment', walletDelta === movedTotal ? 'PASS' : 'FAIL', `the wallet went down by ${usd(walletDelta)}; the settled calls add up to ${usd(movedTotal)}`);
    add("OpenRouter's reported 5.5% purchase fee", 'NOT TESTED', 'this command cannot see it; check the OpenRouter billing page');

    out('');
    out('Verdict for each risk');
    for (const v of verdicts) out(`  ${v.result.padEnd(11)} ${v.risk}${v.detail ? `: ${v.detail}` : ''}`);
    const failed = verdicts.filter((v) => v.result === 'FAIL' || v.result === 'NOT REACHED').length;
    out('');
    out(failed === 0 ? 'PASS' : `FAIL (${failed} of ${verdicts.length} risks failed or were not reached)`);
    return failed === 0 ? EXIT_OK : EXIT_FAILED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runLiveCheck({ env: process.env, argv: process.argv.slice(2), out: (line) => console.log(line) });
}
