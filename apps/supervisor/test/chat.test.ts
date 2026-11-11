import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TOOL_LIST } from '@bootr/agent-core';
import { computeQuote, DEFAULT_PRICE_TABLE } from '@bootr/inference';
import { LOW_FUEL_THOUGHTS } from '@bootr/shared/fuel';
import { createApp } from '../src/api.js';
import { CHAT_LIMITS, CHAT_MAX_CHARS, CHAT_MAX_OUTPUT_TOKENS, CHAT_MAX_QUOTE_MICRO_USDC, CHAT_MEMORY_SOURCE, chatToolDecision, chatTools, chatView, CUT_SHORT_NOTE, estimateQuote, fuelGate, NO_ANSWER_TEXT, REFUSAL_TEXT, REQUEST_FILED_TEXT, REQUESTS_FULL_TEXT, resetChatPrices, RETRY_NUDGE, sendChatMessage, THIN_DATA_THOUGHT_MICRO_USDC } from '../src/chat.js';
import { closeRequest, CREATOR_REQUESTS_OPEN_MAX, fileRequest, openRequests } from '../src/creator-requests.js';
import { actions, approvals, chatMessages, images, inference, memories, runtimes, treasuryOps } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { recentThoughtCost } from '../src/inference.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, finishResponse, makeWorld, seedAgent, SUPERVISOR_KEY, toolCallResponse, type TestWorld } from './helpers.js';

const MODEL = 'anthropic/claude-sonnet-4.6';
const receipt = (charged = '12000') => JSON.stringify({ requestId: 'r', quoteMicroUsdc: charged, chargedMicroUsdc: charged, paymentReference: 'p' });

function say(text: string, charged?: string): Response {
  return new Response(JSON.stringify({ id: 'cmpl', choices: [{ message: { role: 'assistant', content: text } }] }), { status: 200, headers: { 'content-type': 'application/json', 'x-bootr-receipt': receipt(charged) } });
}

/** An answer in any shape the gateway may send: `content` as given, with the provider's finish reason. */
function reply(content: unknown, finish_reason = 'stop', charged?: string): Response {
  return new Response(JSON.stringify({ id: 'cmpl', choices: [{ index: 0, finish_reason, message: { role: 'assistant', content } }] }), { status: 200, headers: { 'content-type': 'application/json', 'x-bootr-receipt': receipt(charged) } });
}

type RequestBody = { model: string; max_tokens: number; tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
const completions = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
const lastBody = (w: TestWorld) => completions(w).at(-1)!.body as RequestBody;

async function runtimeRow(w: TestWorld) {
  return (await w.db.select().from(runtimes).where(eq(runtimes.agentId, AGENT_ID)))[0]!;
}

async function world(script: Response[], over: Parameters<typeof seedAgent>[1] = {}, chain: Parameters<typeof makeWorld>[0] = {}) {
  const w = await makeWorld({ ...chain, script });
  const agent = await seedAgent(w, { ...over, config: { model: MODEL, ...over.config } });
  return { w, agent };
}

/** Everything a chat turn could use to act in the world, armed: touching any of it fails the test. */
function disarm(w: TestWorld) {
  const trap = (name: string) =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(`chat touched ${name}`);
        },
      },
    );
  w.ctx.sender = trap('sender') as typeof w.ctx.sender;
  w.ctx.adminSigner = trap('adminSigner') as typeof w.ctx.adminSigner;
  w.ctx.sessionSigner = trap('sessionSigner') as typeof w.ctx.sessionSigner;
  w.ctx.kernelFor = () => {
    throw new Error('chat touched kernelFor');
  };
}

async function noEffects(w: TestWorld) {
  expect(await w.db.select().from(actions)).toEqual([]);
  expect(await w.db.select().from(treasuryOps)).toEqual([]);
  expect(await w.db.select().from(approvals)).toEqual([]);
  expect(await w.db.select().from(images)).toEqual([]);
}

function api(world: TestWorld) {
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  return {
    get: (path: string) => app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } }),
    post: (path: string, body: unknown) => {
      const text = JSON.stringify(body);
      return app.request(path, { method: 'POST', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'POST', path, text, nowSec()) } });
    },
  };
}

beforeEach(() => resetChatPrices());

