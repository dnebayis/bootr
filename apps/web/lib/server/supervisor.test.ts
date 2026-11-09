import { describe, expect, it } from 'vitest';
import { approvalDecisionBody, sanitizeActivity, sanitizeApproval, sanitizeApprovals, sanitizeBounties, sanitizeBountyJob, sanitizeChat, sanitizeChatMessage, sanitizeConfig, sanitizeFuel, sanitizeNotification, sanitizeNotifications, sanitizeXConnection, sanitizeXHold, sortBounties, txHashOf, validateChanges } from './supervisor';

const KERNEL = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';

describe('sanitizeNotifications', () => {
  const item = { id: 'ntf_1', event: 'gas_out', title: 'Out of gas', body: 'Add gas.', tone: 'danger', state: 'active', firstAt: '2026-11-05T10:00:00Z', lastSeenAt: '2026-11-05T11:00:00Z', resolvedAt: null, extra: 'dropped' };

  it('keeps known fields and drops a malformed item', () => {
    expect(sanitizeNotification(item)).toEqual({ id: 'ntf_1', event: 'gas_out', title: 'Out of gas', body: 'Add gas.', tone: 'danger', state: 'active', firstAt: '2026-11-05T10:00:00Z', lastSeenAt: '2026-11-05T11:00:00Z', resolvedAt: null });
    expect(sanitizeNotification({ ...item, title: 7 })).toBeNull();
    expect(sanitizeNotification({ ...item, tone: 'shouting' })?.tone).toBe('info');
  });

  it('counts only what is active and reads Telegram strictly', () => {
    const view = sanitizeNotifications({ items: [item, { ...item, id: 'ntf_2', state: 'resolved', resolvedAt: '2026-11-05T12:00:00Z' }, { junk: true }], events: [{ key: 'gas_out', label: 'Out of gas', enabled: false }, { nope: 1 }], telegram: { available: 'yes', linked: true, linkedAt: 'not a date' } });
    expect(view.items).toHaveLength(2);
    expect(view.active).toBe(1);
    expect(view.events).toEqual([{ key: 'gas_out', label: 'Out of gas', enabled: false }]);
    expect(view.telegram).toEqual({ available: false, linked: true, linkedAt: null });
    expect(sanitizeNotifications(null)).toEqual({ items: [], active: 0, events: [], telegram: { available: false, linked: false, linkedAt: null } });
  });
});

describe('sanitizeChat', () => {
  const message = { id: 'msg_1', role: 'agent', text: 'hello', status: 'done', chargedMicroUsdc: '18000', remembered: true, at: '2026-11-05T10:00:00Z', error: 'internal' };

  it('keeps a message, without what the panel has no use for', () => {
    expect(sanitizeChatMessage(message)).toEqual({ id: 'msg_1', role: 'agent', text: 'hello', status: 'done', chargedMicroUsdc: '18000', remembered: true, at: '2026-11-05T10:00:00Z' });
    expect(sanitizeChatMessage({ ...message, role: 'system' })).toBeNull();
    expect(sanitizeChatMessage({ ...message, chargedMicroUsdc: '1e9' })?.chargedMicroUsdc).toBeNull();
  });

  it('reads the quote, with a null cost when the supervisor cannot say', () => {
    const view = sanitizeChat({ messages: [message, { nope: 1 }], quote: { model: 'anthropic/claude-sonnet-4.6', approxMicroUsdc: null, basis: null, maxMicroUsdc: 150000, refusal: 'fuel_low', refusalText: 'Fuel is low.', limits: { perHour: 20, perDay: 60, usedHour: 1, usedDay: 2 }, maxChars: 1000 } });
    expect(view.messages).toHaveLength(1);
    expect(view.quote).toMatchObject({ approxMicroUsdc: null, basis: null, refusal: 'fuel_low', refusalText: 'Fuel is low.', limits: { usedHour: 1, usedDay: 2 } });
    expect(sanitizeChat({ quote: { approxMicroUsdc: 18000, basis: 'recent_messages' } }).quote).toMatchObject({ approxMicroUsdc: 18000, basis: 'recent_messages', maxChars: 1000 });
  });
});

