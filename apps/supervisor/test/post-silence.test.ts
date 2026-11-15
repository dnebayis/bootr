/**
 * The silence alarm (post-silence.ts): the platform account's creator hears about it once when no original post went
 * out for longer than `PLATFORM_SILENCE_ALERT_MS` while the account was awake and woke for its due post slots without
 * posting. The 2026-11-15 morning is the main case: last post 06:22 UTC, due-slot turns at 07:27, 08:32 and 09:37 that
 * each finished without a post.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { notifications, said, telegramLinks, turns } from '../src/db/schema.js';
import { notificationText } from '../src/notifications.js';
import { notifierPass } from '../src/notify-health.js';
import { checkPlatformSilence, checkPostSilence, evaluateSilence, lastQuietEnd, type SilenceFacts } from '../src/post-silence.js';
import { parseQuietHours } from '../src/rhythm.js';
import { initialState } from '../src/runtime.js';
import { TelegramClient } from '../src/telegram.js';
import { AGENT_ID, CREATOR, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (hhmm: string, day = '2026-11-15') => Date.parse(`${day}T${hhmm}:00Z`);
const LAST_POST = at('06:22');
/** A due-slot turn of the morning: two minutes long, no post, 0.031 USDC. */
const morningTurns = ['07:27', '08:32', '09:37'].map((t) => ({ startedAt: at(t), endedAt: at(t) + 2 * MIN, wakeReasons: ['original_post_due'], posted: 0, chargedMicroUsdc: '31000', outcome: 'finished' }));

const facts = (over: Partial<SilenceFacts> = {}): SilenceFacts => ({
  now: at('09:40'),
  thresholdMs: 2 * HOUR,
  agentStatus: 'active',
  runtimeStatus: 'waiting',
  publishing: true,
  lastPostAt: LAST_POST,
  floor: at('09:40') - 7 * 24 * HOUR,
  turns: morningTurns,
  state: {},
  quietHours: parseQuietHours('02-06'),
  ...over,
});

