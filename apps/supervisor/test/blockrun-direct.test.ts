/**
 * Direct mode against BlockRun's real shapes: the 402 header and the response bodies in fixtures/blockrun were captured
 * from its live endpoints on 2026-11-06 (free models; nothing was paid). The payer signs for real with a test key and
 * the simulator below verifies each signature the way USDC and Permit2 would, so only settlement is fake. The relay is
 * the real app (apps/inference, in-process), so a second payment for one thought would show up in its mock facilitator.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, verifyTypedData, type Address, type Hex, type Log } from 'viem';
import { buildInferenceRequest, maxQuoteFor, TOOL_LIST, type ChatMessage } from '@bootr/agent-core';
import { DIRECT_HOLD, DIRECT_IMAGE_MODELS, DIRECT_PAID_LOST, DIRECT_SUBSTITUTES, DIRECT_UNPAID, directBody, directEnabled, directModel, INSUFFICIENT_FLOAT, paymentAuthorization } from '../src/blockrun.js';
import { CHAT_MAX_OUTPUT_TOKENS, CHAT_MAX_QUOTE_MICRO_USDC, sendChatMessage } from '../src/chat.js';
import { agents as agentsTable, inference as inferenceTable, notifications as notificationsTable, runtimes } from '../src/db/schema.js';
import { createApp } from '../src/api.js';
import { BLOCKRUN_IMAGE_CATALOG, picturePriceFor, relayImageCatalog, relayImageModels } from '../src/image-models.js';
import { generateImage, PICTURE_HOLD_MS, pictureHold, PICTURES_UNAVAILABLE, PICTURES_UNAVAILABLE_MESSAGE, WITHOUT_PICTURE } from '../src/images.js';
import { pictureSection } from '../src/picture-hint.js';
import { fuelReport, parseAssistant, reconcileRelay, recentThoughtCost, relayRequest, runInference, type RelayCall } from '../src/inference.js';
import { fuelView } from '../src/fuel.js';
import { providerHold } from '../src/provider-hold.js';
import { tick } from '../src/tick.js';
import type { AgentState } from '../src/runtime.js';
import { createTestApp, jsonResponse, PAY_TO } from '../../inference/src/test/helpers.js';
import { ADDR, AGENT_ID, agentConfig, makeWorld, seedAgent, SPENDER, type TestWorld } from './helpers.js';

const BLOCKRUN = 'https://blockrun.test/api/v1';
const BLOCKRUN_PAYTO: Address = '0xe9030014F5DAe217d0A152f02A043567b16c1aBf';
const MODEL = 'anthropic/claude-sonnet-4.6';
const TX: Hex = `0x${'cd'.repeat(32)}`;
const CEILING = 102_904n; // what BlockRun quoted a 61 kB request on Sonnet 4.6 on 2026-11-06
const ACTUAL = 55_800n;
const MINUTE = 60_000;

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/blockrun/${name}.json`, import.meta.url)), 'utf8')) as { status: number; headers: Record<string, string>; body: Record<string, unknown>; requirements: Record<string, unknown> };

const permit2WitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;
const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;
const authorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

async function verifyPaid(payload: PaymentPayload): Promise<void> {
  const chainId = 84532;
  if (payload.accepted.scheme === 'upto') {
    const { signature, permit2Authorization: a } = payload.payload as { signature: Hex; permit2Authorization: { from: Address; spender: Address; nonce: string; deadline: string; permitted: { token: Address; amount: string }; witness: { to: Address; facilitator: Address; validAfter: string } } };
    const ok = await verifyTypedData({
      address: a.from,
      domain: { name: 'Permit2', chainId, verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3' },
      types: permit2WitnessTypes,
      primaryType: 'PermitWitnessTransferFrom',
      message: { permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, spender: a.spender, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline), witness: { to: a.witness.to, facilitator: a.witness.facilitator, validAfter: BigInt(a.witness.validAfter) } },
      signature,
    });
    expect(ok, 'Permit2 signature').toBe(true);
    expect(getAddress(a.witness.to)).toBe(BLOCKRUN_PAYTO);
    expect(BigInt(a.permitted.amount)).toBe(BigInt(payload.accepted.amount));
    const permit = (payload.extensions as { eip2612GasSponsoring?: { info?: { from: Address; spender: Address; amount: string; nonce: string; deadline: string; signature: Hex } } } | undefined)?.eip2612GasSponsoring?.info;
    expect(permit, 'a spender with no ETH needs the sponsored allowance').toBeTruthy();
    const permitOk = await verifyTypedData({ address: permit!.from, domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: getAddress(payload.accepted.asset) }, types: permitTypes, primaryType: 'Permit', message: { owner: permit!.from, spender: permit!.spender, value: BigInt(permit!.amount), nonce: BigInt(permit!.nonce), deadline: BigInt(permit!.deadline) }, signature: permit!.signature });
    expect(permitOk, 'EIP-2612 permit').toBe(true);
    return;
  }
  const { signature, authorization: a } = payload.payload as { signature: Hex; authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex } };
  const ok = await verifyTypedData({ address: a.from, domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: getAddress(payload.accepted.asset) }, types: authorizationTypes, primaryType: 'TransferWithAuthorization', message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce }, signature });
  expect(ok, 'EIP-3009 signature').toBe(true);
}

/** Decodes the header a payer really sends, so a change in its shape fails here. */
function nonceKey(payload: PaymentPayload): string {
  const auth = paymentAuthorization(payload)!;
  return typeof auth.nonce === 'bigint' ? auth.nonce.toString() : auth.nonce.toLowerCase();
}

interface Sim {
  quote: bigint;
  offerUpto: boolean;
  payTo: Address;
  /** Answer to the unpaid request when not the 402 quote. */
  probe: (() => Response) | null;
  /** Answer to a poll of a slow picture. */
  poll: ((req: Request) => Response) | null;
  /** Anything outside BlockRun and the relay: picture downloads. */
  outside: ((req: Request) => Response) | null;
  /** Answer to a paid request. Default: the captured tool call, settled for `ACTUAL`. */
  paid: (p: PaymentPayload, settle: () => void) => Response | Promise<Response>;
  signatures: PaymentPayload[];
  probes: string[];
  bodies: Record<string, unknown>[];
  urls: string[];
  headersSeen: Headers[];
}

const toolCallBody = () => fixture('tool-call').body;
/** The same answer as OpenRouter words it: `content: null` on a tool call. */
const openRouterToolCall = () => {
  const body = toolCallBody() as { choices: { message: Record<string, unknown> }[] };
  return { ...body, choices: body.choices.map((c) => ({ ...c, message: { ...c.message, content: null } })) };
};

function paidAnswer(body: Record<string, unknown>, over: { amount?: string | null; headers?: Record<string, string> } = {}): Response {
  const receipt = Buffer.from(JSON.stringify({ success: true, transaction: TX, network: 'eip155:84532', payer: SPENDER, ...(over.amount !== null ? { amount: over.amount ?? ACTUAL.toString() } : {}) })).toString('base64');
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-blockrun-gateway-request-id': 'gw-1', 'payment-response': receipt, 'x-payment-receipt': TX, ...over.headers } });
}

/** A world with direct mode on, the real relay behind `INFERENCE_PROVIDER_URL` and the BlockRun simulator. */
async function direct(config: Record<string, string> = {}) {
  const w = await makeWorld({ chain: { spentNonces: new Set() }, config: { INFERENCE_PAYTO_ADDRESS: PAY_TO, BLOCKRUN_DIRECT_MODE: 'all', BLOCKRUN_BASE_URL: BLOCKRUN, BLOCKRUN_RELAY_FALLBACK: 'true', BLOCKRUN_ALLOW_EXACT: 'false', ...config } });
  // The x402 library stamps signature deadlines from the real clock, so this world runs on it too.
  w.setNow(Date.now());
  w.state.blockTimestamp = BigInt(Math.floor(Date.now() / 1000));
  const relay = createTestApp({ upstreamFetch: async () => jsonResponse(openRouterToolCall()) });
  const relayPayments: (string | null)[] = [];
  const sim: Sim = {
    quote: CEILING,
    offerUpto: true,
    payTo: BLOCKRUN_PAYTO,
    probe: null,
    poll: null,
    outside: null,
    paid: (_p, settle) => {
      settle();
      return paidAnswer(toolCallBody());
    },
    signatures: [],
    probes: [],
    bodies: [],
    urls: [],
    headersSeen: [],
  };
  const required = fixture('payment-required').requirements as { accepts: Record<string, unknown>[] };
  w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.startsWith('https://') && !req.url.startsWith('https://blockrun.test') && sim.outside) return sim.outside(req);
    if (req.method === 'GET' && req.url.startsWith('https://blockrun.test')) return sim.poll!(req);
    if (!req.url.startsWith(BLOCKRUN)) {
      if (req.method === 'POST' && req.headers.get('PAYMENT-SIGNATURE')) relayPayments.push(req.headers.get('Idempotency-Key'));
      return relay.appFetch(req);
    }
    sim.headersSeen.push(req.headers);
    sim.urls.push(req.url);
    sim.bodies.push(JSON.parse(await req.clone().text()) as Record<string, unknown>);
    const signature = req.headers.get('PAYMENT-SIGNATURE');
    if (!signature) {
      sim.probes.push(`${(JSON.parse(await req.text()) as { model: string }).model}`);
      if (sim.probe) return sim.probe();
      const accepts = required.accepts
        .filter((a) => sim.offerUpto || a.scheme !== 'upto')
        .map((a) => ({ ...a, network: 'eip155:84532', asset: ADDR.usdc, amount: sim.quote.toString(), payTo: sim.payTo }));
      const header = Buffer.from(JSON.stringify({ ...required, accepts })).toString('base64');
      return new Response(JSON.stringify({ x402Version: 2, accepts, error: 'Payment Required' }), { status: 402, headers: { 'content-type': 'application/json', 'payment-required': header } });
    }
    const payload = decodePaymentSignatureHeader(signature);
    await verifyPaid(payload);
    sim.signatures.push(payload);
    return sim.paid(payload, () => w.state.spentNonces!.add(nonceKey(payload)));
  }) as typeof fetch;
  return { w, sim, relay, relayPayments };
}