describe('validateChanges', () => {
  it('keeps instructions, model and worker fields inside bounds and drops unknown keys', () => {
    const r = validateChanges({
      instructions: '  A patient onchain analyst for small Base coins.​ ',
      model: 'anthropic/claude-haiku-4.5',
      worker: { capabilities: { research: true, images: false, memory: true }, postIntervalMs: 2 * 3600_000, jobLines: ['  watch   the pool ', ''] },
      extra: 1,
    });
    expect(r).toEqual({
      ok: true,
      changes: {
        instructions: 'A patient onchain analyst for small Base coins.',
        model: 'anthropic/claude-haiku-4.5',
        worker: { capabilities: { research: true, images: false, memory: true }, postIntervalMs: 7_200_000, jobLines: ['watch the pool'] },
      },
    });
  });

  it('refuses short instructions, an out-of-range cadence, switching an always-on power off and an empty change', () => {
    expect(validateChanges({ instructions: 'too short' })).toMatchObject({ ok: false });
    expect(validateChanges({ worker: { postIntervalMs: 60_000 } })).toMatchObject({ ok: false });
    expect(validateChanges({ worker: { capabilities: { treasury: false } } })).toMatchObject({ ok: false, message: 'treasury is always on.' });
    expect(validateChanges({ model: 'not a model id!' })).toMatchObject({ ok: false });
    expect(validateChanges({})).toMatchObject({ ok: false });
    expect(validateChanges(null)).toMatchObject({ ok: false });
  });

  it('takes the post review switch as a boolean only', () => {
    expect(validateChanges({ requireApproval: true })).toEqual({ ok: true, changes: { requireApproval: true } });
    expect(validateChanges({ requireApproval: 'yes' })).toMatchObject({ ok: false });
  });

  it('takes economy mode as routing.decideModel: a model id to switch it on, null to switch it off', () => {
    expect(validateChanges({ routing: { decideModel: 'deepseek/deepseek-v3.2' } })).toEqual({ ok: true, changes: { routing: { decideModel: 'deepseek/deepseek-v3.2' } } });
    expect(validateChanges({ routing: { decideModel: null } })).toEqual({ ok: true, changes: { routing: { decideModel: null } } });
    expect(validateChanges({ routing: { decideModel: '' } })).toMatchObject({ ok: false });
    expect(validateChanges({ routing: { decideModel: 'not a model id!' } })).toMatchObject({ ok: false });
    expect(validateChanges({ routing: {} })).toMatchObject({ ok: false });
    expect(validateChanges({ routing: 'deepseek' })).toMatchObject({ ok: false });
    expect(validateChanges({ routing: null })).toMatchObject({ ok: false });
  });

  it('takes an image model id and a partial image style: an https reference or null, one line of notes', () => {
    expect(validateChanges({ imageModel: 'google/gemini-3-pro-image' })).toEqual({ ok: true, changes: { imageModel: 'google/gemini-3-pro-image' } });
    expect(validateChanges({ imageModel: 'not a model!' })).toMatchObject({ ok: false });
    expect(validateChanges({ imageStyle: { reference: 'https://cdn.bootr.fun/coins/7.png', notes: '  flat\n colours,  no text ' } })).toEqual({
      ok: true,
      changes: { imageStyle: { reference: 'https://cdn.bootr.fun/coins/7.png', notes: 'flat colours, no text' } },
    });
    expect(validateChanges({ imageStyle: { reference: null } })).toEqual({ ok: true, changes: { imageStyle: { reference: null } } });
    expect(validateChanges({ imageStyle: { notes: '' } })).toEqual({ ok: true, changes: { imageStyle: { notes: '' } } });
    expect(validateChanges({ imageStyle: { reference: 'http://cdn.bootr.fun/coins/7.png' } })).toMatchObject({ ok: false, message: expect.stringContaining('https') });
    expect(validateChanges({ imageStyle: { reference: 'ipfs://bafy' } })).toMatchObject({ ok: false });
    expect(validateChanges({ imageStyle: { notes: 'x'.repeat(201) } })).toMatchObject({ ok: false });
    expect(validateChanges({ imageStyle: {} })).toMatchObject({ ok: false, message: 'Nothing to change.' });
    expect(validateChanges({ imageStyle: 'flat' })).toMatchObject({ ok: false });
  });
});

