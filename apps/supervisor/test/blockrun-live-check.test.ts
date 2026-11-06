/**
 * The owner's live check against a local stub of BlockRun's HTTP server and a fake chain: every failure, no real
 * network, no real key (each run generates one). Signing is real. blockrun-live-check-fork.test.ts covers the money.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAddresses } from '@bootr/shared/addresses';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { costMicro, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, parseArgs, redact, referencePng, runLiveCheck, thoughtRequest, tokensOf, type LiveCheckDeps } from '../scripts/blockrun-live-check.js';
import { paymentAuthorization } from '../src/blockrun.js';
import { BLOCKRUN_DEFAULT_PAYTO } from '../src/config.js';
import { parseImageResponse } from '../src/images.js';

const USDC = getAddresses(8453).usdc;
const PAYTO = BLOCKRUN_DEFAULT_PAYTO as Address;
const txOf = (i: number): Hex => `0x${String(i + 1).repeat(64)}`;
const required = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/blockrun/payment-required.json', import.meta.url)), 'utf8')).requirements as PaymentRequired;

/** Ceilings by BlockRun model, as quoted live on 2026-11-06; upto where BlockRun offers it. */
const QUOTES: Record<string, { ceiling: bigint; upto: boolean; rates?: { input: number; output: number; cacheRead: number; cacheWrite: number } }> = {
  'anthropic/claude-haiku-4.5': { ceiling: 14_411n, upto: true, rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  'openai/gpt-4.1-mini': { ceiling: 13_724n, upto: false, rates: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 } },
  'openai/gpt-image-1': { ceiling: 22_000n, upto: false },
  'anthropic/claude-sonnet-4.6': { ceiling: 99_484n, upto: true, rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
};
const CHEAP_TOTAL = 14_411n + 13_724n + 22_000n;
const PNG_URI = referencePng();

const finishCall = { id: 'call_f', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ memory: 'm', agenda: 'a', summary: 's', nextAt: '2026-11-06T18:00:00.000Z' }) } };
const toolAnswer = (model: string, usage: Record<string, unknown>, finish_reason = 'tool_calls', call: unknown = finishCall) => ({ id: 'c', model, choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: '', tool_calls: [call] } }], usage });
const smallUsage = { prompt_tokens: 4200, completion_tokens: 60, total_tokens: 4260 };
const thoughtUsage = (read: number, write: number) => ({ prompt_tokens: 16_800, completion_tokens: 300, total_tokens: 17_100, prompt_tokens_details: { cached_tokens: read, cached_creation_tokens: write } });
/** Default answers, one per planned call. */
const answers: Record<number, Record<string, unknown>> = {
  0: toolAnswer('anthropic/claude-haiku-4.5', smallUsage),
  1: toolAnswer('openai/gpt-4.1-mini', thoughtUsage(0, 0)),
  3: toolAnswer('anthropic/claude-sonnet-4.6', thoughtUsage(0, 14_000)),
  4: toolAnswer('anthropic/claude-sonnet-4.6', thoughtUsage(14_000, 0)),
};
const imageBody = (url = PNG_URI, tx?: string) => ({ id: 'job', created: 1, data: [{ url }], price: { amount: '0.022', currency: 'USD' }, payment: { status: 'settled', tx_hash: tx, network: 'eip155:8453' } });