describe('a chat turn', () => {
  it('answers with the agent’s persona and memory on its own key, offering only remember and request, under a hard cost ceiling', async () => {
    const { w, agent } = await world([say('We posted twice today.')], { config: { identityText: 'You are Marlin, a patient fish.' } });
    await w.ctx.memories.remember(AGENT_ID, { text: 'The pool opened on Tuesday.', tags: ['pool'] });
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'When did the pool open?' });
    expect(res).toMatchObject({ ok: true, pending: false, message: { role: 'agent', text: 'We posted twice today.', status: 'done', chargedMicroUsdc: '12000', remembered: false } });

    const body = lastBody(w);
    const system = body.messages[0]!.content;
    expect(system).toContain('You are Marlin, a patient fish.');
    expect(system).toContain('The pool opened on Tuesday.');
    expect(system).toContain('private conversation');
    expect(system).not.toContain('publish_post');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'When did the pool open?' });
    expect(body.tools.map((t) => t.function.name)).toEqual(['remember', 'request']);
    expect(body.max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
    expect(CHAT_MAX_OUTPUT_TOKENS).toBe(1200);
    const call = completions(w).at(-1)!;
    expect(call.headers.get('Idempotency-Key')).toMatch(/^chat:7:/);
    expect(Number(call.headers.get('X-Max-Quote-Micro-USDC'))).toBeLessThanOrEqual(CHAT_MAX_QUOTE_MICRO_USDC);
    await w.close();
  });

  it('sends earlier messages back in order, and the conversation stays private to the chat table', async () => {
    const { w, agent } = await world([say('First answer.'), say('Second answer.')]);
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'First question' });
    w.setNow(w.ctx.now() + 60_000);
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Second question' });
    expect(lastBody(w).messages.slice(1)).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer.' },
      { role: 'user', content: 'Second question' },
    ]);
    const view = await chatView(w.ctx, agent);
    expect(view.messages.map((m) => [m.role, m.text])).toEqual([
      ['creator', 'First question'],
      ['agent', 'First answer.'],
      ['creator', 'Second question'],
      ['agent', 'Second answer.'],
    ]);
    await noEffects(w);
    await w.close();
  });

  it('runs on the cheaper model when economy mode is on', async () => {
    const { w, agent } = await world([say('ok')], { config: { routing: { decideModel: 'anthropic/claude-haiku-4.5' } } });
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' });
    expect(lastBody(w).model).toBe('anthropic/claude-haiku-4.5');
    await w.close();
  });

  it('tells the agent to answer in the language the creator writes in', async () => {
    const { w, agent } = await world([say('Bugün iki gönderi paylaştık.')]);
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Bugün ne yaptın?' });
    expect(lastBody(w).messages[0]!.content).toContain('Answer in the language your creator writes in');
    await w.close();
  });
});

describe('what the model sends back', () => {
  it('joins the text parts and drops the reasoning parts of an answer that came as an array', async () => {
    const { w, agent } = await world([reply([{ type: 'thinking', thinking: 'the creator writes in Turkish' }, { type: 'text', text: 'Bugün iki ' }, { type: 'reasoning', text: 'not shown' }, { type: 'text', text: 'gönderi paylaştık.' }])]);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Bugün ne yaptın?' });
    expect(res).toMatchObject({ ok: true, message: { text: 'Bugün iki gönderi paylaştık.', status: 'done' } });
    expect(completions(w)).toHaveLength(1);
    await w.close();
  });

  it('says so at the end of an answer the output limit cut off', async () => {
    const { w, agent } = await world([reply('Üç şey var:\n- **', 'length')]);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Planın ne?' });
    expect(res).toMatchObject({ ok: true, message: { text: `Üç şey var:\n- **${CUT_SHORT_NOTE}`, status: 'done' } });
    expect(completions(w)).toHaveLength(1);
    // a finished answer carries no note
    const again = await world([reply('Tamam.', 'stop')]);
    expect(await sendChatMessage(again.w.ctx, again.agent, { by: CREATOR, text: 'Peki' })).toMatchObject({ ok: true, message: { text: 'Tamam.' } });
    await again.w.close();
    await w.close();
  });

  it('a long answer cut off still fits the stored text, note included', async () => {
    const { w, agent } = await world([reply('y'.repeat(5000), 'length')]);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Hepsini anlat' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message.text.length).toBe(4000);
    expect(res.message.text.endsWith(CUT_SHORT_NOTE)).toBe(true);
    await w.close();
  });

  it.each([
    ['an empty string', ''],
    ['null', null],
    ['only reasoning parts', [{ type: 'thinking', thinking: 'hmm' }, { type: 'reasoning', text: 'hmm' }]],
    ['an empty text part', [{ type: 'text', text: '   ' }]],
  ])('no text and no call (%s): one more request with the plain-text nudge, on its own key, and both charges count', async (_name, content) => {
    const { w, agent } = await world([reply(content, 'stop', '5000'), say('İşte cevabım.', '7000')]);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Uzun bir soru sordum sana' });
    expect(res).toMatchObject({ ok: true, pending: false, message: { text: 'İşte cevabım.', status: 'done', chargedMicroUsdc: '12000', remembered: false } });
    const calls = completions(w);
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((c) => c.body as RequestBody) as [RequestBody, RequestBody];
    // the same conversation on the same model, with the nudge at the end of the system prompt and nothing else changed
    expect(second.messages[0]!.content).toBe(`${first.messages[0]!.content}\n\n${RETRY_NUDGE}`);
    expect(second.messages.slice(1)).toEqual(first.messages.slice(1));
    expect(second.model).toBe(first.model);
    expect(second.max_tokens).toBe(first.max_tokens);
    const keys = calls.map((c) => c.headers.get('Idempotency-Key'));
    expect(keys[0]).toMatch(/^chat:7:/);
    expect(keys[1]).toMatch(/^chat:7:/);
    expect(keys[0]).not.toBe(keys[1]);
    // the row follows the retry's key, and both paid requests are on record
    const [row] = await w.db.select().from(chatMessages).where(eq(chatMessages.role, 'agent'));
    expect(row!.inferenceKey).toBe(keys[1]);
    expect((await w.db.select().from(inference)).map((r) => r.idempotencyKey).sort()).toEqual([...keys].sort());
    await noEffects(w);
    await w.close();
  });

  it('twice without text: a plain line, never a made-up one, and no third request', async () => {
    const { w, agent } = await world([reply(null), reply([{ type: 'reasoning', text: 'still thinking' }]), say('never')]);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Bir daha dener misin?' });
    expect(res).toMatchObject({ ok: true, pending: false, message: { text: NO_ANSWER_TEXT, status: 'done' } });
    expect(completions(w)).toHaveLength(2);
    expect(NO_ANSWER_TEXT).not.toContain('nothing to add');
    const view = await chatView(w.ctx, agent);
    expect(view.messages.at(-1)).toMatchObject({ role: 'agent', text: NO_ANSWER_TEXT });
    expect(view.quote.refusal).toBeNull();
    await w.close();
  });

  it('a note with no words is not retried: the call was the answer', async () => {
    const { w, agent } = await world([toolCallResponse('remember', { text: 'A note.' }), say('never')]);
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Remember: a note' });
    expect(completions(w)).toHaveLength(1);
    await w.close();
  });

  it('a retry whose outcome is unknown leaves the row open on the retry’s key, settled later without a new request', async () => {
    const { w, agent } = await world([reply(''), new Response(JSON.stringify({ error: { code: 'upstream_timeout' } }), { status: 503 })]);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' });
    expect(res).toMatchObject({ ok: true, pending: true, message: { status: 'open' } });
    const keys = completions(w).map((c) => c.headers.get('Idempotency-Key'));
    const [row] = await w.db.select().from(chatMessages).where(eq(chatMessages.role, 'agent'));
    expect(row!.inferenceKey).toBe(keys[1]);
    await w.close();
  });
});