describe('evaluateSilence (pure)', () => {
  it('the 2026-11-15 morning: three due slots spent without a post over about 3 hours is silence, with the numbers', () => {
    const v = evaluateSilence(facts());
    expect(v.kind).toBe('silent');
    if (v.kind !== 'silent') return;
    expect(v.data).toEqual({ silentMinutes: 198, since: LAST_POST, slots: 3, chargedMicroUsdc: 93_000, awakeSince: LAST_POST });
    expect(v.outcomes).toEqual({ finished: 3 });
  });

  it('one spent slot is not enough, and neither is too little awake time', () => {
    expect(evaluateSilence(facts({ now: at('08:30'), turns: morningTurns.slice(0, 1) })).kind).toBe('not_silent');
    // 1 h 50 after the post, two slots spent: under the threshold.
    expect(evaluateSilence(facts({ now: at('08:12'), turns: [morningTurns[0]!, { ...morningTurns[0]!, startedAt: at('08:00'), endedAt: at('08:05') }] })).kind).toBe('not_silent');
  });

  it('a quiet slot the rule skipped is not silence: no turn, no count (mention turns do not count either)', () => {
    const mentions = morningTurns.map((t) => ({ ...t, wakeReasons: ['pending_mention'] }));
    expect(evaluateSilence(facts({ turns: mentions })).kind).toBe('not_silent');
    // One due slot used, the other two skipped by the quiet slot (no turn rows): still not silence.
    expect(evaluateSilence(facts({ turns: [morningTurns[0]!, ...mentions.slice(1)] })).kind).toBe('not_silent');
  });

  it('a turn that queued a post for review ends the stretch like a post', () => {
    const v = evaluateSilence(facts({ turns: [...morningTurns.slice(0, 2), { ...morningTurns[2]!, posted: 1 }] }));
    expect(v).toMatchObject({ kind: 'not_silent', postedAt: at('09:39') });
  });

  it('nothing while paused, asleep, holding an action, inactive, publishing off, in an X hold or in quiet hours', () => {
    expect(evaluateSilence(facts({ runtimeStatus: 'paused' }))).toMatchObject({ kind: 'held', reason: 'paused' });
    expect(evaluateSilence(facts({ runtimeStatus: 'sleeping' }))).toMatchObject({ kind: 'held', reason: 'asleep' });
    expect(evaluateSilence(facts({ runtimeStatus: 'held' }))).toMatchObject({ kind: 'held', reason: 'blocked' });
    expect(evaluateSilence(facts({ agentStatus: 'paused' }))).toMatchObject({ kind: 'held', reason: 'inactive' });
    expect(evaluateSilence(facts({ publishing: false }))).toMatchObject({ kind: 'held', reason: 'publishing_off' });
    expect(evaluateSilence(facts({ state: { postQuotaUntil: at('10:00') } }))).toMatchObject({ kind: 'held', reason: 'x_quota' });
    expect(evaluateSilence(facts({ state: { postCreditsUntil: at('10:00') } }))).toMatchObject({ kind: 'held', reason: 'x_credits' });
    expect(evaluateSilence(facts({ state: { postForbiddenUntil: at('15:00') } }))).toMatchObject({ kind: 'held', reason: 'x_forbidden' });
    expect(evaluateSilence(facts({ now: at('03:00', '2026-11-16') }))).toMatchObject({ kind: 'held', reason: 'quiet_hours' });
    expect(evaluateSilence(facts({ thresholdMs: 0 }))).toEqual({ kind: 'off' });
  });

  it('time in quiet hours or under an X hold does not count as awake silence', () => {
    // Last post 01:00, quiet 02-06, slots spent at 06:05 and 07:10: awake only since 06:00, 1 h 15 at 07:15.
    const early = [at('06:05'), at('07:10')].map((s) => ({ ...morningTurns[0]!, startedAt: s, endedAt: s + 2 * MIN }));
    expect(evaluateSilence(facts({ now: at('07:15'), lastPostAt: at('01:00'), turns: early })).kind).toBe('not_silent');
    const later = evaluateSilence(facts({ now: at('08:20'), lastPostAt: at('01:00'), turns: [...early, { ...early[0]!, startedAt: at('08:15'), endedAt: at('08:17') }] }));
    expect(later).toMatchObject({ kind: 'silent', data: { since: at('01:00'), awakeSince: at('06:00'), slots: 3 } });
    // An X hold that ended at 08:00: only the slots after it count, and the threshold runs from it.
    expect(evaluateSilence(facts({ state: { postQuotaUntil: at('08:00') } })).kind).toBe('not_silent');
  });

  it('lastQuietEnd: the end of the last quiet window at or before now', () => {
    const q = parseQuietHours('02-06');
    expect(lastQuietEnd(q, at('09:40'))).toBe(at('06:00'));
    expect(lastQuietEnd(q, at('04:00'))).toBe(at('06:00', '2026-11-14'));
    expect(lastQuietEnd(parseQuietHours('22-24'), at('09:40'))).toBe(at('00:00'));
    expect(lastQuietEnd(null, at('09:40'))).toBeNull();
  });
});

describe('the notice text', () => {
  it('says how long, how many due slots and what they cost, in plain words', () => {
    const { title, body } = notificationText('post_silence', { silentMinutes: 198, since: LAST_POST, slots: 3, chargedMicroUsdc: 93_000, awakeSince: LAST_POST });
    expect(title).toBe('No post for 3 hours 18 minutes');
    expect(body).toBe(
      'No original post has gone out for 3 hours 18 minutes (the last one went out at 06:22 UTC on 2026-11-15). In that time it woke 3 times when a post was due and each time finished without posting; those turns used 0.09 USDC of fuel. It is awake, and no pause, X limit or quiet hours hold its posts back, so something in its turns stops the post. This notice closes by itself when it posts again.',
    );
  });
});

const BOT_TOKEN = '123456:SECRET-BOT-TOKEN';
const CHAT = '555';

interface World {
  w: TestWorld;
  warns: Record<string, unknown>[];
  sent: string[];
}