interface World {
  usdc: bigint;
  eth: bigint;
  allowance: bigint;
  chainId: number;
  spent: Set<string>;
  transfers: { value: bigint; tx: Hex }[];
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
      if (w.blind) throw new Error('rpc down');
      if (args.functionName === 'authorizationState') return w.spent.has(String((args.args as [Address, Hex])[1]).toLowerCase());
      if (args.functionName === 'nonceBitmap') {
        const wordPos = (args.args as [Address, bigint])[1];
        let word = 0n;
        for (const n of w.spent) if (/^\d+$/.test(n) && BigInt(n) >> 8n === wordPos) word |= 1n << (BigInt(n) & 0xffn);
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

interface PaidCtx {
  i: number;
  payload: PaymentPayload;
  res: ServerResponse;
  req: IncomingMessage;
  settle: (amount?: bigint) => void;
  /** The default success for this call: settles and answers. */
  ok: (amount?: bigint, headers?: Record<string, string>) => void;
  json: (status: number, body: unknown, headers?: Record<string, string>) => void;
}

interface Sim {
  signatures: PaymentPayload[];
  unpaid: number;
  rowOver: (model: string, nth: number) => Record<string, unknown>;
  noSchemes: boolean;
  afterPoll: (() => void) | null;
  unpaidReply: ((res: ServerResponse) => void) | null;
  poll: ((res: ServerResponse) => void) | null;
  paid: (ctx: PaidCtx) => void;
}

const defaultAmount = (i: number, model: string): bigint => {
  const q = QUOTES[model]!;
  if (!q.rates) return q.ceiling;
  if (!q.upto) return q.ceiling;
  return BigInt(Math.round(costMicro(tokensOf(answers[i]!.usage)!, q.rates))) + 1000n;
};

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
});

async function scenario(setup: (sim: Sim, w: World) => void, opts: { argv?: string[]; env?: Record<string, string>; timeoutMs?: number; fundUsdc?: bigint } = {}) {
  const key = generatePrivateKey();
  const spender = privateKeyToAccount(key).address;
  const w: World = { usdc: opts.fundUsdc ?? 1_000_000n, eth: 0n, allowance: 0n, chainId: 8453, spent: new Set(), transfers: [], blind: false };
  const sim: Sim = { signatures: [], unpaid: 0, rowOver: () => ({}), noSchemes: false, afterPoll: null, unpaidReply: null, poll: null, paid: ({ ok }) => ok() };
  setup(sim, w);
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/v1/models') return send(200, { data: Object.entries(QUOTES).filter(([, q]) => q.rates).map(([id, q]) => ({ id, pricing: { input: q.rates!.input, output: q.rates!.output, cache_read: q.rates!.cacheRead, cache_write: q.rates!.cacheWrite } })) });
      if (req.url === '/or/models') return send(200, { data: Object.entries(QUOTES).filter(([, q]) => q.rates).map(([id, q]) => ({ id, pricing: { prompt: String(q.rates!.input / 1e6), completion: String(q.rates!.output / 1e6), input_cache_read: String(q.rates!.cacheRead / 1e6), input_cache_write: String(q.rates!.cacheWrite / 1e6) } })) });
      if (req.method === 'GET') return sim.poll!(res);
      const body = JSON.parse(raw) as { model: string };
      const signature = req.headers['payment-signature'] as string | undefined;
      const quote = QUOTES[body.model]!;
      if (!signature) {
        sim.unpaid += 1;
        if (sim.unpaidReply) return sim.unpaidReply(res);
        const over = sim.rowOver(body.model, sim.unpaid);
        const accepts = required.accepts.filter((a) => (a.scheme === 'upto' ? quote.upto : true)).filter(() => !sim.noSchemes).map((a) => ({ ...a, amount: quote.ceiling.toString(), ...over }));
        return send(402, { x402Version: 2 }, { 'payment-required': encodePaymentRequiredHeader({ ...required, accepts }) });
      }
      const payload = decodePaymentSignatureHeader(signature);
      sim.signatures.push(payload);
      const i = sim.signatures.length - 1;
      const settle = (amount: bigint = defaultAmount(i, body.model)) => {
        const nonce = paymentAuthorization(payload)!.nonce;
        w.spent.add(typeof nonce === 'bigint' ? nonce.toString() : nonce.toLowerCase());
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
          const value = amount ?? defaultAmount(i, body.model);
          settle(value);
          const answer = body.model === 'openai/gpt-image-1' ? imageBody(PNG_URI, txOf(i)) : answers[i];
          send(200, answer, { 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: txOf(i), network: 'eip155:8453', payer: spender, amount: value.toString() })).toString('base64'), 'x-payment-receipt': txOf(i), ...headers });
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