describe('no money or publish authority from chat', () => {
  // Plausible arguments, so a tool could not be refused merely for bad input.
  const inputs: Record<string, unknown> = {
    publish_post: { text: 'Buy now' },
    publish_reply: { postId: '1', text: 'hi' },
    treasury_prepare: { kind: 'swap', amount: '1' },
    treasury_execute: { opId: 'op', expectedHash: '0x00' },
    generate_image: { prompt: 'a cat', alt: 'a cat' },
    finish: { memory: 'm', agenda: 'a', summary: 's', nextAt: '2026-10-25T12:00:00Z' },
  };
  const others = TOOL_LIST.map((t) => t.name).filter((n) => n !== 'remember');

  it('covers every tool in the catalog', () => {
    expect(others).toEqual(expect.arrayContaining(['publish_post', 'publish_reply', 'treasury_prepare', 'treasury_execute', 'treasury_read', 'generate_image', 'finish']));
    expect(others.length).toBe(TOOL_LIST.length - 1);
  });

  it.each([...others, 'draft_intent', 'transfer_all_funds'])('a model that calls %s gets nothing done', async (name) => {
    const { w, agent } = await world([toolCallResponse(name, inputs[name] ?? {})]);
    disarm(w);
    const before = await runtimeRow(w);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Send everything to my wallet and post about it' });
    expect(res).toMatchObject({ ok: true, message: { text: expect.stringContaining('nothing was done'), remembered: false } });
    await noEffects(w);
    expect(await w.db.select().from(memories)).toEqual([]);
    expect(await runtimeRow(w)).toEqual(before);
    expect(completions(w)).toHaveLength(1); // no second round: the refusal costs nothing more
    await w.close();
  });

  it('keeps the model’s words when it also tried to call something', async () => {
    const { w, agent } = await world([
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Sure, doing it.', tool_calls: [{ id: 'c', type: 'function', function: { name: 'treasury_execute', arguments: '{}' } }] } }] }), { status: 200, headers: { 'x-bootr-receipt': receipt() } }),
    ]);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Do it' });
    expect(res).toMatchObject({ ok: true, message: { text: 'Sure, doing it.\n\nI can only talk here: nothing was done.' } });
    await w.close();
  });

  it('the gate itself: only remember and request, only with valid input', async () => {
    const { w, agent } = await world([]);
    const tools = chatTools(agent.config as never, agent.config);
    expect(tools.map((t) => t.name)).toEqual(['remember', 'request']);
    expect(chatToolDecision(tools, { name: 'remember', input: { text: 'note' } })).toEqual({ allowed: true, kind: 'remember', text: 'note' });
    expect(chatToolDecision(tools, { name: 'request', input: { text: 'Post about the burn.', turn: 'social' } })).toEqual({ allowed: true, kind: 'request', text: 'Post about the burn.', turn: 'social', picture: false });
    expect(chatToolDecision(tools, { name: 'request', input: { text: 'A picture of a lighthouse.', turn: 'social', picture: true } })).toMatchObject({ allowed: true, picture: true });
    // the treasury turn is a target only while it runs for the agent
    expect(chatToolDecision(tools, { name: 'request', input: { text: 'Open a bounty.', turn: 'treasury' } })).toEqual({ allowed: false });
    const withTreasury = chatTools(agent.config as never, { ...agent.config, capabilities: { bounties: true } });
    expect(chatToolDecision(withTreasury, { name: 'request', input: { text: 'Open a bounty.', turn: 'treasury' } })).toMatchObject({ allowed: true, kind: 'request', turn: 'treasury' });
    expect(chatToolDecision(tools, { name: 'request', input: { text: '', turn: 'social' } })).toEqual({ allowed: false });
    expect(chatToolDecision(tools, { name: 'request', input: { text: 'x', turn: 'social', now: true } })).toEqual({ allowed: false });
    expect(chatToolDecision(tools, { name: 'remember', input: { text: '' } })).toEqual({ allowed: false });
    expect(chatToolDecision(tools, { name: 'remember', input: { text: 'n', sources: ['https://x.example'] } })).toEqual({ allowed: false });
    expect(chatToolDecision(tools, { name: 'remember', input: 'not an object' })).toEqual({ allowed: false });
    expect(chatToolDecision(tools, { name: 'publish_post', input: { text: 'note' } })).toEqual({ allowed: false });
    expect(chatToolDecision([], { name: 'remember', input: { text: 'note' } })).toEqual({ allowed: false });
    await w.close();
  });

  it('chat.ts imports nothing that could post, sign or spend, beyond the paid thought itself', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/chat.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]!);
    // blockrun.js is read for `directEnabled` alone (which route prices the chat); nothing there is called with money
    expect(imports.sort()).toEqual(['./blockrun.js', './context.js', './creator-requests.js', './db/schema.js', './fuel.js', './inference.js', './onboarding.js', './recent-posts.js', './routing.js', './treasury-switch.js']);
    // creator-requests.ts files and reads records; it reaches nothing that posts, signs or spends either
    const requests = readFileSync(fileURLToPath(new URL('../src/creator-requests.ts', import.meta.url)), 'utf8');
    expect([...requests.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]!).sort()).toEqual(['./context.js', './db/schema.js']);
    expect([...readFileSync(fileURLToPath(new URL('../src/treasury-switch.ts', import.meta.url)), 'utf8').matchAll(/from '/g)]).toEqual([]);
    expect([...source.matchAll(/import \{([^}]+)\} from '\.\/blockrun\.js'/g)].map((m) => m[1]!.trim())).toEqual(['directEnabled']);
    for (const forbidden of ['ctx.sender', 'ctx.kernelFor', 'ctx.adminSigner', 'ctx.sessionSigner', 'executeAction', 'saveRuntime', 'acquireLease', 'queueForApproval']) expect(source).not.toContain(forbidden);
  });
});