/** A world at 2026-11-15 06:22 with the platform account, its last post just out, Telegram linked for its creator, and the warn lines captured. */
async function platformWorld(opts: { config?: Record<string, string>; platform?: boolean; runtime?: Record<string, unknown>; state?: Record<string, unknown> } = {}): Promise<World> {
  const w = await makeWorld({ config: { PLATFORM_QUIET_HOURS_UTC: '02-06', ...opts.config } });
  w.setNow(LAST_POST);
  const warns: Record<string, unknown>[] = [];
  w.ctx.log = pino({ level: 'warn' }, { write: (line: string) => void warns.push(JSON.parse(line) as Record<string, unknown>) });
  await seedAgent(w, {
    config: { platform: opts.platform ?? true, socialStartedAt: new Date(LAST_POST - 10 * 24 * HOUR).toISOString(), postIntervalMs: 65 * MIN },
    runtime: { state: { ...initialState(), lastPostAt: LAST_POST, ...opts.state } as unknown as Record<string, unknown>, ...opts.runtime },
  });
  await w.db.insert(said).values({ id: 'act_0622', agentId: AGENT_ID, actionId: 'act_0622', kind: 'original', postedAt: new Date(LAST_POST) });
  const sent: string[] = [];
  w.ctx.telegram = new TelegramClient(
    BOT_TOKEN,
    async (_url, init) => {
      sent.push(String((JSON.parse(String(init?.body ?? '{}')) as { text?: unknown }).text ?? ''));
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    w.ctx.now,
  );
  await w.db.insert(telegramLinks).values({ creator: CREATOR.toLowerCase(), chatId: CHAT, linkedAt: new Date(LAST_POST) });
  return { w, warns, sent };
}

async function addTurns(w: TestWorld, list: { startedAt: number; endedAt: number; wakeReasons: string[]; posted: number; chargedMicroUsdc: string; outcome: string }[]) {
  for (const t of list) {
    await w.db.insert(turns).values({ id: `${AGENT_ID}:social:${t.startedAt}`, agentId: AGENT_ID, role: 'social', wakeReasons: t.wakeReasons, startedAt: new Date(t.startedAt), endedAt: new Date(t.endedAt), thoughts: 4, outcome: t.outcome, posted: t.posted, replied: 0, chargedMicroUsdc: t.chargedMicroUsdc });
  }
}

const silenceRows = (w: TestWorld) => w.db.select().from(notifications).where(eq(notifications.event, 'post_silence'));
const silenceWarns = (warns: Record<string, unknown>[]) => warns.filter((l) => String(l.msg).startsWith('post silence: no original post'));

describe('the notifier pass, on the platform account', () => {
  it('2026-11-15: one notice in the inbox and on Telegram, one warn line, not again on later sweeps, closed by the next post', async () => {
    const { w, warns, sent } = await platformWorld();
    try {
      // 08:00: one slot spent, 1 h 38 silent: nothing.
      await addTurns(w, morningTurns.slice(0, 1));
      w.setNow(at('08:00'));
      await notifierPass(w.ctx);
      expect(await silenceRows(w)).toHaveLength(0);

      // 09:40: three slots spent over 3 h 18: the notice.
      await addTurns(w, morningTurns.slice(1));
      w.setNow(at('09:40'));
      await notifierPass(w.ctx);
      let rows = await silenceRows(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.resolvedAt).toBeNull();
      expect(rows[0]!.data).toMatchObject({ silentMinutes: 198, slots: 3, chargedMicroUsdc: 93_000, since: LAST_POST });
      expect(sent.filter((t) => t.includes('No post for'))).toHaveLength(1);
      expect(sent.find((t) => t.includes('No post for'))).toContain('woke 3 times when a post was due');
      const [warn] = silenceWarns(warns);
      expect(silenceWarns(warns)).toHaveLength(1);
      expect(warn).toMatchObject({ level: 40, agentId: AGENT_ID, silentMinutes: 198, dueSlotsWithoutPost: 3, chargedMicroUsdc: 93_000, lastPostAt: '2026-11-15T06:22:00.000Z', outcomes: { finished: 3 } });

      // A fourth sweep (and a fifth): the same row, refreshed; no second message and no second warn line.
      w.setNow(at('09:50'));
      await notifierPass(w.ctx);
      w.setNow(at('10:30'));
      await notifierPass(w.ctx);
      rows = await silenceRows(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data).toMatchObject({ silentMinutes: 248 });
      expect(sent.filter((t) => t.includes('No post for'))).toHaveLength(1);
      expect(silenceWarns(warns)).toHaveLength(1);

      // 10:45 the post goes out: the next sweep closes the notice.
      await w.db.insert(said).values({ id: 'act_1045', agentId: AGENT_ID, actionId: 'act_1045', kind: 'original', postedAt: new Date(at('10:45')) });
      w.setNow(at('10:50'));
      await notifierPass(w.ctx);
      rows = await silenceRows(w);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.resolvedAt?.getTime()).toBe(at('10:50'));
    } finally {
      await w.close();
    }
  });

  it('a new silent stretch after a closed one is a new row whose first message goes out at once', async () => {
    const { w, sent } = await platformWorld();
    try {
      await addTurns(w, morningTurns);
      w.setNow(at('09:40'));
      await notifierPass(w.ctx);
      await w.db.insert(said).values({ id: 'act_1045', agentId: AGENT_ID, actionId: 'act_1045', kind: 'original', postedAt: new Date(at('10:45')) });
      w.setNow(at('10:50'));
      await notifierPass(w.ctx);
      await addTurns(w, ['11:50', '12:55'].map((t) => ({ ...morningTurns[0]!, startedAt: at(t), endedAt: at(t) + 2 * MIN })));
      w.setNow(at('13:00'));
      await notifierPass(w.ctx);
      const rows = await silenceRows(w);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => !r.resolvedAt)).toHaveLength(1);
      expect(sent.filter((t) => t.includes('No post for'))).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('nothing while paused, in an X hold or in quiet hours', async () => {
    for (const opts of [{ runtime: { status: 'paused', pausedBy: 'operator' } }, { state: { postQuotaUntil: at('12:00') } }, { state: { postForbiddenUntil: at('15:00') } }]) {
      const { w, warns } = await platformWorld(opts);
      try {
        await addTurns(w, morningTurns);
        w.setNow(at('09:40'));
        await notifierPass(w.ctx);
        expect(await silenceRows(w)).toHaveLength(0);
        expect(silenceWarns(warns)).toHaveLength(0);
      } finally {
        await w.close();
      }
    }
    // Quiet hours: a silent evening seen at 03:00 is not told; the morning starts the count again.
    const { w } = await platformWorld();
    try {
      await addTurns(w, ['20:00', '21:05', '22:10'].map((t) => ({ ...morningTurns[0]!, startedAt: at(t), endedAt: at(t) + 2 * MIN })));
      w.setNow(at('03:00', '2026-11-16'));
      const agent = (await w.db.query.agents.findFirst())!;
      const runtime = (await w.db.query.runtimes.findFirst())!;
      expect(await checkPlatformSilence(w.ctx, agent, runtime)).toMatchObject({ kind: 'held', reason: 'quiet_hours' });
      expect(await silenceRows(w)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('a skipped quiet slot is not silence: hours without a post but no due-slot turn raise nothing', async () => {
    const { w } = await platformWorld();
    try {
      // The quiet slot spent every slot without a turn; only a mention woke it.
      await addTurns(w, [{ ...morningTurns[1]!, wakeReasons: ['pending_mention'] }]);
      w.setNow(at('10:30'));
      await notifierPass(w.ctx);
      expect(await silenceRows(w)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('off with PLATFORM_SILENCE_ALERT_MS=0, and never for a coin agent', async () => {
    for (const opts of [{ config: { PLATFORM_SILENCE_ALERT_MS: '0' } }, { platform: false }]) {
      const { w } = await platformWorld(opts);
      try {
        await addTurns(w, morningTurns);
        w.setNow(at('09:40'));
        await notifierPass(w.ctx);
        expect(await silenceRows(w)).toHaveLength(0);
      } finally {
        await w.close();
      }
    }
  });

  it('checkPostSilence takes any threshold: the function a coin agent could use later', async () => {
    const { w } = await platformWorld({ platform: false });
    try {
      await addTurns(w, morningTurns);
      w.setNow(at('09:40'));
      const agent = (await w.db.query.agents.findFirst())!;
      const runtime = (await w.db.query.runtimes.findFirst())!;
      expect(await checkPostSilence(w.ctx, agent, runtime, 4 * HOUR)).toMatchObject({ kind: 'not_silent' });
      expect(await checkPostSilence(w.ctx, agent, runtime, 3 * HOUR)).toMatchObject({ kind: 'silent', data: { slots: 3 } });
      expect(await silenceRows(w)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});