const finishThought = (nextAtMs: number) => ({
  id: 'c',
  object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_f', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(nextAtMs).toISOString() }) } }] } }],
  usage: { prompt_tokens: 16000, completion_tokens: 300, total_tokens: 16300 },
});

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are a test agent.' },
  { role: 'user', content: 'Nothing happened today.' },
];
const thought = (key = 'inference:k1', maxQuote = 1_500_000n): RelayCall => ({
  key,
  cycle: 0,
  request: buildInferenceRequest(messages, TOOL_LIST.slice(0, 2) as never, { model: MODEL, maxOutputTokens: 1024 }) as unknown as Record<string, unknown>,
  maxQuoteMicroUsdc: maxQuote,
});
const rowOf = async (w: TestWorld, key = 'inference:k1') => (await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, key) }))!;

describe('switch', () => {
  it('is off by default, named agents only with `agents`, everyone with `all`', () => {
    expect(directEnabled({ BLOCKRUN_DIRECT_MODE: 'off', BLOCKRUN_DIRECT_AGENTS: '7' }, '7')).toBe(false);
    expect(directEnabled({ BLOCKRUN_DIRECT_MODE: 'agents', BLOCKRUN_DIRECT_AGENTS: '1153600, 7' }, '7')).toBe(true);
    expect(directEnabled({ BLOCKRUN_DIRECT_MODE: 'agents', BLOCKRUN_DIRECT_AGENTS: '1153600' }, '7')).toBe(false);
    expect(directEnabled({ BLOCKRUN_DIRECT_MODE: 'all', BLOCKRUN_DIRECT_AGENTS: '' }, '7')).toBe(true);
  });

  it('with no setting the thought pays the relay and BlockRun hears nothing', async () => {
    const { w, sim, relayPayments } = await direct({ BLOCKRUN_DIRECT_MODE: '' });
    try {
      const agent = await seedAgent(w);
      const res = await relayRequest(w.ctx, agent, thought());
      expect(res.kind).toBe('ok');
      expect(sim.probes).toEqual([]);
      expect(relayPayments).toEqual(['inference:k1']);
      expect((await rowOf(w)).receipt).not.toHaveProperty('route');
    } finally {
      await w.close();
    }
  });
});

describe('the body BlockRun gets', () => {
  it('drops what it does not take, maps the vendor prefixes and asks for caching on Claude only', () => {
    const on = { BLOCKRUN_PROMPT_CACHE: true };
    expect(directBody(on, thought().request)).toMatchObject({ model: MODEL, prompt_cache: true, tool_choice: 'auto', max_tokens: 1024, stream: false });
    expect(directBody(on, thought().request)).not.toHaveProperty('store');
    expect(directBody(on, thought().request)).not.toHaveProperty('parallel_tool_calls');
    const openai = directBody(on, { ...thought().request, model: 'openai/gpt-5.4-mini' });
    expect(openai).toMatchObject({ parallel_tool_calls: false });
    expect(openai).not.toHaveProperty('prompt_cache');
    expect(directBody({ BLOCKRUN_PROMPT_CACHE: false }, thought().request)).not.toHaveProperty('prompt_cache');
    const noTools = directBody(on, { model: MODEL, messages, tools: [], tool_choice: 'none', max_tokens: 10 });
    expect(noTools).not.toHaveProperty('tools');
    expect(noTools).not.toHaveProperty('tool_choice');
    expect(directModel('x-ai/grok-4.7')).toBe('xai/grok-4.7');
    // GLM 4.6 is gone from BlockRun: the catalog sends its agents to GLM 5.3
    expect(directModel('z-ai/glm-4.6')).toBe('zai/glm-5.3');
    expect(directModel('vendor/unlisted-model')).toBe('vendor/unlisted-model');
    expect(directModel('google/gemini-3.1-pro-preview')).toBe('google/gemini-3.1-pro');
  });
});

describe('same model behaviour on real response shapes', () => {
  it.each(['tool-call', 'tool-call-fallback', 'tool-call-reasoning', 'tool-result-turn'])('%s parses like an OpenRouter tool call', async (name) => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w);
      sim.paid = (_p, settle) => {
        settle();
        return paidAnswer(fixture(name).body);
      };
      const res = await relayRequest(w.ctx, agent, thought());
      expect(res.kind).toBe('ok');
      if (res.kind !== 'ok') return;
      const parsed = parseAssistant(res.body);
      expect(parsed.toolCall?.name).toBe('finish');
      expect(parsed.toolCall?.input).toEqual({ agenda: 'a', memory: 'm', summary: 's' });
      // BlockRun sends `content: ""` on a tool call where OpenRouter sends null; the agent sees the same message.
      expect(parsed.message).toEqual({ role: 'assistant', content: null, tool_calls: [expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'finish' }) })] });
      expect(Object.keys(parsed.message).sort()).toEqual(['content', 'role', 'tool_calls']);
    } finally {
      await w.close();
    }
  });

  it('a text answer stays a text answer', async () => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w);
      sim.paid = (_p, settle) => {
        settle();
        return paidAnswer(fixture('text-only').body);
      };
      const res = await relayRequest(w.ctx, agent, thought());
      if (res.kind !== 'ok') throw new Error(res.kind);
      expect(parseAssistant(res.body)).toEqual({ message: { role: 'assistant', content: 'ok' }, toolCall: null, truncated: false, finishReason: 'stop' });
    } finally {
      await w.close();
    }
  });
});