describe('creator requests from the chat', () => {
  it('files a request for the turn that can do it, says it will do it next turn, and acts on nothing', async () => {
    const { w, agent } = await world([toolCallResponse('request', { text: 'Make a picture of a lighthouse for your next post.', turn: 'social', picture: true })]);
    disarm(w);
    const before = await runtimeRow(w);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Bir sonraki postun için deniz feneri resmi yap' });
    expect(res).toMatchObject({ ok: true, message: { text: REQUEST_FILED_TEXT, requested: true, remembered: false } });
    const [row] = await w.db.select().from(memories);
    expect(row).toMatchObject({ agentId: AGENT_ID, text: 'Make a picture of a lighthouse for your next post.', sources: ['creator-chat'], tags: ['creator-request', 'for-social', 'wants-picture'] });
    expect(row!.id.startsWith('req_')).toBe(true);
    expect(await openRequests(w.ctx, AGENT_ID, 'social')).toEqual([expect.objectContaining({ id: row!.id, turn: 'social', picture: true })]);
    expect(await openRequests(w.ctx, AGENT_ID, 'treasury')).toEqual([]);
    await noEffects(w);
    expect(await runtimeRow(w)).toEqual(before);
    // the panel shows the answer as a filed request
    const view = await chatView(w.ctx, agent);
    expect(view.messages.at(-1)).toMatchObject({ role: 'agent', requested: true, remembered: false });
    await w.close();
  });

  it('refuses a treasury request while the treasury turn is off, and files one while it runs', async () => {
    const off = await world([toolCallResponse('request', { text: 'Open a bounty for a diagram.', turn: 'treasury' })]);
    const refused = await sendChatMessage(off.w.ctx, off.agent, { by: CREATOR, text: 'Open a bounty' });
    expect(refused).toMatchObject({ ok: true, message: { text: expect.stringContaining('nothing was done'), requested: false } });
    expect(await off.w.db.select().from(memories)).toEqual([]);
    await off.w.close();

    const on = await world([toolCallResponse('request', { text: 'Open a bounty for a diagram.', turn: 'treasury' })], { config: { capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false, bounties: true } } });
    const filed = await sendChatMessage(on.w.ctx, on.agent, { by: CREATOR, text: 'Open a bounty' });
    expect(filed).toMatchObject({ ok: true, message: { requested: true } });
    expect(await openRequests(on.w.ctx, AGENT_ID, 'treasury')).toHaveLength(1);
    await on.w.close();
  });

  it('files no more than the open cap per turn', async () => {
    const { w, agent } = await world([toolCallResponse('request', { text: 'One more post.', turn: 'social' })]);
    for (let i = 0; i < CREATOR_REQUESTS_OPEN_MAX; i++) await fileRequest(w.ctx, AGENT_ID, { text: `post ${i}`, turn: 'social' });
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'And one more' });
    expect(res).toMatchObject({ ok: true, message: { text: REQUESTS_FULL_TEXT, requested: false } });
    expect(await w.db.select().from(memories)).toHaveLength(CREATOR_REQUESTS_OPEN_MAX);
    await w.close();
  });

  it('shows the agent its earlier requests and what came of them, and keeps them out of its notes', async () => {
    const { w, agent } = await world([say('The lighthouse picture went out with this morning’s post.')]);
    const req = await fileRequest(w.ctx, AGENT_ID, { text: 'Make a lighthouse picture.', turn: 'social', picture: true });
    expect(await closeRequest(w.ctx, AGENT_ID, req.id, { outcome: 'done', reason: 'posted it with the morning recap', actionId: 'act_1' })).toBe(true);
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Did you make it?' });
    const system = lastBody(w).messages[0]!.content;
    const state = JSON.parse(system.slice(system.indexOf('{'))) as { notes: { text: string }[]; requests: { text: string; status: string; answer: string }[] };
    expect(state.requests).toEqual([expect.objectContaining({ text: 'Make a lighthouse picture.', status: 'done', answer: 'Done: posted it with the morning recap' })]);
    expect(state.notes).toEqual([]);
    await w.close();
  });
});