describe('sanitizeConfig', () => {
  it('normalises a supervisor config and forces the always-on powers', () => {
    const cfg = sanitizeConfig({
      agentId: 42,
      kernel: KERNEL,
      creator: CREATOR,
      model: 'openai/gpt-4.1-mini',
      instructions: 'hello',
      worker: { kind: 'custom', capabilities: { xRead: true, memory: false }, postIntervalMs: '3600000', jobLines: ['a', 1] },
      workerHash: `0x${'ab'.repeat(32)}`,
      revision: '3',
      updatedAt: 1_700_000_000,
    });
    expect(cfg).toMatchObject({ agentId: '42', model: 'openai/gpt-4.1-mini', revision: 3, worker: { kind: 'custom', postIntervalMs: 3_600_000, jobLines: ['a'] } });
    expect(cfg!.worker.capabilities).toEqual({ xRead: true, xReply: false, xPublish: false, research: false, memory: true, treasury: true, images: false, services: false, bounties: false });
    // services caps: defaults for anything missing or out of bounds, host patterns lower-cased, junk dropped
    expect(cfg!.services).toEqual({ perCallMicroUsdc: 50_000, dailyMicroUsdc: 1_000_000, allow: [], deny: [] });
    expect(sanitizeConfig({ ...{ agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 } }, services: { perCallMicroUsdc: 20_000, dailyMicroUsdc: 9e9, allow: ['API.Example.com', '*.data.example', 'bad host', 7], deny: [] } })!.services).toEqual({ perCallMicroUsdc: 20_000, dailyMicroUsdc: 1_000_000, allow: ['api.example.com', '*.data.example'], deny: [] });
    expect(validateChanges({ services: { perCallMicroUsdc: 20_000, allow: ['API.example.com'] } })).toEqual({ ok: true, changes: { services: { perCallMicroUsdc: 20_000, allow: ['api.example.com'] } } });
    expect(validateChanges({ services: { dailyMicroUsdc: 60_000_000 } })).toMatchObject({ ok: false, field: 'services.dailyMicroUsdc' });
    expect(validateChanges({ services: { deny: ['not a host'] } })).toMatchObject({ ok: false, field: 'services.deny' });
    expect(validateChanges({ services: {} })).toMatchObject({ ok: false, message: 'Nothing to change.' });
    expect(cfg!.updatedAt).toBe('2023-11-14T22:13:20.000Z');
    expect(cfg!.requireApproval).toBe(false);
    expect(cfg!.routing).toEqual({ decideModel: null });
    expect(sanitizeConfig({ agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 }, requireApproval: true })!.requireApproval).toBe(true);
    const minimal = { agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 } };
    expect(sanitizeConfig({ ...minimal, routing: { decideModel: 'deepseek/deepseek-v3.2' } })!.routing).toEqual({ decideModel: 'deepseek/deepseek-v3.2' });
    expect(sanitizeConfig({ ...minimal, routing: { decideModel: 'bad id!' } })!.routing).toEqual({ decideModel: null });
    expect(sanitizeConfig({ ...minimal, routing: 'x' })!.routing).toEqual({ decideModel: null });
    // image model and style: absent -> '' and no reference; a non-https reference is dropped
    expect(cfg!.imageModel).toBe('');
    expect(cfg!.imageStyle).toEqual({ reference: null, notes: '' });
    const styled = sanitizeConfig({ agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 }, imageModel: 'google/gemini-3-pro-image', imageStyle: { reference: 'https://cdn.bootr.fun/coins/1.png', notes: 'flat colours' } })!;
    expect(styled.imageModel).toBe('google/gemini-3-pro-image');
    expect(styled.imageStyle).toEqual({ reference: 'https://cdn.bootr.fun/coins/1.png', notes: 'flat colours' });
    expect(sanitizeConfig({ agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 }, imageStyle: { reference: 'javascript:alert(1)', notes: 7 } })!.imageStyle).toEqual({ reference: null, notes: '' });
  });

  it('returns null without a kernel, creator or worker', () => {
    expect(sanitizeConfig({ agentId: '1', kernel: KERNEL })).toBeNull();
    expect(sanitizeConfig(null)).toBeNull();
  });

  it('keeps the X 403 hold with a readable end and at least one strike, and nothing else as a hold', () => {
    const minimal = { agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 } };
    expect(sanitizeConfig(minimal)!.xHold).toBeNull();
    expect(sanitizeConfig({ ...minimal, xHold: null })!.xHold).toBeNull();
    expect(sanitizeConfig({ ...minimal, xHold: { reason: 'forbidden', until: '2026-11-09T02:00:00.000Z', strikes: 2 } })!.xHold).toEqual({ reason: 'forbidden', until: '2026-11-09T02:00:00.000Z', strikes: 2 });
    expect(sanitizeConfig({ ...minimal, xHold: { reason: 'forbidden', until: Date.parse('2026-11-09T02:00:00Z'), strikes: '3' } })!.xHold).toEqual({ reason: 'forbidden', until: '2026-11-09T02:00:00.000Z', strikes: 3 });
    expect(sanitizeConfig({ ...minimal, xHold: { reason: 'forbidden', until: '2026-11-09T02:00:00.000Z' } })!.xHold).toMatchObject({ strikes: 1 });
    expect(sanitizeConfig({ ...minimal, xHold: { reason: 'forbidden', until: 'soon', strikes: 1 } })!.xHold).toBeNull();
    expect(sanitizeConfig({ ...minimal, xHold: { reason: 'quota', until: '2026-11-09T02:00:00.000Z', strikes: 1 } })!.xHold).toBeNull();
    expect(sanitizeConfig({ ...minimal, xHold: 'forbidden' })!.xHold).toBeNull();
    expect(sanitizeXHold({ reason: 'forbidden', until: '2026-11-09T02:00:00.000Z', strikes: 1 })).toEqual({ reason: 'forbidden', until: '2026-11-09T02:00:00.000Z', strikes: 1 });
  });

  it('keeps the X connection word (connected, revoked, none) and turns anything else into null', () => {
    const minimal = { agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 } };
    expect(sanitizeConfig(minimal)!.xConnection).toBeNull();
    for (const word of ['connected', 'revoked', 'none'] as const) expect(sanitizeConfig({ ...minimal, xConnection: word })!.xConnection).toBe(word);
    expect(sanitizeConfig({ ...minimal, xConnection: null })!.xConnection).toBeNull();
    expect(sanitizeConfig({ ...minimal, xConnection: 'lost' })!.xConnection).toBeNull();
    expect(sanitizeConfig({ ...minimal, xConnection: true })!.xConnection).toBeNull();
    expect(sanitizeXConnection('revoked')).toBe('revoked');
    expect(sanitizeXConnection({ revoked: true })).toBeNull();
  });
});