describe('a paid thought', () => {
  it('signs upto once, records what was settled, and fuel reads it like a relay call', async () => {
    const { w, sim, relayPayments } = await direct();
    try {
      const agent = await seedAgent(w);
      const res = await relayRequest(w.ctx, agent, thought());
      expect(res.kind).toBe('ok');
      expect(sim.signatures).toHaveLength(1);
      expect(sim.signatures[0]!.accepted.scheme).toBe('upto');
      expect(relayPayments).toEqual([]);
      // our headers stay home
      expect(sim.headersSeen.every((h) => !h.has('Idempotency-Key') && !h.has('X-Max-Quote-Micro-USDC'))).toBe(true);
      const row = await rowOf(w);
      expect(row.status).toBe('succeeded');
      expect(row.request.model).toBe(MODEL);
      expect(row.receipt).toMatchObject({ route: 'blockrun', relay: { quoteMicroUsdc: CEILING.toString(), chargedMicroUsdc: ACTUAL.toString(), paymentTxOrId: TX, usage: expect.objectContaining({ prompt_tokens: 139 }) }, direct: { scheme: 'upto', fallback: false, settled: true } });

      const report = await fuelReport(w.ctx, AGENT_ID, new Date(w.ctx.now() - 86_400_000));
      expect(report.byModel).toEqual([{ model: MODEL, thoughts: 1, chargedMicroUsdc: ACTUAL.toString(), directThoughts: 1 }]);
      expect(await recentThoughtCost(w.ctx, AGENT_ID)).toEqual({ thoughts: 1, spentMicroUsdc: Number(ACTUAL) });
      // the turn's fuel section averages real charges, not the signed ceilings
      for (let i = 2; i <= 10; i++) await relayRequest(w.ctx, agent, thought(`inference:k${i}`));
      const recent = await recentThoughtCost(w.ctx, AGENT_ID);
      expect(recent).toEqual({ thoughts: 10, spentMicroUsdc: 10 * Number(ACTUAL) });
      expect(fuelView({ spenderUsdc: 10, usdc: 5 }, recent)).toMatchObject({ avgThoughtUsdc: '0.0558', thoughtsLeft: 179 });
    } finally {
      await w.close();
    }
  });

  it('believes the chain over the header when the settlement transaction can be read', async () => {
    const { w } = await direct();
    try {
      const agent = await seedAgent(w);
      const topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: SPENDER, to: BLOCKRUN_PAYTO } }) as [Hex, ...Hex[]];
      w.state.receipts[TX] = [{ address: ADDR.usdc, topics, data: encodeAbiParameters([{ type: 'uint256' }], [40_000n]) } as unknown as Log];
      await relayRequest(w.ctx, agent, thought());
      expect((await rowOf(w)).receipt).toMatchObject({ relay: { chargedMicroUsdc: '40000' } });
    } finally {
      await w.close();
    }
  });

  it('counts the signed amount when neither the chain nor the header says what settled', async () => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w);
      sim.paid = (_p, settle) => {
        settle();
        return paidAnswer(toolCallBody(), { amount: null });
      };
      await relayRequest(w.ctx, agent, thought());
      expect((await rowOf(w)).receipt).toMatchObject({ relay: { chargedMicroUsdc: CEILING.toString() } });
    } finally {
      await w.close();
    }
  });

  it('never pays twice for a key it already answered', async () => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w);
      await relayRequest(w.ctx, agent, thought());
      const again = await relayRequest(w.ctx, agent, thought());
      expect(again).toMatchObject({ kind: 'ok', replayed: true });
      expect(sim.signatures).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('a served call that has not settled yet is delivered and stays counted at the signed amount', async () => {
    const { w, sim } = await direct();
    const warn = vi.fn();
    try {
      w.ctx.log.warn = warn as never;
      const agent = await seedAgent(w);
      sim.paid = () => paidAnswer(toolCallBody(), { amount: null, headers: { 'x-payment-settled': 'false' } });
      const res = await relayRequest(w.ctx, agent, thought());
      expect(res.kind).toBe('ok');
      expect((await rowOf(w)).receipt).toMatchObject({ relay: { chargedMicroUsdc: CEILING.toString() }, direct: { settled: false } });
      expect(warn).toHaveBeenCalled();
    } finally {
      await w.close();
    }
  });

  it('a paid fallback model is delivered, counted and logged', async () => {
    const { w, sim } = await direct();
    const warn = vi.fn();
    try {
      w.ctx.log.warn = warn as never;
      const agent = await seedAgent(w);
      sim.paid = (_p, settle) => {
        settle();
        return paidAnswer(fixture('tool-call-fallback').body, { headers: { 'x-fallback-used': 'true', 'x-fallback-model': 'anthropic/claude-sonnet-4.5', 'x-original-model': MODEL } });
      };
      expect((await relayRequest(w.ctx, agent, thought())).kind).toBe('ok');
      expect((await rowOf(w)).receipt).toMatchObject({ direct: { fallback: true, servedModel: 'anthropic/claude-sonnet-4.5' } });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ requested: MODEL }), expect.stringContaining('fallback'));
      expect((await fuelReport(w.ctx, AGENT_ID, new Date(0))).byModel[0]).toMatchObject({ fallbackModels: 1 });
    } finally {
      await w.close();
    }
  });
});

describe('before any signature: this key goes to the relay, paid once', () => {
  const once = async (setup: (sim: Sim) => void, config: Record<string, string> = {}) => {
    const { w, sim, relayPayments, relay } = await direct(config);
    try {
      const agent = await seedAgent(w);
      setup(sim);
      const res = await relayRequest(w.ctx, agent, thought());
      expect(res.kind).toBe('ok');
      expect(sim.signatures).toEqual([]);
      expect(relayPayments).toEqual(['inference:k1']);
      expect(relay.facilitator.settle).toHaveBeenCalledTimes(1);
      const row = await rowOf(w);
      expect(row.status).toBe('succeeded');
      expect(row.receipt).not.toHaveProperty('route');
    } finally {
      await w.close();
    }
  };

  it('model not offered (the real 400)', () => once((s) => void (s.probe = () => jsonResponse(fixture('error-unknown-model').body, 400))));
  it('a quote above maxQuoteFor', () => once((s) => void (s.quote = 2_000_000n)));
  it('upto not offered and exact not allowed', () => once((s) => void (s.offerUpto = false)));
  it('another recipient in the 402', () => once((s) => void (s.payTo = '0x9999999999999999999999999999999999999999')));
  it('BlockRun unreachable', () => once((s) => void (s.probe = () => { throw new TypeError('fetch failed'); })));
  it('BlockRun down before the quote', () => once((s) => void (s.probe = () => jsonResponse({ code: 'MODEL_UNAVAILABLE' }, 503))));
  it('a 200 without asking for money is thrown away', () => once((s) => void (s.probe = () => new Response(JSON.stringify(fixture('tool-call').body), { status: 200, headers: { 'x-free-model': 'true' } }))));
});

describe('exact, only when allowed', () => {
  it('pays exact where upto is not offered and records the whole quote', async () => {
    const { w, sim } = await direct({ BLOCKRUN_ALLOW_EXACT: 'true' });
    try {
      const agent = await seedAgent(w);
      sim.offerUpto = false;
      expect((await relayRequest(w.ctx, agent, thought())).kind).toBe('ok');
      expect(sim.signatures[0]!.accepted.scheme).toBe('exact');
      expect((await rowOf(w)).receipt).toMatchObject({ relay: { chargedMicroUsdc: CEILING.toString() }, direct: { scheme: 'exact' } });
    } finally {
      await w.close();
    }
  });

  it('prefers upto when both are offered', async () => {
    const { w, sim } = await direct({ BLOCKRUN_ALLOW_EXACT: 'true' });
    try {
      const agent = await seedAgent(w);
      await relayRequest(w.ctx, agent, thought());
      expect(sim.signatures[0]!.accepted.scheme).toBe('upto');
    } finally {
      await w.close();
    }
  });

  it('a lost exact payment is read from USDC, not Permit2', async () => {
    const { w, sim, relayPayments } = await direct({ BLOCKRUN_ALLOW_EXACT: 'true' });
    try {
      const agent = await seedAgent(w);
      sim.offerUpto = false;
      sim.paid = (_p, settle) => {
        settle();
        throw new TypeError('connection reset');
      };
      expect((await relayRequest(w.ctx, agent, thought())).kind).toBe('unknown');
      expect(await reconcileRelay(w.ctx, 'inference:k1')).toMatchObject({ kind: 'failed', error: DIRECT_PAID_LOST });
      expect(relayPayments).toEqual([]);
      expect(w.state.calls.some((c) => c.fn === 'authorizationState')).toBe(true);
      expect(w.state.calls.some((c) => c.fn === 'nonceBitmap')).toBe(false);
    } finally {
      await w.close();
    }
  });
});