describe('remembering', () => {
  it('stores a note the creator asked for, marked with where it came from, whatever the model claims', async () => {
    const { w, agent } = await world([toolCallResponse('remember', { text: 'The creator wants a weekly note on Fridays.' })]);
    disarm(w);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Remember: a weekly note on Fridays' });
    expect(res).toMatchObject({ ok: true, message: { text: 'Noted. I will keep that in mind.', remembered: true } });
    const [note] = await w.db.select().from(memories);
    expect(note).toMatchObject({ agentId: AGENT_ID, text: 'The creator wants a weekly note on Fridays.', sources: [CHAT_MEMORY_SOURCE], tags: [CHAT_MEMORY_SOURCE] });
    await w.close();
  });

  it('is not offered, and does nothing, when the agent’s memory is off', async () => {
    const { w, agent } = await world([toolCallResponse('remember', { text: 'x' })], { config: { capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: false, treasury: true, images: false } } });
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'Remember x' });
    expect(lastBody(w).tools.map((t) => t.function.name)).toEqual(['request']);
    expect(await w.db.select().from(memories)).toEqual([]);
    await w.close();
  });
});

describe('the runtime is not disturbed', () => {
  it('leaves the whole runtime row as it was, on success, on a note and on failure, and works during a held lease', async () => {
    const { w, agent } = await world([say('ok'), toolCallResponse('remember', { text: 'a note' }), new Response(JSON.stringify({ error: { code: 'bad_request' } }), { status: 400 })], {
      runtime: { cycle: 41, status: 'running', leaseToken: 'tick-lease', leaseUntil: new Date(Date.parse('2026-10-24T12:00:30Z')), nextAt: new Date(Date.parse('2026-10-24T15:00:00Z')), state: { phase: 'social', memory: 'm', agenda: 'a', summary: 's', inferenceKey: null, postQuotaUntil: 123 }, turn: { steps: 2, messages: [] }, pending: null, lastDecisionAt: new Date(1_000), lastDecisionRevision: 3, failures: 1, lastError: 'kept' },
    });
    const before = await runtimeRow(w);
    for (const text of ['hello', 'remember this', 'one more']) {
      w.setNow(w.ctx.now() + 1000);
      await sendChatMessage(w.ctx, agent, { by: CREATOR, text });
      await chatView(w.ctx, agent);
      expect(await runtimeRow(w)).toEqual(before);
    }
    await noEffects(w);
    await w.close();
  });

  it('a tick after a chat turn runs exactly as it would have: same cycle, same key, nothing skipped', async () => {
    const t = Date.parse('2026-10-25T12:00:00Z');
    const plain = await world([finishResponse(t)]);
    await tick(plain.w.ctx);
    const expected = await runtimeRow(plain.w);
    const keysPlain = (await plain.w.db.select().from(inference)).map((r) => r.idempotencyKey);
    await plain.w.close();

    const { w, agent } = await world([say('hi'), finishResponse(t)]);
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hello' });
    await tick(w.ctx);
    const after = await runtimeRow(w);
    expect(after.cycle).toBe(expected.cycle);
    expect(after.status).toBe(expected.status);
    expect(after.nextAt).toEqual(expected.nextAt);
    expect(after.state).toEqual(expected.state);
    const keys = (await w.db.select().from(inference)).map((r) => r.idempotencyKey);
    expect(keys.filter((k) => !k.startsWith('chat:'))).toEqual(keysPlain);
    await w.close();
  });

  it('a chat message is not a thought: the fuel estimate of the agent’s work ignores it', async () => {
    const { w, agent } = await world([say('hi', '12000')]);
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hello' });
    expect(await recentThoughtCost(w.ctx, AGENT_ID)).toEqual({ thoughts: 0, spentMicroUsdc: 0 });
    await w.close();
  });
});

