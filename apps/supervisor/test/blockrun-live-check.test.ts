/**
 * The owner's live check against a local stub of BlockRun's HTTP server and a fake chain: every failure, no real
 * network, no real key (each run generates one). Signing is real. blockrun-live-check-fork.test.ts covers the money.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { countInputTokens } from '@bootr/inference';
import { getAddresses } from '@bootr/shared/addresses';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { costMicro, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, parseArgs, redact, runLiveCheck, thoughtRequest, tinyRequest, tokensOf, type LiveCheckDeps } from '../scripts/blockrun-live-check.js';
import { paymentAuthorization } from '../src/blockrun.js';
import { BLOCKRUN_DEFAULT_PAYTO } from '../src/config.js';
import { parseAssistant } from '../src/inference.js';

const USDC = getAddresses(8453).usdc;
const PAYTO = BLOCKRUN_DEFAULT_PAYTO as Address;
const txOf = (i: number): Hex => `0x${String(i + 1).repeat(64)}`;
const TINY_CEILING = 2000n;
const THOUGHT_CEILING = 99_484n;
const MODEL = 'anthropic/claude-sonnet-4.6';
const required = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/blockrun/payment-required.json', import.meta.url)), 'utf8')).requirements as PaymentRequired;
const capturedToolCall = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/blockrun/tool-call.json', import.meta.url)), 'utf8')).body as Record<string, unknown>;

const SONNET = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const finishCall = { id: 'call_f', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ memory: 'm', agenda: 'a', summary: 's', nextAt: '2026-11-06T18:00:00.000Z' }) } };
const thoughtUsage = (read: number, write: number) => ({ prompt_tokens: 16_800, completion_tokens: 300, total_tokens: 17_100, prompt_tokens_details: { cached_tokens: read, cached_creation_tokens: write } });
const answers = [
  { id: 'c1', model: MODEL, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 14, completion_tokens: 2, total_tokens: 16 } },
  { ...capturedToolCall, model: MODEL, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [finishCall] } }], usage: thoughtUsage(0, 14_000) },
  { ...capturedToolCall, model: MODEL, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [finishCall] } }], usage: thoughtUsage(14_000, 0) },
];
const priceOf = (i: number) => BigInt(Math.round(costMicro(tokensOf(answers[i]!.usage)!, SONNET))) + 1000n;

interface World {
  usdc: bigint;
  eth: bigint;
  allowance: bigint;
  chainId: number;
  spent: Set<string>;
  transfers: { value: bigint; tx: Hex }[];
  /** Reads of the payment's nonce fail while this is true. */
  blind: boolean;
}

function fakeChain(w: World, spender: Address): PublicClient {
  return {
    getChainId: async () => w.chainId,
    getBalance: async () => w.eth,
    getBlockNumber: async () => 100n,
    readContract: async (args: { functionName: string; args?: unknown[] }) => {
      if (args.functionName === 'balanceOf') return w.usdc;
      if (args.functionName === 'allowance') return w.allowance;
      if (args.functionName === 'nonces') return 0n;
      if (args.functionName === 'nonceBitmap') {
        if (w.blind) throw new Error('rpc down');
        const wordPos = (args.args as [Address, bigint])[1];
        let word = 0n;
        for (const n of w.spent) if (BigInt(n) >> 8n === wordPos) word |= 1n << (BigInt(n) & 0xffn);
        return word;
      }
      throw new Error(`unmocked ${args.functionName}`);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const found = w.transfers.filter((t) => t.tx === hash);
      if (!found.length) throw new Error('not found');
      const topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: spender, to: PAYTO } });
      return { logs: found.map((t) => ({ address: USDC, topics, data: encodeAbiParameters([{ type: 'uint256' }], [t.value]) })) };
    },
    getLogs: async () => w.transfers.map((t) => ({ args: { value: t.value }, transactionHash: t.tx })),
  } as unknown as PublicClient;
}