describe('insufficient float', () => {
  it('stops before signing, tells the runtime, and never tries the relay with the same empty wallet', async () => {
    const { w, sim, relayPayments } = await direct();
    try {
      w.state.spenderUsdc = CEILING - 1n;
      const agent = await seedAgent(w);
      expect(await relayRequest(w.ctx, agent, thought())).toEqual({ kind: 'failed', key: 'inference:k1', error: INSUFFICIENT_FLOAT });
      expect(sim.signatures).toEqual([]);
      expect(relayPayments).toEqual([]);
      const row = await rowOf(w);
      expect(row.status).toBe('failed');
      expect(row.receipt).toBeNull();
      expect((await fuelReport(w.ctx, AGENT_ID, new Date(0))).byModel).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('a float BlockRun itself refuses (the real 402) costs nothing and closes when the signature expires', async () => {
    const { w, sim, relayPayments } = await direct();
    try {
      const agent = await seedAgent(w);
      sim.paid = () => jsonResponse({ ...fixture('error-payment-invalid').body, code: 'PAYMENT_UNFUNDED' }, 402);
      expect(await relayRequest(w.ctx, agent, thought())).toMatchObject({ kind: 'unknown', error: 'direct_http_402_PAYMENT_UNFUNDED' });
      w.setNow(w.ctx.now() + 6 * MINUTE);
      expect(await reconcileRelay(w.ctx, 'inference:k1')).toMatchObject({ kind: 'failed', error: DIRECT_UNPAID });
      expect(relayPayments).toEqual([]);
    } finally {
      await w.close();
    }
  });
});

describe('after a signature: the chain decides, the relay waits', () => {
  it('provider failed and nothing settled: no second payment until the signature is dead, and nothing charged', async () => {
    const { w, sim, relayPayments } = await direct();
    try {
      const agent = await seedAgent(w);
      sim.paid = () => jsonResponse({ code: 'MODEL_UNAVAILABLE', message: 'overloaded' }, 503);
      const res = await relayRequest(w.ctx, agent, thought());
      expect(res).toMatchObject({ kind: 'unknown', error: 'direct_http_503_MODEL_UNAVAILABLE' });

      // inside the 300 s window the same key is only reconciled
      w.setNow(w.ctx.now() + MINUTE);
      expect((await relayRequest(w.ctx, agent, thought())).kind).toBe('unknown');
      expect(sim.signatures).toHaveLength(1);
      expect(relayPayments).toEqual([]);

      w.setNow(w.ctx.now() + 5 * MINUTE);
      expect(await reconcileRelay(w.ctx, 'inference:k1')).toEqual({ kind: 'failed', key: 'inference:k1', error: DIRECT_UNPAID });
      expect(relayPayments).toEqual([]);
      const report = await fuelReport(w.ctx, AGENT_ID, new Date(0));
      expect(report.byModel).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('payment settled and provider failed: one thought lost, counted as a paid failure, logged, no replacement bought', async () => {
    const { w, sim, relayPayments } = await direct();
    const error = vi.fn();
    try {
      w.ctx.log.error = error as never;
      const agent = await seedAgent(w);
      sim.paid = (_p, settle) => {
        settle();
        return jsonResponse({ code: 'TIMEOUT' }, 504);
      };
      expect((await relayRequest(w.ctx, agent, thought())).kind).toBe('unknown');
      expect(await reconcileRelay(w.ctx, 'inference:k1')).toEqual({ kind: 'failed', key: 'inference:k1', error: DIRECT_PAID_LOST });
      expect(relayPayments).toEqual([]);
      expect(sim.signatures).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ key: 'inference:k1', atMostMicroUsdc: CEILING.toString() }), expect.stringContaining('no refund path'));
      const report = await fuelReport(w.ctx, AGENT_ID, new Date(0));
      expect(report.byModel).toEqual([{ model: MODEL, thoughts: 1, chargedMicroUsdc: CEILING.toString(), paidFailures: 1, directThoughts: 1 }]);
      expect(await recentThoughtCost(w.ctx, AGENT_ID)).toEqual({ thoughts: 1, spentMicroUsdc: Number(CEILING) });
    } finally {
      await w.close();
    }
  });

  it('provider slow: our timeout leaves the outcome open and a late settlement is still seen', async () => {
    const { w, sim, relayPayments } = await direct();
    try {
      const agent = await seedAgent(w);
      let late = () => {};
      sim.paid = (_p, settle) => {
        late = settle;
        const e = new Error('The operation was aborted due to timeout');
        e.name = 'TimeoutError';
        throw e;
      };
      expect(await relayRequest(w.ctx, agent, thought())).toMatchObject({ kind: 'unknown', error: expect.stringContaining('TimeoutError') });
      w.setNow(w.ctx.now() + 2 * MINUTE);
      expect((await reconcileRelay(w.ctx, 'inference:k1')).kind).toBe('unknown');
      late();
      expect(await reconcileRelay(w.ctx, 'inference:k1')).toMatchObject({ kind: 'failed', error: DIRECT_PAID_LOST });
      expect(relayPayments).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('a 200 with no choices is no answer', async () => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w);
      sim.paid = () => jsonResponse({ id: 'x', choices: [] });
      expect((await relayRequest(w.ctx, agent, thought())).kind).toBe('unknown');
    } finally {
      await w.close();
    }
  });

  it('a free model standing in for the paid one is never delivered', async () => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w);
      sim.paid = () => new Response(JSON.stringify(fixture('tool-call').body), { status: 200, headers: { 'x-free-model': 'true', ...fixture('tool-call').headers } });
      expect(await relayRequest(w.ctx, agent, thought())).toMatchObject({ kind: 'unknown', error: 'direct_free_model_substituted' });
      w.setNow(w.ctx.now() + 6 * MINUTE);
      expect(await reconcileRelay(w.ctx, 'inference:k1')).toMatchObject({ kind: 'failed', error: DIRECT_UNPAID });
    } finally {
      await w.close();
    }
  });

  it('an unreadable chain keeps the row open, even past the deadline', async () => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w);
      sim.paid = () => jsonResponse({ code: 'TIMEOUT' }, 504);
      await relayRequest(w.ctx, agent, thought());
      w.setNow(w.ctx.now() + 6 * MINUTE);
      const read = w.ctx.chain.publicClient.readContract;
      w.ctx.chain.publicClient.readContract = (async () => {
        throw new Error('rpc down');
      }) as never;
      expect((await reconcileRelay(w.ctx, 'inference:k1')).kind).toBe('unknown');
      w.ctx.chain.publicClient.readContract = read;
      expect((await reconcileRelay(w.ctx, 'inference:k1')).kind).toBe('failed');
    } finally {
      await w.close();
    }
  });
});