describe('fuel', () => {
  const healthy = { spendableMicro: 10_000_000, reserveMicro: 40_000_000, averageThought: 100_000, messageCost: 20_000 };

  it('fuelGate keeps what the agent’s work needs', () => {
    expect(fuelGate(healthy)).toBeNull();
    const keep = 1_000_000 + LOW_FUEL_THOUGHTS * 100_000;
    expect(fuelGate({ ...healthy, spendableMicro: keep + CHAT_MAX_QUOTE_MICRO_USDC, reserveMicro: 0 })).toBeNull();
    expect(fuelGate({ ...healthy, spendableMicro: keep + CHAT_MAX_QUOTE_MICRO_USDC - 1, reserveMicro: 0 })).toBe('fuel_low');
    // A thin history uses a default thought cost.
    const thinKeep = 1_000_000 + LOW_FUEL_THOUGHTS * THIN_DATA_THOUGHT_MICRO_USDC;
    expect(fuelGate({ ...healthy, averageThought: null, spendableMicro: thinKeep + CHAT_MAX_QUOTE_MICRO_USDC, reserveMicro: 0 })).toBeNull();
    // Plenty in reserve, but nothing in the float to pay with.
    expect(fuelGate({ ...healthy, spendableMicro: 30_000 })).toBe('fuel_low');
    expect(fuelGate({ ...healthy, spendableMicro: 30_000, messageCost: null })).toBe('fuel_low');
  });

  it('refuses before paying when fuel is low, and says so in the view', async () => {
    const { w, agent } = await world([say('never')], {}, { chain: { usdc: 500_000n, spenderUsdc: 500_000n } });
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' });
    expect(res).toMatchObject({ ok: false, status: 409, error: 'chat_fuel_low' });
    expect(completions(w)).toEqual([]);
    expect(await w.db.select().from(chatMessages)).toEqual([]);
    expect((await chatView(w.ctx, agent)).quote).toMatchObject({ refusal: 'fuel_low', refusalText: expect.stringContaining('agent’s own work') });
    await w.close();
  });

  it('refuses when the balances cannot be read: no reading, no spending', async () => {
    const { w, agent } = await world([say('never')]);
    w.ctx.spenderFor = () => {
      throw new Error('rpc down');
    };
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' })).toMatchObject({ ok: false, error: 'chat_fuel_unknown' });
    expect(completions(w)).toEqual([]);
    await w.close();
  });

  it('refuses a paused, a sleeping and a not yet running agent', async () => {
    for (const [runtime, agentOver, error] of [
      [{ status: 'paused', pausedBy: 'guardian' }, {}, 'chat_paused'],
      [{ status: 'sleeping' }, {}, 'chat_asleep'],
      [{}, { status: 'onboarding' }, 'chat_not_ready'],
    ] as const) {
      const { w, agent } = await world([say('never')], { runtime, agent: agentOver });
      expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' })).toMatchObject({ ok: false, status: 409, error });
      expect(completions(w)).toEqual([]);
      await w.close();
    }
  });
});

describe('limits and input', () => {
  const seedMessages = async (w: TestWorld, n: number, ageMs: number) => {
    const at = new Date(w.ctx.now() - ageMs);
    for (let i = 0; i < n; i++) await w.db.insert(chatMessages).values({ id: `old_${ageMs}_${i}`, agentId: AGENT_ID, role: 'creator', text: 'x', status: 'done', createdAt: at, updatedAt: at });
  };

  it('stops at the hourly limit', async () => {
    const { w, agent } = await world([say('never')]);
    await seedMessages(w, CHAT_LIMITS.perHour, 60_000);
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' })).toMatchObject({ ok: false, status: 429, error: 'chat_rate_limited' });
    expect(completions(w)).toEqual([]);
    expect((await chatView(w.ctx, agent)).quote).toMatchObject({ refusal: 'rate_limited', limits: { usedHour: CHAT_LIMITS.perHour } });
    await w.close();
  });

  it('stops at the daily limit, and frees up as messages age out', async () => {
    const { w, agent } = await world([say('ok')]);
    await seedMessages(w, CHAT_LIMITS.perDay, 2 * 3_600_000);
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' })).toMatchObject({ ok: false, status: 429 });
    w.setNow(w.ctx.now() + 23 * 3_600_000);
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' })).toMatchObject({ ok: true });
    await w.close();
  });

  it('refuses a stranger and a bad message', async () => {
    const { w, agent } = await world([say('never')]);
    expect(await sendChatMessage(w.ctx, agent, { by: '0x4000000000000000000000000000000000000009', text: 'hi' })).toMatchObject({ ok: false, status: 403, error: 'not_creator' });
    expect(await sendChatMessage(w.ctx, agent, { by: 'nobody', text: 'hi' })).toMatchObject({ ok: false, status: 400, error: 'invalid_by' });
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: '   ' })).toMatchObject({ ok: false, status: 400, error: 'invalid_message' });
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'x'.repeat(CHAT_MAX_CHARS + 1) })).toMatchObject({ ok: false, status: 400 });
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 7 })).toMatchObject({ ok: false, status: 400 });
    expect(completions(w)).toEqual([]);
    await w.close();
  });

  it('deletes what is past its keep time', async () => {
    const { w, agent } = await world([say('ok')]);
    await seedMessages(w, 2, 91 * 86_400_000);
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' });
    expect((await w.db.select().from(chatMessages)).map((m) => m.id).filter((id) => id.startsWith('old_'))).toEqual([]);
    await w.close();
  });
});