const verdict = (text: string, goal: string) => text.split('\n').find((l) => l.includes(goal))?.trim() ?? '';

describe('before anything is signed', () => {
  it('without --yes it prints the whole plan, the worst case and what the wallet needs, and stops', async () => {
    const r = await scenario(() => {}, { argv: [] });
    expect(r.code).toBe(EXIT_OK);
    expect(r.sim.signatures).toEqual([]);
    for (const part of [r.spender, '1.000000 USDC', '0 ETH', 'anthropic/claude-haiku-4.5, upto', 'openai/gpt-4.1-mini, exact', 'openai/gpt-image-1, exact', PAYTO, USDC, 'ceiling $0.014411', 'ceiling $0.013724', 'ceiling $0.022000', 'Total ceiling $0.050135', 'worst case', '$0.150000 per call', '$0.400000 in total', 'at least 0.050135 USDC', 'ETH         none', 'no transaction', 'exactly', 'Permit2 allowance now: 0.000000 USDC', 'relay would charge', 'Not paying without --yes', 'Nothing was signed']) {
      expect(r.text, part).toContain(part);
    }
    // the key is taken out of the environment once read
    expect(r.env.BLOCKRUN_TEST_PRIVATE_KEY).toBeUndefined();
  });

  it('--full adds the real Sonnet thought and its repeat', async () => {
    const r = await scenario(() => {}, { argv: ['--full'] });
    expect(r.text).toContain('a real thought on Sonnet: anthropic/claude-sonnet-4.6, upto');
    expect(r.text).toContain('Total ceiling $0.249103');
  });

  it('the realistic request is about 61 kB of the real prompt and tools, identical each time', () => {
    const a = thoughtRequest('anthropic/claude-sonnet-4.6');
    const size = Buffer.byteLength(JSON.stringify(a));
    expect(size).toBeGreaterThan(60_000);
    expect(size).toBeLessThan(62_000);
    expect(JSON.stringify(thoughtRequest('anthropic/claude-sonnet-4.6'))).toBe(JSON.stringify(a));
    const names = (a.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['finish', 'publish_post', 'publish_reply', 'read_mentions', 'treasury_prepare']));
    expect((a.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('the reference picture is a real PNG that the image path reads', () => {
    const parsed = parseImageResponse({ choices: [{ message: { images: [{ image_url: { url: referencePng() } }] } }] });
    expect(parsed).toMatchObject({ ok: true, mime: 'image/png' });
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

  it('parses flags and refuses unknown ones', () => {
    expect(() => parseArgs(['--force'])).toThrow(/Unknown argument/);
    expect(parseArgs(['--max-per-call=0.05', '--max-total=0.1', '--full', '--no-prompt-cache'])).toMatchObject({ maxPerCall: 50_000n, maxTotal: 100_000n, full: true, promptCache: false });
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

  it('refuses a 402 with no scheme it can pay', async () => {
    const r = await scenario((s) => void (s.noSchemes = true));
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).toMatch(/neither upto nor exact/);
  });

  it('refuses an RPC on another chain', async () => {
    const r = await scenario((_s, w) => void (w.chainId = 84532));
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).toMatch(/Base \(8453\) only/);
  });

  it('holds to the caps, by default and when lowered', async () => {
    const perCall = await scenario((s) => void (s.rowOver = () => ({ amount: '150001' })));
    expect(perCall.code).toBe(EXIT_REFUSED);
    expect(perCall.text).toMatch(/above the \$0\.150000 cap per call/);
    const lowered = await scenario(() => {}, { argv: ['--yes', '--max-total=0.01'] });
    expect(lowered.code).toBe(EXIT_REFUSED);
    expect(lowered.text).toMatch(/above the \$0\.010000 total cap/);
    const total = await scenario((s) => void (s.rowOver = () => ({ amount: '149000' })));
    expect(total.code).toBe(EXIT_REFUSED);
    expect(total.text).toMatch(/above the \$0\.400000 total cap/);
    for (const r of [perCall, lowered, total]) expect(r.sim.signatures).toEqual([]);
  });

  it('refuses a wallet short of the total ceiling, naming the amount', async () => {
    const r = await scenario(() => {}, { fundUsdc: CHEAP_TOTAL - 1n });
    expect(r.code).toBe(EXIT_REFUSED);
    expect(r.text).toMatch(/needs at least 0\.050135 USDC/);
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

  it.each([
    ['a price raised', { amount: '14412' }],
    ['a recipient swapped', { payTo: '0x9999999999999999999999999999999999999999' }],
    ['a token swapped', { asset: '0x9999999999999999999999999999999999999999' }],
  ])('%s after the plan is refused, not paid', async (_name, over) => {
    let probes = 0;
    const r = await scenario((s) => {
      s.rowOver = () => {
        probes += 1;
        return probes > 3 ? over : {};
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toEqual([]);
    expect(r.text).toMatch(/no signature left this machine/);
  });
});

describe('a clean run', () => {
  it('pays each call once from its own wallet, at no more than the relay, and passes the goal', async () => {
    const r = await scenario(() => {});
    expect(r.code).toBe(EXIT_OK);
    expect(r.sim.signatures.map((p) => p.accepted.scheme)).toEqual(['upto', 'exact', 'exact']);
    expect(r.w.transfers).toHaveLength(3);
    // the permit is for exactly that call's ceiling
    const permit = (r.sim.signatures[0]!.extensions as { eip2612GasSponsoring: { info: { amount: string; spender: string } } }).eip2612GasSponsoring.info;
    expect(permit.amount).toBe('14411');
    expect(permit.spender).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
    for (const part of ['HTTP        200', 'Served by   anthropic/claude-haiku-4.5, fallback: no', 'Answer      tool call finish, arguments valid', 'Ceiling     $0.014411 (upto)', 'Ceiling     $0.013724 (exact)', 'Picture     readable: image/png', `tx ${txOf(2)}`, 'Relay charge for this request: $0.015', 'OpenRouter for the same tokens', 'BlockRun list price for these tokens + $0.001']) {
      expect(r.text, part).toContain(part);
    }
    expect(r.lines.at(-1)).toBe('PASS');
    for (const goal of ['pays from its own wallet', 'costs no more than the relay', 'Tool calls work on Claude', 'Tool calls work on other models', 'Pictures work', 'The model asked for']) {
      expect(verdict(r.text, goal), goal).toMatch(/^PASS/);
    }
    expect(r.text).toContain('upto settled');
  });

  it('--full also measures the real thought and the prompt cache, without judging them', async () => {
    const r = await scenario(() => {}, { argv: ['--yes', '--full'] });
    expect(r.code).toBe(EXIT_OK);
    expect(r.sim.signatures).toHaveLength(5);
    expect(r.text).toContain('Prompt cache on the repeat: 14000 tokens read');
    expect(r.text).toContain('A real thought: billed 16800 input tokens');
  });

  it('upto settling its whole ceiling passes the goal when that is still under the relay, and says so', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, ok, payload }) => ok(i === 0 ? BigInt(payload.accepted.amount) : undefined);
    });
    expect(r.code).toBe(EXIT_OK);
    expect(r.text).toContain('upto settled $0.014411 of $0.014411');
  });
});

describe('failing the goal', () => {
  it('moving more than the relay charges fails that goal', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, ok }) => ok(i === 1 ? 13_000n : undefined);
    });
    expect(verdict(r.text, 'costs no more than the relay')).toMatch(/^PASS/);
    const dearer = await scenario((s) => {
      s.rowOver = (model) => (model === 'openai/gpt-4.1-mini' ? { amount: '20000' } : {});
      s.paid = ({ i, ok }) => ok(i === 1 ? 20_000n : undefined);
    });
    expect(dearer.code).toBe(EXIT_FAILED);
    expect(verdict(dearer.text, 'costs no more than the relay')).toMatch(/^FAIL/);
  });

  it('a fallback model stops the run and fails that goal', async () => {
    const r = await scenario((s) => void (s.paid = ({ ok }) => ok(undefined, { 'x-fallback-used': 'true', 'x-fallback-model': 'anthropic/claude-sonnet-4.5' })));
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('Served by   anthropic/claude-sonnet-4.5, fallback: YES');
    expect(verdict(r.text, 'The model asked for')).toMatch(/^FAIL/);
  });

  it('a tool call cut off at the output limit is not "the tools were rejected": it is named and the run goes on', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, ok, json, settle }) => {
        if (i !== 0) return ok();
        settle(14_411n);
        json(200, toolAnswer('anthropic/claude-haiku-4.5', { prompt_tokens: 4200, completion_tokens: 1024 }, 'length', { id: 'x', type: 'function', function: { name: 'finish', arguments: '{"memory":"a very long note that ne' } }), { 'x-payment-receipt': txOf(i) });
      };
    });
    expect(r.sim.signatures).toHaveLength(3);
    expect(r.text).toContain('CUT OFF at the output limit');
    expect(verdict(r.text, 'Tool calls work on Claude')).toMatch(/^PASS.*cut off/);
    expect(r.code).toBe(EXIT_OK);
  });

  it('arguments the tool rejects that were not cut off are a real failure', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, json, settle }) => {
        settle(10_000n);
        json(200, toolAnswer('anthropic/claude-haiku-4.5', smallUsage, 'tool_calls', { id: 'x', type: 'function', function: { name: 'finish', arguments: '{"nope":1}' } }), { 'x-payment-receipt': txOf(i) });
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('arguments INVALID');
    expect(verdict(r.text, 'Tool calls work on Claude')).toMatch(/^FAIL/);
  });

  it('text instead of a tool call stops the run', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, json, settle }) => {
        settle(10_000n);
        json(200, { id: 'c', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: smallUsage }, { 'x-payment-receipt': txOf(i) });
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.text).toContain('text instead of a tool call');
  });

  it('a rejection of our request that settles: stops, the money counted, no next call', async () => {
    const r = await scenario((s) => {
      s.paid = ({ settle, json }) => {
        settle(5000n);
        json(400, { error: { message: 'tools: Extra inputs are not permitted', code: 'INVALID_PARAMETER' } });
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('direct_http_400_INVALID_PARAMETER');
    expect(r.text).toContain('lost $0.005000');
    expect(verdict(r.text, 'Pictures work')).toMatch(/^NOT REACHED/);
  });
});

describe('pictures', () => {
  it('a slow picture is polled, and paid once, on the first poll that sees it done', async () => {
    let polls = 0;
    let settled = false;
    const r = await scenario((s, w) => {
      s.paid = ({ i, ok, json, payload }) => {
        if (i !== 2) return ok();
        json(202, { id: 'job', status: 'queued', poll_url: '/api/v1/images/generations/job', payment_status: 'verified' });
        s.poll = (res) => {
          polls += 1;
          const done = polls >= 2;
          res.writeHead(done ? 200 : 202, { 'content-type': 'application/json' });
          res.end(JSON.stringify(done ? imageBody(PNG_URI, txOf(2)) : { id: 'job', status: 'in_progress' }));
          if (done && !settled) {
            settled = true;
            w.spent.add((paymentAuthorization(payload)!.nonce as Hex).toLowerCase());
            w.usdc -= 22_000n;
            w.transfers.push({ value: 22_000n, tx: txOf(2) });
          }
        };
      };
    });
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(r.sim.signatures).toHaveLength(3);
    expect(r.w.transfers).toHaveLength(3);
    expect(r.text).toContain('A slow picture');
    expect(verdict(r.text, 'Pictures work')).toMatch(/^PASS/);
    expect(r.code).toBe(EXIT_OK);
  });

  it('a picture BlockRun could not make is not charged', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, ok, json }) => {
        if (i !== 2) return ok();
        json(202, { id: 'job', status: 'queued', poll_url: '/api/v1/images/generations/job' });
        s.poll = (res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'job', status: 'failed', payment_status: 'not_charged' }));
        };
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.text).toContain('nothing was charged');
    expect(verdict(r.text, 'Pictures work')).toMatch(/^FAIL/);
    expect(r.w.transfers).toHaveLength(2);
  });

  it('a slow picture pointing the poll at another origin is not polled with the payment', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, ok, json }) => {
        if (i !== 2) return ok();
        json(202, { id: 'job', status: 'queued', poll_url: 'https://elsewhere.test/poll' });
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.text).toContain('no poll address');
  });
});