describe('sanitizeActivity', () => {
  it('keeps well-formed rows, https links and tx hashes only', () => {
    const a = sanitizeActivity({
      items: [
        { at: '2026-11-03T10:00:00.000Z', kind: 'post', summary: 'Posted', url: 'https://x.com/a/status/1' },
        { at: '2026-11-03T09:00:00.000Z', kind: 'fee_claim', summary: 'Claimed', txHash: `0x${'cd'.repeat(32)}`, url: 'javascript:alert(1)' },
        { at: 'nope', kind: 'sleep', summary: 'Sleeping' },
        { at: '2026-11-03T08:00:00.000Z', kind: 'wake' },
      ],
    });
    expect(a.items).toEqual([
      { at: '2026-11-03T10:00:00.000Z', kind: 'post', summary: 'Posted', url: 'https://x.com/a/status/1' },
      { at: '2026-11-03T09:00:00.000Z', kind: 'fee_claim', summary: 'Claimed', txHash: `0x${'cd'.repeat(32)}` },
    ]);
  });
});

describe('sanitizeFuel', () => {
  it('keeps well-formed per-model rows and defaults the window', () => {
    const f = sanitizeFuel({
      days: 7,
      since: '2026-10-28T12:00:00.000Z',
      byModel: [
        { model: 'deepseek/deepseek-v3.2', thoughts: 31, chargedMicroUsdc: '34100' },
        { model: 'anthropic/claude-haiku-4.5', thoughts: 7, chargedMicroUsdc: 65800 },
        { model: 'bad id!', thoughts: 1, chargedMicroUsdc: '1' },
        { model: 'x/y', thoughts: 1.5, chargedMicroUsdc: '1' },
        { model: 'x/y', thoughts: 1, chargedMicroUsdc: '-1' },
      ],
    });
    expect(f).toEqual({
      days: 7,
      since: '2026-10-28T12:00:00.000Z',
      byModel: [
        { model: 'deepseek/deepseek-v3.2', thoughts: 31, chargedMicroUsdc: '34100' },
        { model: 'anthropic/claude-haiku-4.5', thoughts: 7, chargedMicroUsdc: '65800' },
      ],
      paidTo: 'bootr',
      picturesPaidTo: 'bootr',
    });
    expect(sanitizeFuel(null)).toEqual({ days: 7, since: '1970-01-01T00:00:00.000Z', byModel: [], paidTo: null, picturesPaidTo: null });
  });

  it('says who the pictures are paid to: the picture rows when there are any, else the route pictures take', () => {
    const thoughts = { model: 'anthropic/claude-haiku-4.5', thoughts: 5, chargedMicroUsdc: '500', directThoughts: 5 };
    // thoughts at BlockRun, pictures through the relay (the default route): the console says both
    expect(sanitizeFuel({ byModel: [thoughts, { model: 'google/nano-banana-2', thoughts: 2, chargedMicroUsdc: '150000' }] })).toMatchObject({ paidTo: 'blockrun', picturesPaidTo: 'bootr' });
    // the picture rows win over the route, under either naming of the image model
    expect(sanitizeFuel({ byModel: [thoughts, { model: 'google/gemini-3.1-flash-image', thoughts: 2, chargedMicroUsdc: '150000', directThoughts: 2 }] }, 'relay')).toMatchObject({ paidTo: 'blockrun', picturesPaidTo: 'blockrun' });
    expect(sanitizeFuel({ byModel: [thoughts, { model: 'google/nano-banana-2', thoughts: 2, chargedMicroUsdc: '150000' }] }, 'direct')).toMatchObject({ paidTo: 'blockrun', picturesPaidTo: 'bootr' });
    // no picture yet: the route decides for an agent whose thoughts pay BlockRun
    expect(sanitizeFuel({ byModel: [thoughts] })).toMatchObject({ paidTo: 'blockrun', picturesPaidTo: 'bootr' });
    expect(sanitizeFuel({ byModel: [thoughts] }, 'direct')).toMatchObject({ paidTo: 'blockrun', picturesPaidTo: 'blockrun' });
    // an agent still on the relay pays Bootr for both; pictures alone say pictures only
    expect(sanitizeFuel({ byModel: [{ ...thoughts, directThoughts: 0 }] })).toMatchObject({ paidTo: 'bootr', picturesPaidTo: 'bootr' });
    expect(sanitizeFuel({ byModel: [{ model: 'google/nano-banana-2', thoughts: 1, chargedMicroUsdc: '75442' }] })).toMatchObject({ paidTo: null, picturesPaidTo: 'bootr' });
  });

  it('keeps when the first paid thought was and how many were charged with no answer', () => {
    const f = sanitizeFuel({ days: 7, since: '2026-10-29T00:00:00.000Z', firstAt: '2026-11-04T13:05:00.000Z', byModel: [{ model: 'x/y', thoughts: 5, chargedMicroUsdc: '500', paidFailures: 2 }, { model: 'a/b', thoughts: 5, chargedMicroUsdc: '500', paidFailures: 'many' }] });
    expect(f.firstAt).toBe('2026-11-04T13:05:00.000Z');
    expect(f.byModel).toEqual([{ model: 'x/y', thoughts: 5, chargedMicroUsdc: '500', paidFailures: 2 }, { model: 'a/b', thoughts: 5, chargedMicroUsdc: '500' }]);
    expect(f.paidTo).toBe('bootr');
    const direct = sanitizeFuel({ days: 7, since: '2026-10-29T00:00:00.000Z', byModel: [{ model: 'x/y', thoughts: 5, chargedMicroUsdc: '500', directThoughts: 5 }, { model: 'a/b', thoughts: 1, chargedMicroUsdc: '50', directThoughts: 0 }] });
    expect(direct.byModel).toEqual([{ model: 'x/y', thoughts: 5, chargedMicroUsdc: '500', directThoughts: 5 }, { model: 'a/b', thoughts: 1, chargedMicroUsdc: '50' }]);
    expect(direct.paidTo).toBe('blockrun');
    expect(sanitizeFuel({ firstAt: 'not a date' })).not.toHaveProperty('firstAt');
  });
});