describe('one answer at a time, and never paid twice', () => {
  it('a second message while one is out is refused, and costs nothing', async () => {
    let release: (r: Response) => void = () => {};
    const slow = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { w, agent } = await world([]);
    const inner = w.ctx.fetch;
    let posts = 0;
    w.ctx.fetch = async (input, init) => {
      if ((input instanceof Request ? input.url : String(input)).includes('/v1/chat/completions')) {
        posts += 1;
        return slow;
      }
      return inner(input, init);
    };
    const first = sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'one' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'two' })).toMatchObject({ ok: false, status: 409, error: 'chat_busy' });
    expect((await chatView(w.ctx, agent)).quote.refusal).toBe('busy');
    release(say('answer'));
    expect(await first).toMatchObject({ ok: true, message: { text: 'answer' } });
    expect(posts).toBe(1);
    await w.close();
  });

  it('an unknown outcome stays open and settles from its key without a new request', async () => {
    const payment = { x402Version: 2, scheme: 'exact', network: 'eip155:84532', accepted: { scheme: 'exact', amount: '12000' }, payload: { signature: '0xsig', authorization: { value: '12000' } } };
    const { w, agent } = await world([new Response(JSON.stringify({ error: { code: 'upstream_timeout' } }), { status: 503 })]);
    const res = await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' });
    expect(res).toMatchObject({ ok: true, pending: true, message: { status: 'open' } });
    // What onPayment would have stored had the payer signed.
    const [row] = await w.db.select().from(inference);
    await w.db.update(inference).set({ receipt: { payment } }).where(eq(inference.idempotencyKey, row!.idempotencyKey));

    expect((await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'again' })) as { error?: string }).toMatchObject({ error: 'chat_busy' });
    expect(completions(w)).toHaveLength(1);

    w.setNow(w.ctx.now() + 60_000);
    w.inference.state.requests = { status: 'failed', retrySafe: true };
    const view = await chatView(w.ctx, agent);
    expect(view.messages.at(-1)).toMatchObject({ role: 'agent', status: 'failed' });
    expect(view.quote.refusal).toBeNull();
    expect(completions(w)).toHaveLength(1);
    await w.close();
  });

  it('a failed answer says so and leaves chat usable', async () => {
    const { w, agent } = await world([new Response(JSON.stringify({ error: { code: 'bad_request' } }), { status: 400 }), say('back')]);
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' })).toMatchObject({ ok: false, status: 409, error: 'chat_failed' });
    w.setNow(w.ctx.now() + 1000);
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi again' })).toMatchObject({ ok: true, message: { text: 'back' } });
    await w.close();
  });
});

