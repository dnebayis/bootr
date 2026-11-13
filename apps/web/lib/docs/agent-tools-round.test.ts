import { describe, expect, it } from 'vitest';
import { skillMarkdown } from '@/lib/skill/skill-md';
import { pageToMarkdown } from './markdown';

/**
 * The docs and the skill for the agent's newer tools (docs/design/agent-tools-2.md): they describe what was built,
 * in plain words, and say nothing of what was cut or never built.
 */
const agents = pageToMarkdown('agents');
const api = pageToMarkdown('api');
const launch = pageToMarkdown('launch');
const forAgents = pageToMarkdown('for-agents');
const skill = skillMarkdown('https://bootr.fun');
const everything = [pageToMarkdown(''), agents, api, launch, forAgents, pageToMarkdown('fees'), pageToMarkdown('risks'), pageToMarkdown('terms'), skill].join('\n');

describe('the docs of the agent’s newer tools', () => {
  it('have a section for each piece that was built', () => {
    for (const heading of ['## What a turn starts with', '## Learning from its own posts', '### Threads', '### Comments on posts it read', '### Who gets a reply', '### Posts written ahead']) expect(agents, heading).toContain(heading);
    expect(api).toContain('### Prepare a buy or a sell');
    for (const name of ['`POST /api/agent/swap`', '`prepareSwap`', 'bootr prepare swap --coin', '`bootr_prepare_swap`', '`not_tradable`', '`trading_not_open`', '`no_quote`', '`not_available`']) expect(api, name).toContain(name);
    for (const tool of ['note_what_works', 'schedule_post', 'scheduled_list', 'scheduled_cancel']) expect(agents, tool).toContain(`\`${tool}\``);
  });

  it('give the limits a creator and a reader can count on', () => {
    expect(agents).toContain('up to 3 more connected under it, each of at most 280 characters');
    expect(agents).toContain('At most 2 threads in any 24 hours.');
    expect(agents).toContain('at most 3 comments in any 24 hours, 1 per author a day and 3 per author a week');
    expect(agents).toContain('between 10 minutes and 36 hours ahead');
    expect(agents).toContain('at most 6 posts wait per coin');
    expect(agents).toContain('at most 10 such replies a day');
    // who gets a reply: every verified account, and anyone who asks, inside one daily count
    expect(agents).toContain('every account with a blue or business verified badge is answered, whatever it writes');
    expect(agents).toContain('an account without a badge is answered when its message to the agent asks something');
    expect(agents).toContain('start at most 10 turns a day for a Bootr agent');
    expect(agents).toContain('at most 3 posts with a link in any 24 hours');
    expect(agents).toContain('gives its contract address as a label, never as a call to buy, in at most 3 posts or replies in any 24 hours');
    expect(skill).toContain('at most 3 posts or replies in any 24 hours carry the address');
    expect(agents).toContain('a table over its last 28 days');
    expect(agents).toContain('at least 8 posts');
    expect(agents).toContain('at most 600 characters');
    expect(agents).toContain('at most once every 7 days and only after 10 more posts were measured');
    expect(agents).toContain('Never a price, a forecast or a comparison with another coin.');
  });

  it('say what the facts leave out on purpose, and that the note is no rule', () => {
    expect(agents).toContain('whether a question, a mention, a cashtag or a link drew more response');
    expect(agents).toContain('Nothing in Bootr reads it as a rule, so nothing it says can lift a limit.');
  });

  it('tell the creator what X asks of an automated account, where the X account is connected', () => {
    for (const [name, page] of [
      ['launch', launch],
      ['agents', agents],
      ['for-agents', forAgents],
      ['skill', skill],
    ] as const) {
      expect(page, name).toMatch(/\*\*Automated\*\* label/);
      expect(page, name).toMatch(/run by an AI agent on Bootr and who is behind it/);
      expect(page, name).toMatch(/X(?:'|’)s rules for automated accounts ask/);
    }
    // nothing claims X approved anything, and the label is never called optional
    expect(everything).not.toMatch(/approved by X|X (?:has )?approved|X’s approval/i);
    expect(everything).not.toMatch(/Automated[^.]{0,80}\boptional\b/i);
  });

  it('promise no quote post, and say plainly that an agent cannot reply under a stranger’s post', () => {
    expect(agents).toContain('Reply under, or quote, a post whose author did not write to it.');
    expect(everything).not.toMatch(/quote[- ]post/i);
    expect(everything).not.toMatch(/\bcan quote\b|\bmay quote\b|\bquotes? (?:a|the|other) posts?\b/i);
  });

  it('name no list of accounts for a coin\u2019s agent to follow, which was taken out of the release', () => {
    expect(everything).not.toMatch(/accounts? to follow|name up to \d+ X accounts|watched accounts?|watchlist/i);
    // a comment's source is a post the agent read itself in the same turn
    expect(agents).toContain('only a post the agent read through Bootr in the same turn');
  });

  it('say nothing of what was cut from the release', () => {
    for (const cut of ['GitHub', 'github', 'workflow', '--export', 'own import', 'due --roles', 'BOOTR_AGENT_CREDENTIAL', 'own_mentions_waiting', 'own_post_due', 'own_ruling_waiting', 'client_expiring', 'cloud']) expect(everything, cut).not.toContain(cut);
    // the creator notices of that design are not built: the docs promise no reminder
    expect(agents).toContain('Bootr does not take over and does not remind.');
    expect(everything).not.toMatch(/Mentions are waiting|A post is due\.|connection is running out/);
  });

  it('gives no advice on trading where it describes preparing a swap', () => {
    const section = skill.slice(skill.indexOf('### Prepare a buy or a sell'), skill.indexOf("## What an Agent Can and Can't Do With Its Treasury"));
    expect(section.length).toBeGreaterThan(500);
    expect(section).toContain('it signs and sends nothing');
    expect(section).toContain('never to choose a trade for them');
    expect(section).toContain('get a clear yes');
    expect(section).not.toMatch(/good (?:buy|time)|profit|returns|will (?:go|rise)/i);
  });
});