describe('sanitizeApprovals', () => {
  const PNG = 'iVBORw0KGgo=';
  it('keeps well-formed items, turns image bytes into a data URL and counts the pending ones', () => {
    const a = sanitizeApprovals({
      items: [
        { id: 'act_1', agentId: '7', kind: 'post', text: 'A fox for you all.', inReplyTo: null, image: { id: 'img_1', alt: 'A fox', mime: 'image/png', data: PNG }, status: 'pending_approval', decision: null, decidedBy: null, note: null, postId: null, url: null, createdAt: '2026-11-03T10:00:00.000Z', decidedAt: null, expiresAt: '2026-11-05T10:00:00.000Z' },
        { id: 'act_2', kind: 'reply', text: 'Done.', inReplyTo: '1001', image: { alt: 'x', mime: 'text/html', data: '<b>' }, status: 'approved', decision: 'approve', decidedBy: CREATOR, note: 'ok', url: 'https://x.com/a/status/9', createdAt: '2026-11-03T09:00:00.000Z', decidedAt: '2026-11-03T09:30:00.000Z' },
        { id: 'act_3', kind: 'post', text: 'bad', status: 'wat', createdAt: '2026-11-03T08:00:00.000Z' },
        { id: 'act_4', kind: 'post', text: 'no date', status: 'rejected' },
      ],
      pending: '1',
    });
    expect(a.pending).toBe(1);
    expect(a.items.map((i) => i.id)).toEqual(['act_1', 'act_2']);
    expect(a.items[0]).toMatchObject({ kind: 'post', status: 'pending_approval', image: { alt: 'A fox', dataUrl: `data:image/png;base64,${PNG}` }, expiresAt: '2026-11-05T10:00:00.000Z' });
    expect(a.items[1]).toMatchObject({ kind: 'reply', inReplyTo: '1001', image: { alt: 'x' }, decision: 'approve', url: 'https://x.com/a/status/9', decidedAt: '2026-11-03T09:30:00.000Z' });
    expect(a.items[1]!.image!.dataUrl).toBeUndefined();
    expect(a.items[1]!.expiresAt).toBe('2026-11-05T09:00:00.000Z');
    expect(sanitizeApproval(null)).toBeNull();
    expect(sanitizeApprovals(null)).toEqual({ items: [], pending: 0 });
  });
});