describe('failures stop the run and never pay twice', () => {
  it('refused after signing, nothing settled: reads the chain until the signature is dead', async () => {
    const r = await scenario((s) => void (s.paid = ({ json }) => json(402, { error: 'Payment verification failed', code: 'PAYMENT_INVALID' })));
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('direct_http_402_PAYMENT_INVALID');
    expect(r.text).toContain('The signature expired unused: nothing was charged');
    expect(r.text).toContain('Moved       $0.000000');
    expect(verdict(r.text, 'pays from its own wallet')).toMatch(/^FAIL/);
    expect(verdict(r.text, 'Pictures work')).toMatch(/^NOT REACHED/);
    expect(r.lines.at(-1)).toMatch(/^FAIL/);
  });

  it('response lost after settling: finds the money on chain by logs, one payment, no retry', async () => {
    const r = await scenario((s) => {
      s.paid = ({ settle, req }) => {
        settle(14_000n);
        req.socket.destroy();
      };
    });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.w.transfers).toHaveLength(1);
    expect(r.text).toContain('Reading the chain instead of retrying');
    expect(r.text).toContain(`Moved       $0.014000, tx ${txOf(0)}`);
    expect(r.text).toContain('lost $0.014000');
    expect(verdict(r.text, 'pays from its own wallet')).toMatch(/^PASS.*one per signature/);
  });

  it('timeout, then a late settlement: still one payment, read from the chain', async () => {
    const r = await scenario((s) => void (s.paid = ({ settle }) => void (s.afterPoll = () => settle(1500n))), { timeoutMs: 200 });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.w.transfers).toHaveLength(1);
    expect(r.text).toMatch(/No response/);
    expect(r.text).toContain(`Moved       $0.001500, tx ${txOf(0)}`);
  });

  it('timeout and nothing ever settles: nothing charged', async () => {
    const r = await scenario((s) => void (s.paid = () => {}), { timeoutMs: 200 });
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('nothing was charged');
  });

  it('settlement delayed: the answer arrives, the transfer lands later, and the real amount is printed', async () => {
    const r = await scenario((s) => {
      s.paid = ({ i, json, settle, ok }) => {
        if (i !== 0) return ok();
        json(200, answers[0], { 'x-payment-settled': 'false' });
        s.afterPoll = () => settle(9_000n);
      };
    });
    expect(r.sim.signatures).toHaveLength(3);
    expect(r.text).toContain('Settlement not confirmed in the response');
    expect(r.text).toContain(`Moved       $0.009000, tx ${txOf(0)}`);
    expect(r.text).toContain('BlockRun says it settled nothing it reports');
    expect(r.code).toBe(EXIT_OK);
  });

  it('answered and never settled: says so, stops', async () => {
    const r = await scenario((s) => void (s.paid = ({ i, json }) => json(200, answers[i], { 'x-payment-settled': 'false' })));
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.sim.signatures).toHaveLength(1);
    expect(r.text).toContain('never settled');
  });

  it('a free model standing in is not an answer', async () => {
    const r = await scenario((s) => void (s.paid = ({ i, json }) => json(200, answers[i], { 'x-free-model': 'true' })));
    expect(r.code).toBe(EXIT_FAILED);
    expect(r.text).toContain('direct_free_model_substituted');
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
    const r = await scenario((s) => void (s.paid = ({ ok }) => ok(14_412n)));
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