interface Sim {
  signatures: PaymentPayload[];
  unpaid: number;
  /** Overrides each row of the 402. */
  rowOver: (body: { max_tokens: number }, nth: number) => Record<string, unknown>;
  dropUpto: boolean;
  /** Runs once, the next time the check waits between chain reads: what lands on chain while it reads. */
  afterPoll: (() => void) | null;
  unpaidReply: ((res: ServerResponse) => void) | null;
  paid: (ctx: { i: number; payload: PaymentPayload; res: ServerResponse; req: IncomingMessage; settle: (amount?: bigint) => void; ok: (amount?: bigint, headers?: Record<string, string>) => void; json: (status: number, body: unknown, headers?: Record<string, string>) => void }) => void;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
});

async function scenario(setup: (sim: Sim, w: World) => void, opts: { argv?: string[]; env?: Record<string, string>; timeoutMs?: number; fundUsdc?: bigint } = {}) {
  const key = generatePrivateKey();
  const spender = privateKeyToAccount(key).address;
  const w: World = { usdc: opts.fundUsdc ?? 1_000_000n, eth: 0n, allowance: 0n, chainId: 8453, spent: new Set(), transfers: [], blind: false };
  const sim: Sim = {
    signatures: [],
    unpaid: 0,
    rowOver: () => ({}),
    dropUpto: false,
    afterPoll: null,
    unpaidReply: null,
    paid: ({ ok }) => ok(),
  };
  setup(sim, w);
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/v1/models') return send(200, { data: [{ id: MODEL, pricing: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } }] });
      if (req.url === '/or/models') return send(200, { data: [{ id: MODEL, pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' } }] });
      const signature = req.headers['payment-signature'] as string | undefined;
      if (!signature) {
        sim.unpaid += 1;
        if (sim.unpaidReply) return sim.unpaidReply(res);
        const body = JSON.parse(raw) as { max_tokens: number };
        const amount = (body.max_tokens === 32 ? TINY_CEILING : THOUGHT_CEILING).toString();
        const over = sim.rowOver(body, sim.unpaid);
        const accepts = required.accepts.filter((a) => !sim.dropUpto || a.scheme !== 'upto').map((a) => ({ ...a, amount, ...over }));
        return send(402, { x402Version: 2 }, { 'payment-required': encodePaymentRequiredHeader({ ...required, accepts }) });
      }
      const payload = decodePaymentSignatureHeader(signature);
      sim.signatures.push(payload);
      const i = sim.signatures.length - 1;
      const settle = (amount: bigint = priceOf(i)) => {
        w.spent.add((paymentAuthorization(payload)!.nonce as bigint).toString());
        w.usdc -= amount;
        w.transfers.push({ value: amount, tx: txOf(i) });
      };
      sim.paid({
        i,
        payload,
        res,
        req,
        settle,
        json: send,
        ok: (amount, headers) => {
          const value = amount ?? priceOf(i);
          settle(value);
          send(200, answers[i], { 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: txOf(i), network: 'eip155:8453', payer: spender, amount: value.toString() })).toString('base64'), 'x-payment-receipt': txOf(i), ...headers });
        },
      });
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const lines: string[] = [];
  let offset = 0;
  const env: Record<string, string | undefined> = { BLOCKRUN_TEST_PRIVATE_KEY: key, BLOCKRUN_TEST_BASE_URL: `http://127.0.0.1:${port}/api/v1`, BLOCKRUN_TEST_OPENROUTER_MODELS_URL: `http://127.0.0.1:${port}/or/models`, ...opts.env };
  const deps: LiveCheckDeps = {
    env,
    argv: opts.argv ?? ['--yes'],
    out: (line) => lines.push(line),
    publicClient: fakeChain(w, spender),
    now: () => Date.now() + offset,
    sleep: async (ms) => {
      offset += ms;
      const landing = sim.afterPoll;
      sim.afterPoll = null;
      landing?.();
    },
    timeoutMs: opts.timeoutMs ?? 5_000,
  };
  const code = await runLiveCheck(deps);
  const text = lines.join('\n');
  expect(text).not.toContain(key);
  expect(text).not.toContain(key.slice(2));
  return { code, text, lines, sim, w, env, key, spender };
}

const verdict = (text: string, risk: string) => text.split('\n').find((l) => l.includes(risk))?.trim() ?? '';

describe('before anything is signed', () => {
  it('without --yes it prints the whole plan and stops', async () => {
    const r = await scenario(() => {}, { argv: [] });
    expect(r.code).toBe(EXIT_OK);
    expect(r.sim.signatures).toEqual([]);
    for (const part of [r.spender, '1.000000 USDC', '0 ETH', MODEL, 'upto', PAYTO, USDC, 'ceiling $0.002000', 'ceiling $0.099484', 'Total ceiling $0.200968', '$0.150000 per call', '$0.400000 in total', 'at least 0.200968 USDC', 'ETH         none', 'no transaction', 'exactly that call', 'Permit2 allowance now: 0.000000 USDC', 'Not paying without --yes', 'Nothing was signed']) {
      expect(r.text).toContain(part);
    }
    // the key is taken out of the environment once read
    expect(r.env.BLOCKRUN_TEST_PRIVATE_KEY).toBeUndefined();
  });

  it('the realistic request is about 61 kB of the real prompt and tools, identical each time', () => {
    const a = thoughtRequest(MODEL);
    const size = Buffer.byteLength(JSON.stringify(a));
    expect(size).toBeGreaterThan(60_000);
    expect(size).toBeLessThan(62_000);
    expect(JSON.stringify(thoughtRequest(MODEL))).toBe(JSON.stringify(a));
    const names = (a.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['finish', 'publish_post', 'publish_reply', 'read_mentions', 'treasury_prepare']));
    expect((a.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
    expect(tinyRequest(MODEL).tools).toEqual([]);
  });

  it.each([
    ['no key', { BLOCKRUN_TEST_PRIVATE_KEY: '' }, /Set BLOCKRUN_TEST_PRIVATE_KEY/],
    ['a malformed key', { BLOCKRUN_TEST_PRIVATE_KEY: '0x1234' }, /must be a 0x-prefixed/],
    ['a service key', { BLOCKRUN_TEST_PRIVATE_KEY: `0x${'ab'.repeat(32)}`, SPENDER_MASTER_KEY: `0x${'AB'.repeat(32)}` }, /same as SPENDER_MASTER_KEY/],
  ])('refuses %s', async (_name, env, message) => {
    const r = await scenario(() => {}, { env });
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).toMatch(message);
    expect(r.sim.signatures).toEqual([]);
    expect(r.sim.unpaid).toBe(0);
  });

  it('refuses a key on the command line and does not repeat it', async () => {
    const leaked = `0x${'cd'.repeat(32)}`;
    const r = await scenario(() => {}, { argv: ['--yes', leaked] });
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).not.toContain(leaked);
    expect(r.text).toContain('BLOCKRUN_TEST_PRIVATE_KEY only');
    expect(r.sim.unpaid).toBe(0);
  });

  it('an unknown argument is refused', () => {
    expect(() => parseArgs(['--force'])).toThrow(/Unknown argument/);
    expect(parseArgs(['--max-per-call=0.05', '--max-total=0.1'])).toMatchObject({ maxPerCall: 50_000n, maxTotal: 100_000n });
  });

  it('redacts the key and a keyed RPC from any line', () => {
    expect(redact('failed https://rpc.test/secret with 0xabc and abc', ['0xabc', 'https://rpc.test/secret'])).toBe('failed [redacted] with [redacted] and [redacted]');
  });

  it.each([
    ['another recipient', { payTo: '0x9999999999999999999999999999999999999999' }, /another recipient/],
    ['another token', { asset: '0x9999999999999999999999999999999999999999' }, /another token/],
    ['another chain', { network: 'eip155:84532' }, /another chain/],
  ])('refuses a 402 naming %s', async (_name, over, message) => {
    const r = await scenario((s) => void (s.rowOver = () => over));
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).toMatch(message);
    expect(r.sim.signatures).toEqual([]);
  });

  it('refuses a model with no upto', async () => {
    const r = await scenario((s) => void (s.dropUpto = true));
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).toMatch(/does not offer upto/);
    expect(r.sim.signatures).toEqual([]);
  });

  it('refuses an RPC on another chain', async () => {
    const r = await scenario((_s, w) => void (w.chainId = 84532));
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).toMatch(/Base \(8453\) only/);
  });

  it('holds to the caps, by default and when lowered', async () => {
    const perCall = await scenario((s) => void (s.rowOver = (b) => (b.max_tokens === 32 ? {} : { amount: '150001' })));
    expect(perCall.code).toBe(EXIT_REFUSED);
    expect(perCall.text).toMatch(/above the \$0\.150000 cap per call/);
    const total = await scenario((s) => void (s.rowOver = (b) => (b.max_tokens === 32 ? {} : { amount: '150000' })), { argv: ['--yes', '--max-total=0.2'] });
    expect(total.code).toBe(EXIT_REFUSED);
    expect(total.text).toMatch(/above the \$0\.200000 total cap/);
    const defaultTotal = await scenario((s) => void (s.rowOver = (b) => (b.max_tokens === 32 ? { amount: '149000' } : { amount: '149000' })));
    expect(defaultTotal.code).toBe(EXIT_REFUSED);
    expect(defaultTotal.text).toMatch(/above the \$0\.400000 total cap/);
    for (const r of [perCall, total, defaultTotal]) expect(r.sim.signatures).toEqual([]);
  });

  it('refuses a wallet short of the total ceiling, naming the amount', async () => {
    const r = await scenario(() => {}, { fundUsdc: 200_000n });
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).toMatch(/holds 0\.200000 USDC and needs at least 0\.200968 USDC/);
    expect(r.sim.signatures).toEqual([]);
  });

  it('a model BlockRun does not know stops at the price', async () => {
    const r = await scenario((s) => {
      s.unpaidReply = (res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown model' }));
      };
    });
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).toMatch(/answered 400 to the unpaid request/);
  });

  it('a price raised after the plan is refused, not paid', async () => {
    let probes = 0;
    const r = await scenario((s) => {
      s.rowOver = () => {
        probes += 1;
        return probes > 2 ? { amount: '2001' } : {};
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toEqual([]);
    expect(r.text).toMatch(/no signature left this machine/);
  });

  it('a recipient swapped after the plan is refused, not paid', async () => {
    let probes = 0;
    const r = await scenario((s) => {
      s.rowOver = () => {
        probes += 1;
        return probes > 2 ? { payTo: '0x9999999999999999999999999999999999999999' } : {};
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toEqual([]);
  });
});

describe('a clean run', () => {
  it('pays three calls, one signature each, prints each measurement and passes every risk', async () => {
    const r = await scenario(() => {});
    expect(r.code).toBe(EXIT_OK);
    expect(r.sim.signatures).toHaveLength(3);
    expect(r.sim.signatures.every((p) => p.accepted.scheme === 'upto')).toBe(true);
    expect(r.w.transfers.map((t) => t.value)).toEqual([priceOf(0), priceOf(1), priceOf(2)]);
    expect(r.w.usdc).toBe(1_000_000n - priceOf(0) - priceOf(1) - priceOf(2));
    // the permit is for exactly that call's ceiling
    const permit = (r.sim.signatures[1]!.extensions as { eip2612GasSponsoring: { info: { amount: string; spender: string } } }).eip2612GasSponsoring.info;
    expect(permit.amount).toBe(THOUGHT_CEILING.toString());
    expect(permit.spender).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
    for (const part of ['HTTP        200', `Served by   ${MODEL}, fallback: no`, 'Answer      text: ok', 'Answer      tool call finish, arguments valid', 'cache read 14000', 'Ceiling     $0.099484', `Moved       $0.066400, tx ${txOf(1)}`, 'BlockRun list price for these tokens + $0.001: $0.066400', 'OpenRouter for the same tokens: $0.065400', 'Relay quote for this request: $0.1']) {
      expect(r.text).toContain(part);
    }
    expect(r.text).not.toContain('FAIL');
    expect(r.lines.at(-1)).toBe('PASS');
    for (const risk of ['BlockRun accepts our upto payment', 'sponsored permit', 'upto settles the real cost', 'PAYMENT-RESPONSE', 'Claude accepts our tool request', 'prompt cache is read', 'Latency', 'The model asked for', 'Local token count', 'One signature, one payment']) {
      expect(verdict(r.text, risk), risk).toMatch(/^PASS/);
    }
    expect(verdict(r.text, '5.5%')).toMatch(/^NOT TESTED/);
    // the token check really compared
    expect(countInputTokens(thoughtRequest(MODEL) as never)).toBeGreaterThan(14_000);
  });

  it('parses the same tool call the supervisor would', () => {
    expect(parseAssistant(answers[1] as never).toolCall?.name).toBe('finish');
  });
});

describe('failures stop the run and never pay twice', () => {
  it('first call refused by BlockRun after signing, nothing settled: reads the chain until the signature is dead', async () => {
    const r = await scenario((s) => void (s.paid = ({ json }) => json(402, { error: 'Payment verification failed', code: 'PAYMENT_INVALID' })));
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('direct_http_402_PAYMENT_INVALID');
    expect(r.text).toContain('The signature expired unused: nothing was charged');
    expect(r.text).toContain('Moved       $0.000000');
    expect(verdict(r.text, 'BlockRun accepts our upto payment')).toMatch(/^FAIL/);
    expect(verdict(r.text, 'Claude accepts our tool request')).toMatch(/^NOT REACHED/);
    expect(r.lines.at(-1)).toMatch(/^FAIL/);
  });

  it('response lost after settling: finds the money on chain by logs, one payment, no retry', async () => {
    const r = await scenario((s) => {
      s.paid = ({ settle, req }) => {
        settle();
        req.socket.destroy();
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.w.transfers).toHaveLength(1);
    expect(r.text).toContain('Reading the chain instead of retrying');
    expect(r.text).toContain(`Moved       $0.001072, tx ${txOf(0)}`);
    expect(r.text).toContain('lost $0.001072');
    expect(verdict(r.text, 'One signature, one payment')).toMatch(/^PASS/);
  });

  it('timeout, then a late settlement: still one payment, read from the chain', async () => {
    const r = await scenario(
      (s) => {
        // no answer at all; it settles while the check is reading the chain
        s.paid = ({ settle }) => void (s.afterPoll = () => settle(1500n));
      },
      { timeoutMs: 200 },
    );
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.w.transfers).toHaveLength(1);
    expect(r.text).toMatch(/No response/);
    expect(r.text).toContain(`Moved       $0.001500, tx ${txOf(0)}`);
    expect(r.text).toContain('lost $0.001500');
  });

  it('timeout and nothing ever settles: nothing charged', async () => {
    const r = await scenario((s) => void (s.paid = () => {}), { timeoutMs: 200 });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('nothing was charged');
  });

  it('settlement delayed: the answer arrives, the transfer lands later, and the real amount is what gets printed', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, json, settle }) => {
        json(200, answers[i], { 'x-payment-settled': 'false' });
        s.afterPoll = () => settle();
      };
    });
    expect(r.sim.signatures).toHaveLength(3);
    expect(r.text).toContain('Settlement not confirmed in the response');
    expect(r.text).toContain(`Moved       $0.066400, tx ${txOf(1)}`);
    expect(r.text).toContain('BlockRun says it settled nothing it reports');
    expect(verdict(r.text, 'PAYMENT-RESPONSE')).toMatch(/^FAIL/);
    expect(verdict(r.text, 'upto settles the real cost')).toMatch(/^PASS/);
    expect(r.code).toBe(EXIT_FAILED);
  });

  it('answered and never settled: says so, stops', async () => {
    const r = await scenario((s) => void (s.paid = ({ i, json }) => json(200, answers[i], { 'x-payment-settled': 'false' })));
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('never settled');
  });

  it('Claude rejects our tools through BlockRun and the rejection settles: stops at call 2, money counted, no call 3', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, ok, json, settle }) => {
        if (i === 0) return ok();
        settle(5000n);
        json(400, { error: { message: 'tools: Extra inputs are not permitted', code: 'INVALID_PARAMETER' } });
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(2);
    expect(r.text).toContain('direct_http_400_INVALID_PARAMETER');
    expect(r.text).toContain('lost $0.005000');
    expect(verdict(r.text, 'Claude accepts our tool request')).toMatch(/^FAIL/);
    expect(verdict(r.text, 'prompt cache is read')).toMatch(/^NOT REACHED/);
  });

  it('text instead of a tool call on the realistic call stops the run', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, ok, json, settle }) => {
        if (i === 0) return ok();
        settle(60_000n);
        json(200, { ...answers[0], usage: thoughtUsage(0, 0) }, { 'x-payment-receipt': txOf(i) });
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(2);
    expect(r.text).toContain('text instead of a tool call');
  });

  it('a tool call the catalog rejects is reported', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, ok, json, settle }) => {
        if (i === 0) return ok();
        settle(60_000n);
        json(200, { ...answers[1], choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'finish', arguments: '{"nope":1}' } }] } }] }, { 'x-payment-receipt': txOf(i) });
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.text).toContain('arguments INVALID');
  });

  it('a fallback model stops the run and fails that risk', async () => {
    const r = await scenario((s) => void (s.paid = ({ ok }) => ok(undefined, { 'x-fallback-used': 'true', 'x-fallback-model': 'anthropic/claude-sonnet-4.5' })));
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('Served by   anthropic/claude-sonnet-4.5, fallback: YES');
    expect(verdict(r.text, 'The model asked for')).toMatch(/^FAIL/);
  });

  it('a free model standing in is not an answer', async () => {
    const r = await scenario((s) => void (s.paid = ({ i, json }) => json(200, answers[i], { 'x-free-model': 'true' })));
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.text).toContain('direct_free_model_substituted');
  });

  it('settling the whole ceiling is caught as not the real cost', async () => {
    const r = await scenario((s) => void (s.paid = ({ i, ok }) => ok(i === 0 ? TINY_CEILING : THOUGHT_CEILING)));
    expect(r.code).toBe(EXIT_FAILED);
    expect(verdict(r.text, 'upto settles the real cost')).toMatch(/^FAIL/);
  });

  it('no cache read on the repeat fails only that risk', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, ok, json, settle }) => {
        if (i < 2) return ok();
        settle(priceOf(1));
        json(200, answers[1], { 'x-payment-receipt': txOf(i) });
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(3);
    expect(verdict(r.text, 'prompt cache is read')).toMatch(/^FAIL/);
    expect(verdict(r.text, 'Claude accepts our tool request')).toMatch(/^PASS/);
  });

  it('a chain that cannot be read: says it does not know, tells the owner to check, does not retry', async () => {
    const r = await scenario((s, w) => {
      s.paid = ({ req }) => {
        w.blind = true;
        req.socket.destroy();
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('the chain could not be read');
    expect(r.text).toContain('basescan.org');
  });

  it('settling above the signed amount is called out', async () => {
    const r = await scenario((s) => void (s.paid = ({ ok }) => ok(TINY_CEILING + 1n)));
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.text).toContain('above the signed');
  });
});

describe('arithmetic', () => {
  it('reads both forms of cached usage', () => {
    expect(tokensOf({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60, cached_creation_tokens: 10 } })).toEqual({ input: 100, uncached: 30, read: 60, write: 10, output: 5 });
    expect(tokensOf({ prompt_tokens: 30, completion_tokens: 5, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 })).toEqual({ input: 100, uncached: 30, read: 60, write: 10, output: 5 });
    expect(tokensOf({})).toBeNull();
  });
});