describe('sanitizeBounties', () => {
  const JOB = '0x' + 'ab'.repeat(32);
  const HASH = '0x' + 'cd'.repeat(32);
  const PAYEE = '0x3333333333333333333333333333333333333333';
  const job = {
    id: JOB,
    postedAt: '2026-11-09T10:00:00.000Z',
    task: 'A picture of an owl reading a ledger.',
    criteria: ['An owl is in the picture', 'It reads a ledger or a book', 'No text on the picture'],
    deliverable: 'image',
    amountMicroUsdc: '500000',
    closesAt: '2026-11-09T16:00:00.000Z',
    status: 'paid',
    xPostUrl: 'https://x.com/ledgerowl_agent/status/1850000000000000001',
    entries: { received: 7, eligible: 5, considered: 5, ineligible: { no_address: 1, young_account: 1 } },
    verdict: { winnerEntry: 2, winnerReplyUrl: 'https://x.com/someone/status/1850000000000000002', perCriterion: { '1': ['pass', 'fail', 'pass'], '2': ['pass', 'pass', 'pass'] }, reason: 'A clear owl with a ledger and no text.', deliveryHash: HASH, judgedAt: '2026-11-09T16:05:00.000Z' },
    payment: { payee: PAYEE, amountMicroUsdc: '500000', txHash: HASH, replyUrl: 'https://x.com/ledgerowl_agent/status/1850000000000000003', paidAt: '2026-11-09T18:00:00.000Z' },
  };

  it('passes the fixture through unchanged', () => {
    expect(sanitizeBountyJob(job)).toEqual(job);
    expect(sanitizeBounties({ jobs: [job] })).toEqual({ jobs: [job] });
  });

  it('drops what the public must never see: author ids, reply texts, the addresses of other entries, unknown fields', () => {
    const leaky = {
      ...job,
      authorId: '12345',
      text: 'the reply text',
      entries: { ...job.entries, addresses: [PAYEE, CREATOR], authors: ['a', 'b'] },
      verdict: { ...job.verdict, entries: [{ authorId: '1', address: CREATOR, text: 'hi' }] },
      payment: { ...job.payment, authorId: '99' },
    };
    const out = sanitizeBountyJob(leaky)!;
    expect(out).toEqual(job);
    const flat = JSON.stringify(out);
    expect(flat).not.toContain('authorId');
    expect(flat).not.toContain('the reply text');
    expect(flat).not.toContain(CREATOR);
    expect(flat.split(PAYEE).length - 1).toBe(1);
  });

  it('refuses bad hashes and addresses, and drops a row that is not a job', () => {
    expect(sanitizeBountyJob({ ...job, id: '0x1234' })).toBeNull();
    expect(sanitizeBountyJob({ ...job, verdict: { ...job.verdict, deliveryHash: '0xnothex' } })!.verdict).toBeNull();
    expect(sanitizeBountyJob({ ...job, payment: { ...job.payment, txHash: '0x12' } })!.payment!.txHash).toBeNull();
    expect(sanitizeBountyJob({ ...job, payment: { ...job.payment, payee: 'not an address' } })!.payment).toBeNull();
    expect(sanitizeBountyJob({ ...job, status: 'won' })).toBeNull();
    expect(sanitizeBountyJob({ ...job, amountMicroUsdc: 'free' })).toBeNull();
    expect(sanitizeBountyJob({ ...job, xPostUrl: 'https://evil.example/x' })!.xPostUrl).toBeNull();
    expect(sanitizeBounties({ jobs: [job, { junk: true }, null] }).jobs).toHaveLength(1);
  });

  it('caps strings and lists, and reads unknown marks as insufficient evidence', () => {
    expect(sanitizeBountyJob({ ...job, task: 'x'.repeat(601) })).toBeNull();
    const ok = sanitizeBountyJob({ ...job, criteria: ['a', 'b', 'c', 'd', 'e'], verdict: { ...job.verdict, perCriterion: { '2': ['pass', 'maybe'], nope: ['pass'] }, reason: 'r'.repeat(201) } })!;
    expect(ok.criteria).toEqual(['a', 'b', 'c', 'd']);
    expect(ok.verdict!.perCriterion).toEqual({ '2': ['pass', 'insufficient_evidence'] });
    expect(ok.verdict!.reason).toBe('');
  });

  it('puts jobs in motion first, then newest first', () => {
    const older = { ...job, id: '0x' + '11'.repeat(32), postedAt: '2026-11-08T10:00:00.000Z', status: 'open' };
    const newest = { ...job, id: '0x' + '22'.repeat(32), postedAt: '2026-11-10T10:00:00.000Z', status: 'no_winner' };
    expect(sortBounties(sanitizeBounties({ jobs: [job, newest, older] }).jobs).map((j) => j.status)).toEqual(['open', 'no_winner', 'paid']);
  });

  it('reads a bounty payment approval, with the payment block or flat, and drops one it cannot describe', () => {
    const base = { id: 'apr_b1', kind: 'bounty_payment', status: 'pending_approval', createdAt: '2026-11-09T16:05:00.000Z', expiresAt: '2026-11-11T16:05:00.000Z', task: job.task };
    const payment = { jobId: JOB, amountMicroUsdc: '500000', payee: PAYEE, reason: 'A clear owl.', entryReplyUrl: 'https://x.com/someone/status/1850000000000000002', expiresAt: '2026-11-11T16:05:00.000Z' };
    const nested = sanitizeApproval({ ...base, bounty: payment })!;
    expect(nested.kind).toBe('bounty_payment');
    expect(nested.text).toBe(job.task);
    expect(nested.bounty).toEqual({ jobId: JOB, amountMicroUsdc: '500000', payee: PAYEE, reason: 'A clear owl.', entryReplyUrl: payment.entryReplyUrl });
    expect(sanitizeApproval({ ...base, ...payment })!.bounty).toEqual(nested.bounty);
    expect(sanitizeApproval({ ...base, bounty: { ...payment, payee: 'nope' } })).toBeNull();
    expect(sanitizeApproval({ id: 'apr_p', kind: 'post', text: 'hello', status: 'pending_approval', createdAt: base.createdAt })!.bounty).toBeNull();
  });

  it('builds the decision body with the paying transaction hash only on an approval, and refuses a bad hash', () => {
    const by = CREATOR as `0x${string}`;
    expect(approvalDecisionBody({ decision: 'approve', by })).toEqual({ decision: 'approve', by });
    expect(approvalDecisionBody({ decision: 'approve', by, txHash: ` ${HASH.toUpperCase().replace('0X', '0x')} ` })).toEqual({ decision: 'approve', by, txHash: HASH });
    expect(approvalDecisionBody({ decision: 'reject', by, note: 'not this one', txHash: HASH })).toEqual({ decision: 'reject', by, note: 'not this one' });
    expect(() => approvalDecisionBody({ decision: 'approve', by, txHash: '0x1234' })).toThrow(/64 hex/);
    expect(txHashOf(HASH)).toBe(HASH);
    expect(txHashOf('0x' + 'cd'.repeat(31))).toBeNull();
    expect(txHashOf(7)).toBeNull();
  });

  it('reads the bounties bounds with defaults and validates the creator’s changes against them', () => {
    const cfg = sanitizeConfig({ agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 } })!;
    expect(cfg.bounties).toEqual({ dailyCapMicroUsdc: 5_000_000, maxOpen: 2, cooldownSeconds: 604_800, defaultHoursOpen: 6, review: false });
    expect(sanitizeConfig({ agentId: 1, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 1 }, bounties: { dailyCapMicroUsdc: 90_000_000, maxOpen: 5, cooldownSeconds: 0, defaultHoursOpen: 100, review: true } })!.bounties).toEqual({ dailyCapMicroUsdc: 5_000_000, maxOpen: 5, cooldownSeconds: 0, defaultHoursOpen: 6, review: true });
    expect(validateChanges({ bounties: { dailyCapMicroUsdc: 2_000_000, maxOpen: 3, cooldownSeconds: 0, defaultHoursOpen: 12, review: true } })).toEqual({ ok: true, changes: { bounties: { dailyCapMicroUsdc: 2_000_000, maxOpen: 3, cooldownSeconds: 0, defaultHoursOpen: 12, review: true } } });
    expect(validateChanges({ bounties: { dailyCapMicroUsdc: 20_000_001 } })).toMatchObject({ ok: false, field: 'bounties.dailyCapMicroUsdc' });
    expect(validateChanges({ bounties: { maxOpen: 6 } })).toMatchObject({ ok: false, field: 'bounties.maxOpen' });
    expect(validateChanges({ bounties: { defaultHoursOpen: 0 } })).toMatchObject({ ok: false, field: 'bounties.defaultHoursOpen' });
    expect(validateChanges({ bounties: { review: 'yes' } })).toMatchObject({ ok: false, field: 'bounties.review' });
    expect(validateChanges({ bounties: {} })).toMatchObject({ ok: false, field: 'bounties' });
    expect(validateChanges({ worker: { capabilities: { bounties: true } } })).toEqual({ ok: true, changes: { worker: { capabilities: { bounties: true } } } });
  });
});