describe('ambiguous outcome after a crash', () => {
  /** The process dies with the paid request out: the row holds what `onPayment` persisted before sending. */
  const crash = async (settledBeforeDying: boolean) => {
    const { w, sim, relayPayments } = await direct();
    const agent = await seedAgent(w);
    sim.paid = (_p, settle) => {
      if (settledBeforeDying) settle();
      throw new Error('process died');
    };
    await relayRequest(w.ctx, agent, thought());
    // the crash happened before anything after the send was recorded
    await w.db.update(inferenceTable).set({ status: 'pending', error: null }).where(eq(inferenceTable.idempotencyKey, 'inference:k1'));
    return { w, agent, sim, relayPayments };
  };

  it('settled before the crash: lost, once, no replacement', async () => {
    const { w, agent, sim, relayPayments } = await crash(true);
    try {
      // this young it may be another process still waiting for the answer: nothing is decided yet
      expect(await relayRequest(w.ctx, agent, thought())).toMatchObject({ kind: 'unknown', error: 'direct_in_flight' });
      w.setNow(w.ctx.now() + 3 * MINUTE);
      expect(await relayRequest(w.ctx, agent, thought())).toMatchObject({ kind: 'failed', error: DIRECT_PAID_LOST });
      expect(sim.signatures).toHaveLength(1);
      expect(relayPayments).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('not settled: open until the signature is dead, then free', async () => {
    const { w, agent, sim, relayPayments } = await crash(false);
    try {
      expect((await relayRequest(w.ctx, agent, thought())).kind).toBe('unknown');
      w.setNow(w.ctx.now() + 6 * MINUTE);
      expect(await relayRequest(w.ctx, agent, thought())).toMatchObject({ kind: 'failed', error: DIRECT_UNPAID });
      expect(sim.signatures).toHaveLength(1);
      expect(relayPayments).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('crashed before signing: nothing was signed, so nothing is at stake', async () => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w);
      await w.db.insert(inferenceTable).values({ idempotencyKey: 'inference:k1', agentId: agent.agentId, cycle: 0, requestHash: 'h', request: thought().request, status: 'pending', createdAt: new Date(w.ctx.now()), updatedAt: new Date(w.ctx.now()) });
      expect(await relayRequest(w.ctx, agent, thought())).toMatchObject({ kind: 'failed', error: 'no_payment_signed' });
      expect(sim.signatures).toEqual([]);
    } finally {
      await w.close();
    }
  });
});

describe('an outage through the runtime', () => {
  const runtimeRow = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
  const minutes = async (w: TestWorld, n: number) => {
    for (let i = 0; i < n; i++) {
      w.setNow(w.ctx.now() + MINUTE);
      await tick(w.ctx);
    }
  };

  it('holds the thought until the chain clears it, then the relay carries the agent; two hours cost one signature per hold and no money', async () => {
    const { w, sim, relayPayments, relay } = await direct({ BLOCKRUN_HOLD_MS: String(30 * MINUTE) });
    try {
      // The shortest cadence: a coin agent's own wake is never before its next slot (runtime.ts coinWakeFloor), and this
      // test counts attempts across two hours of wakes.
      await seedAgent(w, { config: { model: MODEL, postIntervalMs: 30 * MINUTE } });
      sim.paid = () => jsonResponse({ code: 'MODEL_UNAVAILABLE' }, 503);
      relay.upstreamFetch.mockImplementation(async () => jsonResponse(finishThought(w.ctx.now() + 5 * MINUTE)));

      await tick(w.ctx);
      expect(sim.signatures).toHaveLength(1);
      expect((w.state.spentNonces ?? new Set()).size).toBe(0);
      let rt = await runtimeRow(w);
      const key = (rt.state as unknown as AgentState).inferenceKey!;
      expect(key).toMatch(/^inference:/);
      expect(relayPayments).toEqual([]);

      // the signature can settle for 300 s: the agent waits and does not pay anyone
      await minutes(w, 4);
      expect(sim.signatures).toHaveLength(1);
      expect(relayPayments).toEqual([]);

      await minutes(w, 2);
      expect((await rowOf(w, key)).error).toBe(DIRECT_UNPAID);
      rt = await runtimeRow(w);
      expect((rt.state as unknown as AgentState).inferenceRetryAt).toBeGreaterThan(w.ctx.now() - MINUTE);

      await minutes(w, 114);
      // one attempt per hold, at most: the 2026-11-04 outage cost 110 paid failures
      expect(sim.signatures.length).toBeGreaterThanOrEqual(2);
      expect(sim.signatures.length).toBeLessThanOrEqual(4);
      expect(w.state.spentNonces!.size).toBe(0);
      expect(relayPayments.length).toBeGreaterThan(0);
      expect(new Set(relayPayments).size).toBe(relayPayments.length);
      const signedKeys = (await w.db.select().from(inferenceTable)).filter((r) => (r.receipt as { route?: string } | null)?.route === 'blockrun').map((r) => r.idempotencyKey);
      expect(signedKeys.filter((k) => relayPayments.includes(k))).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('runInference returns the same tool call on both routes', async () => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w, { config: { model: MODEL } });
      const request = thought().request as never;
      const viaDirect = await runInference(w.ctx, agent, {} as never, 1, request);
      sim.probe = () => jsonResponse(fixture('error-unknown-model').body, 400);
      const viaRelay = await runInference(w.ctx, agent, {} as never, 2, request);
      if (viaDirect.kind !== 'ok' || viaRelay.kind !== 'ok') throw new Error('expected answers');
      expect(viaDirect.message).toEqual(viaRelay.message);
      expect(viaDirect.toolCall).toEqual(viaRelay.toolCall);
    } finally {
      await w.close();
    }
  });
});

describe('the other paid paths', () => {
  it('a private chat message goes direct, keeps its charge, and stays out of the thought average', async () => {
    const { w, sim, relayPayments } = await direct();
    try {
      w.state.usdc = 50_000_000n;
      const agent = await seedAgent(w, { config: { model: MODEL } });
      sim.paid = (_p, settle) => {
        settle();
        return paidAnswer({ id: 'c', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'All quiet.' } }], usage: { prompt_tokens: 500, completion_tokens: 10, total_tokens: 510 } }, { amount: '2600' });
      };
      const sent = await sendChatMessage(w.ctx, agent, { by: agent.creator, text: 'How was today?' });
      expect(sent).toMatchObject({ ok: true, pending: false });
      if (!sent.ok) return;
      expect(sent.message.text).toBe('All quiet.');
      expect(sent.message.chargedMicroUsdc).toBe('2600');
      expect(sim.signatures).toHaveLength(1);
      expect(relayPayments).toEqual([]);
      expect(await recentThoughtCost(w.ctx, AGENT_ID)).toEqual({ thoughts: 0, spentMicroUsdc: 0 });
      const report = await fuelReport(w.ctx, AGENT_ID, new Date(0));
      expect(report.byModel[0]).toMatchObject({ thoughts: 1, chargedMicroUsdc: '2600', directThoughts: 1 });
    } finally {
      await w.close();
    }
  });

  it('a chat key is capped lower: a quote above the chat cap goes to the relay, which also refuses it', async () => {
    const { w, sim, relayPayments } = await direct();
    try {
      const agent = await seedAgent(w);
      sim.quote = 200_000n;
      const call = { ...thought('chat:7:x', 150_000n) };
      await relayRequest(w.ctx, agent, call);
      expect(sim.signatures).toEqual([]);
      expect(relayPayments.every((k) => k === 'chat:7:x')).toBe(true);
    } finally {
      await w.close();
    }
  });

  it('after a direct failure every path of that agent uses the relay until the hold ends', async () => {
    const { w, sim, relayPayments } = await direct({ BLOCKRUN_HOLD_MS: String(30 * MINUTE) });
    try {
      const agent = await seedAgent(w);
      sim.paid = () => jsonResponse({ code: 'TIMEOUT' }, 504);
      await relayRequest(w.ctx, agent, thought('inference:a'));
      expect(sim.signatures).toHaveLength(1);
      // an open row already holds the agent: a different key goes to the relay
      expect((await relayRequest(w.ctx, agent, thought('chat:7:y'))).kind).toBe('ok');
      expect(relayPayments).toEqual(['chat:7:y']);
      expect(sim.signatures).toHaveLength(1);
      w.setNow(w.ctx.now() + 6 * MINUTE);
      await reconcileRelay(w.ctx, 'inference:a');
      expect((await relayRequest(w.ctx, agent, thought('inference:b'))).kind).toBe('ok');
      expect(relayPayments).toEqual(['chat:7:y', 'inference:b']);
      // the hold is over: BlockRun gets another try
      w.setNow(w.ctx.now() + 31 * MINUTE);
      sim.paid = (_p, settle) => {
        settle();
        return paidAnswer(toolCallBody());
      };
      expect((await relayRequest(w.ctx, agent, thought('inference:c'))).kind).toBe('ok');
      expect(sim.signatures).toHaveLength(2);
      expect(relayPayments).toEqual(['chat:7:y', 'inference:b']);
    } finally {
      await w.close();
    }
  });
});

describe('what one payment can spend', () => {
  it('the signature covers at most the quote, for BlockRun only, for 300 s', async () => {
    const { w, sim } = await direct();
    try {
      const agent = await seedAgent(w);
      await relayRequest(w.ctx, agent, thought());
      const auth = (sim.signatures[0]!.payload as { permit2Authorization: { permitted: { amount: string }; witness: { to: string }; deadline: string } }).permit2Authorization;
      expect(auth.permitted.amount).toBe(CEILING.toString());
      expect(getAddress(auth.witness.to)).toBe(BLOCKRUN_PAYTO);
      expect(Number(auth.deadline) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
    } finally {
      await w.close();
    }
  });

  it('refuses a signature that would stay valid for longer than ten minutes', async () => {
    const { w, sim, relayPayments } = await direct();
    try {
      const agent = await seedAgent(w);
      const required = fixture('payment-required').requirements as { accepts: Record<string, unknown>[] };
      const accepts = required.accepts.map((a) => ({ ...a, network: 'eip155:84532', asset: ADDR.usdc, amount: CEILING.toString(), maxTimeoutSeconds: 86_400 }));
      sim.probe = () => new Response('{}', { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify({ ...required, accepts })).toString('base64') } });
      await relayRequest(w.ctx, agent, thought());
      expect(sim.signatures).toEqual([]);
      expect(relayPayments).toEqual(['inference:k1']);
    } finally {
      await w.close();
    }
  });
});

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const PNG_URI = `data:image/png;base64,${PNG.toString('base64')}`;
const imageAction = { id: 'act_1' } as never;
const imageInput = { prompt: 'a cat', altText: 'a cat' } as never;
const imageSettled = (url: string, tx: string = TX) => new Response(JSON.stringify({ id: 'job-1', created: 1, data: [{ url, backed_up: true }], price: { amount: '0.106', currency: 'USD' }, payment: { status: 'settled', tx_hash: tx, network: 'eip155:84532' } }), { status: 200, headers: { 'content-type': 'application/json', 'x-payment-receipt': tx, 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: tx, network: 'eip155:84532' })).toString('base64') } });