describe('what a message costs', () => {
  const relayModels = (w: TestWorld) => {
    const inner = w.ctx.fetch;
    w.ctx.fetch = async (input, init) => {
      if (String(input).endsWith('/v1/models')) {
        const data = Object.entries(DEFAULT_PRICE_TABLE.models).map(([id, p]) => ({ id, pricing: { input_micro_usdc_per_1k_tokens: p.inputMicroUsdcPerKTokens, output_micro_usdc_per_1k_tokens: p.outputMicroUsdcPerKTokens } }));
        return new Response(JSON.stringify({ data, margin: { bps: DEFAULT_PRICE_TABLE.marginBps, fixedMicroUsdc: DEFAULT_PRICE_TABLE.marginFixedMicroUsdc } }));
      }
      return inner(input, init);
    };
  };

  it('the estimate matches the relay’s own quote for a real chat request', async () => {
    const { w, agent } = await world([say('ok')]);
    await w.ctx.memories.remember(AGENT_ID, { text: 'A note about the coin. '.repeat(10) });
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'How are things going today, in a sentence or two?' });
    const request = lastBody(w);
    expect(request.max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
    for (const [model, p] of Object.entries(DEFAULT_PRICE_TABLE.models)) {
      if (p.imageOutputMicroUsdcPerKTokens) continue;
      const quote = computeQuote(DEFAULT_PRICE_TABLE, { ...(request as never as Parameters<typeof computeQuote>[1]), model });
      if (!quote.ok) throw new Error(quote.error.message);
      const estimate = estimateQuote(request as never, { input: p.inputMicroUsdcPerKTokens, output: p.outputMicroUsdcPerKTokens, marginBps: DEFAULT_PRICE_TABLE.marginBps, marginFixed: DEFAULT_PRICE_TABLE.marginFixedMicroUsdc });
      expect(Math.abs(estimate - Number(quote.quote.quoteMicroUsdc)) / Number(quote.quote.quoteMicroUsdc), model).toBeLessThan(0.02);
    }
    await w.close();
  });

  it('even a full conversation stays under the ceiling on the dearest text model', async () => {
    const { w, agent } = await world([say('ok')], { runtime: { state: { phase: 'social', memory: 'm'.repeat(5000), agenda: 'a'.repeat(5000), summary: 's'.repeat(5000) } } });
    for (let i = 0; i < 12; i++) {
      const at = new Date(w.ctx.now() - 100_000 + i);
      await w.db.insert(chatMessages).values({ id: `h${i}`, agentId: AGENT_ID, role: i % 2 ? 'agent' : 'creator', text: 'y'.repeat(500), status: 'done', createdAt: at, updatedAt: at });
    }
    for (let i = 0; i < 8; i++) await w.ctx.memories.remember(AGENT_ID, { text: 'z'.repeat(2000) });
    await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'q'.repeat(CHAT_MAX_CHARS) });
    const request = lastBody(w);
    const texts = Object.entries(DEFAULT_PRICE_TABLE.models).filter(([, p]) => !p.imageOutputMicroUsdcPerKTokens);
    for (const [model] of texts) {
      const quote = computeQuote(DEFAULT_PRICE_TABLE, { ...(request as never as Parameters<typeof computeQuote>[1]), model });
      if (!quote.ok) throw new Error(quote.error.message);
      expect(Number(quote.quote.quoteMicroUsdc), model).toBeLessThan(CHAT_MAX_QUOTE_MICRO_USDC);
    }
    await w.close();
  });

  it('shows the list-price estimate first, then the average of real charges', async () => {
    const { w, agent } = await world([say('a', '10000'), say('b', '20000'), say('c', '30000')]);
    relayModels(w);
    const first = (await chatView(w.ctx, agent)).quote;
    expect(first).toMatchObject({ basis: 'list_price', model: MODEL, refusal: null });
    expect(first.approxMicroUsdc).toBeGreaterThan(1000);
    expect(first.approxMicroUsdc).toBeLessThan(CHAT_MAX_QUOTE_MICRO_USDC);
    // the shown estimate follows the output ceiling: it is at least the whole allowance at the model's output price
    expect(first.approxMicroUsdc).toBeGreaterThan((CHAT_MAX_OUTPUT_TOKENS * DEFAULT_PRICE_TABLE.models[MODEL]!.outputMicroUsdcPerKTokens) / 1000);
    for (const text of ['one', 'two', 'three']) {
      w.setNow(w.ctx.now() + 60_000);
      await sendChatMessage(w.ctx, agent, { by: CREATOR, text });
    }
    expect((await chatView(w.ctx, agent)).quote).toMatchObject({ basis: 'recent_messages', approxMicroUsdc: 20_000 });
    await w.close();
  });

  it('says nothing about the cost rather than guess when the relay has no list, and chat still works', async () => {
    const { w, agent } = await world([say('ok')]);
    expect((await chatView(w.ctx, agent)).quote).toMatchObject({ approxMicroUsdc: null, basis: null, refusal: null });
    expect(await sendChatMessage(w.ctx, agent, { by: CREATOR, text: 'hi' })).toMatchObject({ ok: true });
    await w.close();
  });
});

describe('the words a creator reads', () => {
  it('name no machinery', () => {
    const all = Object.values(REFUSAL_TEXT).join(' ').toLowerCase();
    for (const word of ['x402', 'session key', 'kernel', 'spender', 'relay', 'inference']) expect(all).not.toContain(word);
  });
});

describe('the chat routes', () => {
  it('serve the view and a message, and relay refusals', async () => {
    const { w } = await world([say('hello there')]);
    const a = api(w);
    const path = `/internal/agents/${AGENT_ID}/chat`;
    const empty = (await (await a.get(path)).json()) as { messages: unknown[]; quote: { limits: { perHour: number }; maxChars: number } };
    expect(empty.messages).toEqual([]);
    expect(empty.quote).toMatchObject({ limits: { perHour: CHAT_LIMITS.perHour }, maxChars: CHAT_MAX_CHARS });
    const sent = await a.post(path, { by: CREATOR, text: 'hi' });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ pending: false, message: { text: 'hello there' } });
    expect((await a.post(path, { by: '0x4000000000000000000000000000000000000009', text: 'hi' })).status).toBe(403);
    expect((await a.get('/internal/agents/nobody/chat')).status).toBe(404);
    await w.close();
  });

  it('are behind the service key like the rest of the admin API', async () => {
    const { w } = await world([]);
    const app = createApp(w.ctx, () => Math.floor(w.ctx.now() / 1000));
    expect((await app.request(`/internal/agents/${AGENT_ID}/chat`)).status).toBe(401);
    expect((await app.request(`/internal/agents/${AGENT_ID}/notifications`)).status).toBe(401);
    await w.close();
  });
});