describe('full direct: no relay behind it', () => {
  const FULL = { BLOCKRUN_RELAY_FALLBACK: 'false', BLOCKRUN_ALLOW_EXACT: 'true', BLOCKRUN_IMAGE_POLL_MS: '0' };
  const runtimeRow = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
  const minutes = async (w: TestWorld, n: number, each?: () => void) => {
    for (let i = 0; i < n; i++) {
      w.setNow(w.ctx.now() + MINUTE);
      await tick(w.ctx);
      each?.();
    }
  };

  it('is the default: an unset BLOCKRUN_RELAY_FALLBACK means no relay', async () => {
    const { w, sim, relayPayments, relay } = await direct({ BLOCKRUN_RELAY_FALLBACK: '' });
    try {
      expect(w.ctx.config.BLOCKRUN_RELAY_FALLBACK).toBe(false);
      const agent = await seedAgent(w);
      sim.probe = () => jsonResponse({ code: 'MODEL_UNAVAILABLE' }, 503);
      const res = await relayRequest(w.ctx, agent, thought());
      expect(res).toMatchObject({ kind: 'failed', error: expect.stringContaining('direct_unavailable') });
      expect(sim.signatures).toEqual([]);
      expect(relayPayments).toEqual([]);
      expect(relay.facilitator.settle).not.toHaveBeenCalled();
      expect((await fuelReport(w.ctx, AGENT_ID, new Date(0))).byModel).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('a model BlockRun does not know: the creator is told, the fleet is not held, nothing is paid; the notice clears once the model is changed', async () => {
    const { w, sim, relayPayments } = await direct(FULL);
    try {
      await seedAgent(w, { config: { model: 'vendor/retired-forever' } });
      sim.probe = () => jsonResponse(fixture('error-unknown-model').body, 400);
      await tick(w.ctx);
      const row = await runtimeRow(w);
      expect(row.failures).toBe(1);
      expect(row.lastError).toContain('model_missing: vendor/retired-forever');
      expect(sim.signatures).toEqual([]);
      expect(relayPayments).toEqual([]);
      // the creator's inbox names it; the owner's log carries the same line at error level (not asserted here)
      const open = await w.db.select().from(notificationsTable).where(eq(notificationsTable.agentId, AGENT_ID));
      expect(open.map((n) => [n.event, n.resolvedAt])).toEqual([['model_unavailable', null]]);
      expect(open[0]!.data).toMatchObject({ model: 'vendor/retired-forever', field: 'model' });
      // one agent's wrong model is not a provider outage: no fleet-wide hold
      expect(providerHold(w.ctx.now())).toBeNull();
      // the creator (or the migration) picks a served model: the next thought answers and the notice closes
      await w.db.update(agentsTable).set({ config: { ...agentConfig(w.ctx.now(), { model: MODEL }), revision: 2 } }).where(eq(agentsTable.agentId, AGENT_ID));
      sim.probe = null;
      sim.paid = (_p, settle) => {
        settle();
        return paidAnswer(finishThought(w.ctx.now() + 60 * MINUTE));
      };
      await minutes(w, 20);
      expect(sim.signatures).toHaveLength(1);
      expect((await w.db.select().from(notificationsTable).where(eq(notificationsTable.agentId, AGENT_ID)))[0]!.resolvedAt).not.toBeNull();
    } finally {
      await w.close();
    }
  });

  it('two hours of BlockRun down: no signature, no payment to anyone, backoff growing, and it recovers by itself', async () => {
    const { w, sim, relayPayments, relay } = await direct(FULL);
    try {
      await seedAgent(w, { config: { model: MODEL } });
      sim.probe = () => jsonResponse({ code: 'MODEL_UNAVAILABLE' }, 503);
      await tick(w.ctx);
      expect((await runtimeRow(w)).failures).toBe(1);
      await minutes(w, 120);
      expect(sim.signatures).toEqual([]);
      expect(relayPayments).toEqual([]);
      expect(relay.facilitator.settle).not.toHaveBeenCalled();
      expect(relay.upstreamFetch).not.toHaveBeenCalled();
      expect(w.state.spentNonces!.size).toBe(0);
      const down = await runtimeRow(w);
      expect(down.failures).toBeGreaterThan(5);
      expect(sim.probes.length).toBeLessThan(25); // capped backoff, not one try a minute

      sim.probe = null;
      sim.paid = (_p, settle) => {
        settle();
        return paidAnswer(finishThought(w.ctx.now() + 60 * MINUTE));
      };
      await minutes(w, 16);
      expect(sim.signatures).toHaveLength(1);
      expect((await runtimeRow(w)).failures).toBe(0);
      expect(relayPayments).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('two hours of failing after the signature: every signature dies unused, nothing moves, the relay is never paid', async () => {
    const { w, sim, relayPayments, relay } = await direct(FULL);
    try {
      await seedAgent(w, { config: { model: MODEL } });
      sim.paid = () => jsonResponse({ code: 'MODEL_UNAVAILABLE' }, 503);
      await tick(w.ctx);
      await minutes(w, 120);
      expect(sim.signatures.length).toBeGreaterThan(0);
      expect(sim.signatures.length).toBeLessThan(15);
      expect(w.state.spentNonces!.size).toBe(0);
      expect(relayPayments).toEqual([]);
      expect(relay.facilitator.settle).not.toHaveBeenCalled();
      expect((await fuelReport(w.ctx, AGENT_ID, new Date(0))).byModel).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('after money was lost there is no new signature until the hold ends', async () => {
    const { w, sim, relayPayments } = await direct({ ...FULL, BLOCKRUN_HOLD_MS: String(30 * MINUTE) });
    try {
      const agent = await seedAgent(w);
      sim.paid = (_p, settle) => {
        settle();
        return jsonResponse({ code: 'TIMEOUT' }, 504);
      };
      await relayRequest(w.ctx, agent, thought('inference:a'));
      expect(await reconcileRelay(w.ctx, 'inference:a')).toMatchObject({ kind: 'failed', error: DIRECT_PAID_LOST });
      expect(sim.signatures).toHaveLength(1);
      expect(await relayRequest(w.ctx, agent, thought('inference:b'))).toMatchObject({ kind: 'failed', error: DIRECT_HOLD });
      expect(sim.signatures).toHaveLength(1);
      expect(sim.probes).toHaveLength(1);
      expect(relayPayments).toEqual([]);
      w.setNow(w.ctx.now() + 31 * MINUTE);
      sim.paid = (_p, settle) => {
        settle();
        return paidAnswer(toolCallBody());
      };
      expect((await relayRequest(w.ctx, agent, thought('inference:c'))).kind).toBe('ok');
      expect(sim.signatures).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('a model with no upto pays exact, the whole quote, from the same wallet', async () => {
    const { w, sim, relayPayments } = await direct(FULL);
    try {
      const agent = await seedAgent(w);
      sim.offerUpto = false;
      sim.quote = 27_244n;
      const call = { ...thought(), request: { ...thought().request, model: 'openai/gpt-5.4-mini' }, maxQuoteMicroUsdc: BigInt(maxQuoteFor('openai/gpt-5.4-mini')) };
      expect((await relayRequest(w.ctx, agent, call)).kind).toBe('ok');
      expect(sim.signatures[0]!.accepted.scheme).toBe('exact');
      expect(relayPayments).toEqual([]);
      expect((await rowOf(w)).receipt).toMatchObject({ relay: { chargedMicroUsdc: '27244' }, direct: { scheme: 'exact' } });
    } finally {
      await w.close();
    }
  });

  it('launch-form models BlockRun lacks go out under their stand-in, and the row keeps the name the agent chose', async () => {
    const { w, sim } = await direct(FULL);
    try {
      const agent = await seedAgent(w);
      sim.offerUpto = false;
      sim.quote = 20_000n;
      const call = { ...thought(), request: { ...thought().request, model: 'x-ai/grok-4.20' }, maxQuoteMicroUsdc: BigInt(maxQuoteFor('x-ai/grok-4.20')) };
      expect((await relayRequest(w.ctx, agent, call)).kind).toBe('ok');
      expect(sim.probes).toEqual(['xai/grok-4.3']);
      expect((await rowOf(w)).request.model).toBe('x-ai/grok-4.20');
      expect(DIRECT_SUBSTITUTES['deepseek/deepseek-v3.2']).toBe('deepseek/deepseek-chat');
      expect(DIRECT_SUBSTITUTES['meta-llama/llama-4-maverick']).toBe('deepseek/deepseek-chat');
    } finally {
      await w.close();
    }
  });

  describe('pictures on BlockRun (BLOCKRUN_IMAGE_ROUTE=direct)', () => {
    const IMAGE_MODEL = 'google/gemini-3-pro-image';
    const world = async () => {
      const made = await direct({ ...FULL, BLOCKRUN_IMAGE_ROUTE: 'direct' });
      made.sim.offerUpto = false;
      made.sim.quote = 106_000n;
      const agent = await seedAgent(made.w, { config: { model: MODEL, imageModel: IMAGE_MODEL } });
      return { ...made, agent };
    };
    const config = (over: Record<string, unknown> = {}) => ({ imageModel: IMAGE_MODEL, imageStyle: { reference: null, notes: '' }, ...over }) as never;

    it('a data URI answer: paid once with exact, stored, and fuel counts it as the picture it is', async () => {
      const { w, sim, agent, relayPayments } = await world();
      try {
        sim.paid = (_p, settle) => {
          settle();
          return imageSettled(PNG_URI);
        };
        const res = await generateImage(w.ctx, agent, config(), imageAction, imageInput);
        expect(res).toMatchObject({ kind: 'completed', result: { mime: 'image/png', bytes: PNG.length } });
        expect(sim.probes).toEqual(['google/nano-banana-pro']);
        expect(sim.bodies[0]).toMatchObject({ model: 'google/nano-banana-pro', size: '1024x1024', n: 1 });
        expect(String(sim.bodies[0]!.prompt)).toContain('a cat');
        expect(sim.signatures).toHaveLength(1);
        expect(sim.signatures[0]!.accepted.scheme).toBe('exact');
        expect(relayPayments).toEqual([]);
        const row = await rowOf(w, 'image:act_1');
        expect(row.receipt).toMatchObject({ route: 'blockrun', relay: { chargedMicroUsdc: '106000', paymentTxOrId: TX } });
        expect(await recentThoughtCost(w.ctx, AGENT_ID)).toEqual({ thoughts: 0, spentMicroUsdc: 0 });
        // the same action again is the stored picture, no second payment
        expect((await generateImage(w.ctx, agent, config(), imageAction, imageInput)).kind).toBe('completed');
        expect(sim.signatures).toHaveLength(1);
      } finally {
        await w.close();
      }
    });

    it('a hosted answer is downloaded; a non-image answer is no picture', async () => {
      const { w, sim, agent } = await world();
      try {
        sim.outside = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
        sim.paid = (_p, settle) => {
          settle();
          return imageSettled('https://cdn.test/pic.png');
        };
        expect(await generateImage(w.ctx, agent, config(), imageAction, imageInput)).toMatchObject({ kind: 'completed', result: { bytes: PNG.length } });
        sim.outside = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
        expect((await generateImage(w.ctx, agent, config(), { id: 'act_2' } as never, imageInput)).kind).toBe('unknown');
        expect(await reconcileRelay(w.ctx, 'image:act_2')).toMatchObject({ kind: 'failed', error: DIRECT_PAID_LOST });
      } finally {
        await w.close();
      }
    });

    it('with a reference it uses the edit endpoint, sending the picture as a data URI', async () => {
      const { w, sim, agent } = await world();
      try {
        sim.outside = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
        sim.paid = (_p, settle) => {
          settle();
          return imageSettled(PNG_URI);
        };
        const res = await generateImage(w.ctx, agent, config({ imageStyle: { reference: 'https://cdn.test/coin.png', notes: 'flat' } }), imageAction, imageInput);
        expect(res.kind).toBe('completed');
        expect(sim.urls.at(-1)).toContain('/images/image2image');
        expect(sim.bodies.at(-1)).toMatchObject({ model: 'google/nano-banana-pro', image: PNG_URI });
      } finally {
        await w.close();
      }
    });

    it('a reference on a private host is not fetched, and the picture is made without it', async () => {
      const { w, sim, agent } = await world();
      try {
        w.ctx.resolveHost = async () => [{ address: '10.0.0.1' }];
        sim.outside = () => {
          throw new Error('must not be fetched');
        };
        sim.paid = (_p, settle) => {
          settle();
          return imageSettled(PNG_URI);
        };
        const res = await generateImage(w.ctx, agent, config({ imageStyle: { reference: 'https://cdn.test/coin.png', notes: '' } }), imageAction, imageInput);
        expect(res.kind).toBe('completed');
        expect(sim.urls.at(-1)).toContain('/images/generations');
      } finally {
        await w.close();
      }
    });

    it('a slow picture: unknown until the poll sees it done, and only then paid', async () => {
      const { w, sim, agent } = await world();
      try {
        let done = false;
        sim.paid = () => new Response(JSON.stringify({ id: 'job-1', status: 'queued', poll_url: '/api/v1/images/generations/job-1', payment_status: 'verified' }), { status: 202 });
        sim.poll = (req) => {
          expect(req.headers.get('x-payment')).toBeTruthy();
          if (!done) return jsonResponse({ id: 'job-1', status: 'in_progress' }, 202);
          w.state.spentNonces!.add(nonceKey(sim.signatures[0]!));
          return imageSettled(PNG_URI);
        };
        expect(await generateImage(w.ctx, agent, config(), imageAction, imageInput)).toMatchObject({ kind: 'unknown' });
        expect(w.state.spentNonces!.size).toBe(0);
        done = true;
        expect(await generateImage(w.ctx, agent, config(), imageAction, imageInput)).toMatchObject({ kind: 'completed' });
        expect(sim.signatures).toHaveLength(1);
      } finally {
        await w.close();
      }
    });

    it('a slow picture that fails, or a poll address on another origin, costs nothing', async () => {
      const { w, sim, agent } = await world();
      try {
        sim.paid = () => new Response(JSON.stringify({ id: 'job-1', status: 'queued', poll_url: '/api/v1/images/generations/job-1' }), { status: 202 });
        sim.poll = () => jsonResponse({ id: 'job-1', status: 'failed', payment_status: 'not_charged' });
        expect(await generateImage(w.ctx, agent, config(), imageAction, imageInput)).toMatchObject({ kind: 'failed', error: expect.stringContaining(DIRECT_UNPAID) });

        sim.paid = () => new Response(JSON.stringify({ id: 'job-2', status: 'queued', poll_url: 'https://elsewhere.test/poll' }), { status: 202 });
        sim.outside = () => {
          throw new Error('the payment must not go to another origin');
        };
        expect((await generateImage(w.ctx, agent, config(), { id: 'act_2' } as never, imageInput)).kind).toBe('unknown');
      } finally {
        await w.close();
      }
    });

    it('BlockRun down, or a model it lacks: the action fails unpaid and the relay hears nothing', async () => {
      const { w, sim, agent, relayPayments } = await world();
      try {
        sim.probe = () => jsonResponse({ error: 'overloaded' }, 503);
        const down = await generateImage(w.ctx, agent, config(), imageAction, imageInput);
        expect(down).toMatchObject({ kind: 'failed', error: expect.stringContaining('direct_unavailable') });
        const lacks = await generateImage(w.ctx, agent, { imageModel: 'x/unknown-image', imageStyle: { reference: null, notes: '' } } as never, { id: 'act_2' } as never, imageInput);
        expect(lacks).toMatchObject({ kind: 'failed', error: expect.stringContaining('model_missing: x/unknown-image') });
        expect(sim.signatures).toEqual([]);
        expect(relayPayments).toEqual([]);
      } finally {
        await w.close();
      }
    });
  });

  /** The owner's decision of 2026-11-08: thoughts pay BlockRun, pictures keep paying the relay, so OpenRouter stays funded for pictures alone. */
  describe('pictures on the relay (the default) while every thought pays BlockRun', () => {
    const IMAGE_MODEL = 'google/nano-banana-pro';
    const RELAY_NAME = 'google/gemini-3-pro-image';
    const pictureFromOpenRouter = () => jsonResponse({ id: 'img', choices: [{ message: { role: 'assistant', content: 'here', images: [{ type: 'image_url', image_url: { url: PNG_URI } }] }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 1300, completion_tokens_details: { image_tokens: 1120 } } });
    const world = async (config: Record<string, string> = {}) => {
      const made = await direct({ ...FULL, ...config });
      const agent = await seedAgent(made.w, { config: { model: MODEL, imageModel: IMAGE_MODEL } });
      made.relay.upstreamFetch.mockImplementation(async () => pictureFromOpenRouter());
      return { ...made, agent };
    };
    const config = (over: Record<string, unknown> = {}) => ({ imageModel: IMAGE_MODEL, imageStyle: { reference: null, notes: '' }, ...over }) as never;

    it('is the default: with direct mode on and the fallback off, a picture pays the relay under the relay’s name and BlockRun hears nothing; the thought still pays BlockRun', async () => {
      const { w, sim, agent, relay, relayPayments } = await world();
      try {
        expect(w.ctx.config.BLOCKRUN_IMAGE_ROUTE).toBe('relay');
        expect(w.ctx.config.BLOCKRUN_RELAY_FALLBACK).toBe(false);
        const res = await generateImage(w.ctx, agent, config(), imageAction, imageInput);
        expect(res).toMatchObject({ kind: 'completed', result: { mime: 'image/png', bytes: PNG.length } });
        expect(relayPayments).toEqual(['image:act_1']);
        expect(sim.probes).toEqual([]);
        expect(sim.signatures).toEqual([]);
        expect(relay.facilitator.settle).toHaveBeenCalledTimes(1);
        expect(relay.upstreamCalls).toHaveLength(1);
        expect(JSON.parse(await relay.upstreamCalls[0]!.text())).toMatchObject({ model: RELAY_NAME, modalities: ['image', 'text'] });
        const row = await rowOf(w, 'image:act_1');
        expect(row.status).toBe('succeeded');
        expect((row.receipt as { route?: unknown }).route).toBeUndefined();
        expect((row.receipt as { relay?: { chargedMicroUsdc?: string } }).relay?.chargedMicroUsdc).toMatch(/^\d+$/);
        expect(row.request).toMatchObject({ model: IMAGE_MODEL });
        // the same action again is the stored picture, no second payment anywhere
        expect((await generateImage(w.ctx, agent, config(), imageAction, imageInput)).kind).toBe('completed');
        expect(relayPayments).toHaveLength(1);

        // a thought of the same agent goes to BlockRun as before
        const thoughtRes = await relayRequest(w.ctx, agent, thought());
        expect(thoughtRes.kind).toBe('ok');
        expect(sim.signatures).toHaveLength(1);
        expect(relayPayments).toEqual(['image:act_1']);
        const report = await fuelReport(w.ctx, AGENT_ID, new Date(0));
        expect(report.byModel.find((m) => m.model === IMAGE_MODEL)).toMatchObject({ thoughts: 1 });
        expect(report.byModel.find((m) => m.model === IMAGE_MODEL)!.directThoughts).toBeUndefined();
        expect(report.byModel.find((m) => m.model === MODEL)).toMatchObject({ thoughts: 1, directThoughts: 1 });
      } finally {
        await w.close();
      }
    });

    it('the picture hint and the model list show the relay’s price, not BlockRun’s', async () => {
      const { w, agent } = await world();
      try {
        const catalog = await relayImageCatalog(w.ctx, agent);
        expect(catalog).not.toBe(BLOCKRUN_IMAGE_CATALOG);
        expect(catalog.live).toBe(true);
        expect(catalog.models.map((m) => m.id)).toContain(RELAY_NAME);
        // the relay's own list prices Nano Banana Pro by its tokens (about 0.15 USDC), BlockRun's fixed price would be 0.106
        const price = picturePriceFor(catalog, IMAGE_MODEL)!;
        expect(price.live).toBe(true);
        expect(price.microUsdc).toBeGreaterThan(140_000);
        expect(price.microUsdc).toBeLessThan(170_000);
        expect(picturePriceFor(BLOCKRUN_IMAGE_CATALOG, IMAGE_MODEL)).toEqual({ microUsdc: 106_000, live: true });
        expect(await relayImageModels(w.ctx, agent)).toContain(RELAY_NAME);
      } finally {
        await w.close();
      }
    });

    it('a model the relay does not price is refused before any payment, naming the way out', async () => {
      const { w, agent, relayPayments } = await world();
      try {
        const res = await generateImage(w.ctx, agent, config({ imageModel: 'openai/gpt-image-1' }), imageAction, imageInput);
        expect(res).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_model_unavailable: openai\/gpt-image-1 .* another image model in the console\. Publish your post without an imageId/) });
        expect(relayPayments).toEqual([]);
      } finally {
        await w.close();
      }
    });

    it.each([402, 403])('the relay’s provider answers %i: the first picture is a credit at the relay, the agent goes on without, no agent buys another for a day, one error line for the owner', async (status) => {
      const { w, sim, agent, relay, relayPayments } = await world();
      try {
        vi.spyOn(w.ctx.log, 'child').mockReturnValue(w.ctx.log as never);
        const owner = vi.spyOn(w.ctx.log, 'error');
        relay.upstreamFetch.mockImplementation(async () => jsonResponse({ error: { code: status, message: status === 402 ? 'Insufficient credits' : 'Key limit exceeded' } }, status));
        const first = await generateImage(w.ctx, agent, config(), imageAction, imageInput);
        expect(first).toEqual({ kind: 'failed', error: `${PICTURES_UNAVAILABLE_MESSAGE}. ${WITHOUT_PICTURE}` });
        // paid once at the relay (exact settles first), kept there as a credit for this key; BlockRun never asked
        expect(relayPayments).toEqual(['image:act_1']);
        expect(relay.facilitator.settle).toHaveBeenCalledTimes(1);
        expect(sim.signatures).toEqual([]);
        const row = await rowOf(w, 'image:act_1');
        expect(row.status).toBe('unknown');
        expect(row.error).toBe(`${PICTURES_UNAVAILABLE}: the relay's provider answered ${status} (upstream_rejected)`);
        expect(owner).toHaveBeenCalledTimes(1);
        expect(owner).toHaveBeenCalledWith(expect.objectContaining({ key: 'image:act_1', upstreamStatus: status, paid: true }), expect.stringContaining('fund OpenRouter'));

        // the hold: another picture, or the same action resumed, is refused before any payment and the credit is not replayed
        const upstream = relay.upstreamFetch.mock.calls.length;
        expect(await generateImage(w.ctx, agent, config(), { id: 'act_2' } as never, imageInput)).toEqual({ kind: 'failed', error: `${PICTURES_UNAVAILABLE_MESSAGE}. ${WITHOUT_PICTURE}` });
        expect(await generateImage(w.ctx, agent, config(), imageAction, imageInput)).toEqual({ kind: 'failed', error: `${PICTURES_UNAVAILABLE_MESSAGE}. ${WITHOUT_PICTURE}` });
        expect(relayPayments).toHaveLength(1);
        expect(relay.upstreamFetch.mock.calls.length).toBe(upstream);
        expect(owner).toHaveBeenCalledTimes(1);
        const hold = (await pictureHold(w.ctx))!;
        expect(hold.until).toBe(row.updatedAt.getTime() + PICTURE_HOLD_MS);
        expect(hold.error).toBe(row.error);
        // the owner also sees it on /health
        const health = (await (await createApp(w.ctx).request('/health')).json()) as { pictureHold: { until: string; error: string } | null };
        expect(health.pictureHold).toEqual({ until: new Date(hold.until).toISOString(), error: row.error });

        // thoughts are untouched by the hold
        expect((await relayRequest(w.ctx, agent, thought())).kind).toBe('ok');
        expect(sim.signatures).toHaveLength(1);

        // the hint tells the model the same, in the same words
        const hint = await pictureSection(w.ctx, agent, { ...agentConfig(w.ctx.now(), { imageModel: IMAGE_MODEL, capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: true } }), platform: false } as never, [{ name: 'generate_image' }], { schedule: null, treasury: null }, null);
        expect(hint.picture).toMatchObject({ suggested: false, reason: PICTURES_UNAVAILABLE_MESSAGE });

        // a day later one picture is bought again
        w.setNow(w.ctx.now() + PICTURE_HOLD_MS + 1000);
        relay.upstreamFetch.mockImplementation(async () => pictureFromOpenRouter());
        expect((await generateImage(w.ctx, agent, config(), { id: 'act_3' } as never, imageInput)).kind).toBe('completed');
        expect(relayPayments).toEqual(['image:act_1', 'image:act_3']);
      } finally {
        await w.close();
      }
    });

    it('with BLOCKRUN_IMAGE_ROUTE=direct the same picture pays BlockRun and the hold is never consulted', async () => {
      const { w, sim, agent, relayPayments } = await world({ BLOCKRUN_IMAGE_ROUTE: 'direct' });
      try {
        sim.offerUpto = false;
        sim.quote = 106_000n;
        sim.paid = (_p, settle) => {
          settle();
          return imageSettled(PNG_URI);
        };
        expect((await generateImage(w.ctx, agent, config(), imageAction, imageInput)).kind).toBe('completed');
        expect(sim.probes).toEqual([IMAGE_MODEL]);
        expect(relayPayments).toEqual([]);
        expect(await relayImageCatalog(w.ctx, agent)).toBe(BLOCKRUN_IMAGE_CATALOG);
      } finally {
        await w.close();
      }
    });
  });
});

describe('maxQuoteFor stays above what BlockRun can quote, so no agent silently stops', () => {
  /** BlockRun's list prices, USD per million, 2026-11-06. */
  const RATES: Record<string, [number, number]> = {
    'anthropic/claude-haiku-4.5': [1, 5],
    'anthropic/claude-sonnet-4.6': [3, 15],
    'openai/gpt-5.4-mini': [0.75, 4.5],
    'openai/gpt-4.1-mini': [0.4, 1.6],
    'google/gemini-3.5-flash-lite': [0.3, 2.5],
    'deepseek/deepseek-v3.2': [0.14, 0.28],
    'x-ai/grok-4.20': [1.25, 2.5],
    'meta-llama/llama-4-maverick': [0.14, 0.28],
  };
  const WORST_INPUT_TOKENS = 200_000; // MAX_CONTEXT_BYTES at BlockRun's one token per two bytes
  const WORST_OUTPUT_TOKENS = 4096; // INFERENCE_RETRY_OUTPUT_TOKENS

  it.each(Object.entries(RATES))('%s', (model, [input, output]) => {
    const ceiling = WORST_INPUT_TOKENS * input + WORST_OUTPUT_TOKENS * output + 1000;
    expect(ceiling).toBeLessThan(maxQuoteFor(model));
  });

  it('every launch-form model has a direct id, itself or a stand-in', () => {
    for (const model of Object.keys(RATES)) expect(directModel(model) === model || DIRECT_SUBSTITUTES[model]).toBeTruthy();
  });

  it.each(Object.entries({ 'google/gemini-2.5-flash-image': 53_500, 'google/gemini-3.1-flash-image': 95_500, 'google/gemini-3-pro-image': 106_000, 'openai/gpt-5-image-mini': 22_000, 'openai/gpt-5.4-image-2': 64_000 }))('picture on %s', (model, price) => {
    expect(DIRECT_IMAGE_MODELS[model]).toBeTruthy();
    expect(price).toBeLessThan(maxQuoteFor(model));
  });

  it('a private chat of a real thought size fits the chat cap on the models agents use', () => {
    // 61 kB at 1 token per 2 bytes, the whole output allowance: the largest measured prompt on the dearest launch-form model
    expect(30_500 * 3 + CHAT_MAX_OUTPUT_TOKENS * 15 + 1000).toBeLessThan(CHAT_MAX_QUOTE_MICRO_USDC);
  });
});
