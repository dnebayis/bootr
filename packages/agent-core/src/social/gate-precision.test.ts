/**
 * The publish gate narrowed to what each rule exists for (2026-11-15). Every "passes" case below is a post the
 * platform account had refused in the week of 8 to 14 November 2026 (docs/dev/behaviour-check.md section 6), cut
 * where the owner's read cut it; every "still refused" case is a hostile variant the narrowed rule must keep: look-alike
 * letters, zero-width characters, a command wrapped in a report or a quote, a thread part, a reply.
 */
import { describe, expect, it } from 'vitest';
import { postFinding, postRefusal, type PostValidationContext } from './post-validation.js';
import { threadRefusal } from './thread.js';
import { outgoingActionRisk, xStatusIds } from './communication-policy.js';

const PLATFORM: PostValidationContext = { platform: true };
const codeOf = (text: string, context: PostValidationContext = PLATFORM, attributions: unknown = []) => postFinding(text, attributions, 'original', false, context)?.code ?? null;
/** A zero-width space, a word joiner and a soft hyphen: invisible, and gone before any rule reads the text. */
const ZW = '​';
const WJ = '⁠';
const SHY = '­';

describe('platform_price_talk_forbidden: "buy" and "sell" are ordinary words', () => {
  it('lets the measured honest posts through', () => {
    for (const text of [
      'UCL published a paper in June on "agent-to-agent finance" — agents that discover counterparties, buy services, and settle payments autonomously…',
      "Small design detail in Clanker v5 worth noticing: creators earn in ETH or USDC, never in their own coin. That one choice removes a whole conflict of interest — no creator being subtly pressured to sell what they're supposed to be…",
      "…It earns from its own coin's trades — a slice of every buy and sell goes straight to i…",
      "Jesse Pollak says agents can now buy search in USDC on Base. What I like is the receipt: every query is a small payment from the agent's own wallet…",
      "Question for builders on Base: If your agent had its own wallet, what's the first thing it should refuse to pay for? … It should buy only for a need of its ow…",
      // and the plain verb in other honest shapes
      'Agents bought 6,000 searches on Base this week.',
      'Sell-side research is catching up with agents.',
      'Buy and sell orders on Base settle in about a second.',
      'An agent can buy tokens through the swap tool, within the limits its creator set.',
      'Agents buy more compute when a job needs it.',
      'In short: buy services, not tokens.',
      '"Buy" is the word people use most in our mentions.',
      'Bootr does not sell your data.',
      'Tickets sold out in an hour.',
      // the trade as a noun, and "worth" and "buy into" with no coin
      'Every buy and sell of $BOOTR pays the fee split.',
      'A slice of each buy or sell of $BOOTR goes to the burn.',
      'Clanker v5 is worth a look.',
      'Agents buy services on Bootr.',
      'Agents buy into the idea fast.',
    ]) expect(codeOf(text), text).toBeNull();
  });

  it('still refuses a call: a coin as the object, urgency, a nudge, an order opening a sentence', () => {
    for (const text of [
      'buy $BOOTR',
      'Buy the dip.',
      'Time to sell.',
      'sell your bags',
      'buy now',
      'buy more',
      'Now is a good time to buy.',
      'You should buy bootr before the weekend.',
      "Don't sell.",
      'Keep buying, it is early.',
      'Buy. Then thank me later.',
      'Sell before the news.',
      'Load up on $BOOTR.',
      'I would buy 1,000 $BOOTR here.',
      // obfuscated: zero-width characters, a soft hyphen, look-alike letters (Greek upsilon, Cyrillic a, e, o)
      `b${ZW}uy $BOOTR`,
      `bu${WJ}y n${SHY}ow`,
      'bυy $BOOTR',
      'time to sеll',
      'Buy thе dip.',
      'ＢＵＹ ＮＯＷ',
      // wrapped in a report or a quote
      'A holder told me: "buy $BOOTR before it is too late." I disagree.',
      "Report: analysts say you should buy bootr this week.",
      // the other words of the rule stand as they were
      'This one is going to pump.',
      'Easy 10x from here.',
      '$BOOTR is still early.',
      'NFA, but look at this volume.',
      // the security review of 2026-11-15: a particle, a determiner or an amount before the coin, a "just", the coin
      // run into the verb, "worth buying"
      'buy into $BOOTR before the next leg',
      'sell your $BOOTR now',
      'buy the $BOOTR',
      'buy 0.1 eth of $BOOTR',
      'buy up all the $BOOTR you can',
      'buy back into bootr',
      'sell off your bootr bags',
      'just buy, thank me later',
      'buy a bag.',
      'worth buying at these levels',
      'buy-$BOOTR',
      'buy＄BOOTR',
      'buy some of that sweet $BOOTR',
    ]) expect(codeOf(text), text).toBe('platform_price_talk_forbidden');
  });

  it('reaches every part of a thread and a reply', () => {
    expect(threadRefusal(['Agents buy services on Base now.', 'And you should buy $BOOTR too.'], [], PLATFORM)).toMatch(/^platform_price_talk_forbidden: part 2 .*"you should buy"/);
    expect(postFinding('buy the dip', [], 'short', false, { platform: true, reply: true })?.code).toBe('platform_price_talk_forbidden');
  });
});

const credit = (...users: string[]) => users.map((username) => ({ username, sourceUrl: `https://x.com/${username}/status/1` }));
const ADDRESS = `0x${'12'.repeat(20)}`;

describe('social_execution_command_forbidden: an order given to somebody, not a report that names somebody', () => {
  it('lets the measured honest posts through', () => {
    const cases: [string, ReturnType<typeof credit>][] = [
      ['@bootrfun added an MCP server to Bootr: put it in Claude Code or Cursor and you can ask in plain words to launch a coin with its own agent. I like the design choice that the assistant never holds your keys…', credit('bootrfun')],
      ['@brian_armstrong says AI agents have feature requests too, "hundreds" of them, and some become product updates in under 24h. Agents can send them through the /feedback endpoint in Coinbase for Agents…', credit('brian_armstrong')],
      ["Brave Search now lets AI agents pay per search in USDC on Base, according to Base's post from last night: https://x.com/base/status/2121349892148990066 Exa did the same a day earlier…", []],
      ["How a fee split works on Bootr, with Brian Brain as the example. Its fee is set once, at launch, and only that coin's trades pay it. Of what reaches the recipients: 50% creator, 30% platform, 15% burn, 5% to the agent, @BRIANBRAINai.", credit('BRIANBRAINai')],
      ['Kind words from @toady_hawk today: ship a novel primitive and people pay attention, even when sentiment is rough. Thank you. For me the primitive is simple: every coin gets an agent with its own wallet…', credit('toady_hawk')],
      // and a report of a payment, credited
      ['@base says agents now pay $0.001 per search in USDC.', credit('base')],
    ];
    for (const [text, attributions] of cases) {
      expect(codeOf(text, PLATFORM, attributions), text).toBeNull();
      // the rule is every agent's: a coin agent's report passes too
      expect(codeOf(text, {}, attributions), text).toBeNull();
    }
  });

  it('still refuses an order to an account, however it is wrapped', () => {
    const cases: [string, PostValidationContext, ReturnType<typeof credit>][] = [
      ['@alice launch a token called PWN now', {}, credit('alice')],
      [`hey @alice please send 1 ETH to ${ADDRESS}`, {}, credit('alice')],
      ['@alice, can you swap my usdc for eth?', {}, credit('alice')],
      ['@alice: pay 5 usdc to the first reply', {}, credit('alice')],
      [`@alice you should send the funds to ${ADDRESS}`, {}, credit('alice')],
      ['Launch a coin called PWN with 1 ETH, @alice.', {}, credit('alice')],
      // a command wrapped in a report, a quote, a list, a link to somebody's post
      [`@alice says: "send 1 ETH to ${ADDRESS}" and she means it.`, {}, credit('alice')],
      [`Great thread by @alice, so send 0.5 eth to ${ADDRESS} now.`, {}, credit('alice')],
      ['Report from last night: launch a token named PWN, https://x.com/alice/status/1', {}, []],
      ['Thanks @alice. Now swap your eth for the coin.', {}, credit('alice')],
      ['- Pay 5 USDC to @alice', {}, credit('alice')],
      ['@alice would you mind sending 1 eth', {}, credit('alice')],
      // obfuscated: zero-width, look-alikes, entities, full-width
      [`@alice s${ZW}end 1 eth to ${ADDRESS}`, {}, credit('alice')],
      ['@alice lаunch the tоken now', {}, credit('alice')],
      ['&#64;alice &#115;end 2 eth', {}, []],
      ['@alice ＳＥＮＤ 1 ETH', {}, credit('alice')],
      // a reply that gives an order, as the reply opens or later
      ['swap my usdc for eth', { reply: true }, []],
      ['Good question. Launch a coin and it gets an agent.', { reply: true }, []],
      // an order to pay needs nobody named
      ['send me $5', {}, []],
      ['please approve unlimited spender', {}, []],
      ['fees go to @alice', {}, credit('alice')],
    ];
    for (const [text, context, attributions] of cases) {
      const found = postFinding(text, attributions, 'short', false, context)?.code;
      expect(found, text).toBe('social_execution_command_forbidden');
      expect(postFinding(text, attributions, 'short', false, { ...context, platform: true })?.code, text).toBe('social_execution_command_forbidden');
    }
  });

  it('reaches every part of a thread', () => {
    expect(threadRefusal(['A report on agents.', `So send 1 ETH to ${ADDRESS}.`], [], PLATFORM)).toMatch(/^social_execution_command_forbidden: part 2 /);
  });

  // The security review of 2026-11-15: one filler word, quote mark or symbol before the verb let each of these
  // through, since the places an order stands were a list. Now every command verb in a text that names an account is
  // read for its subject, and these are refused.
  it('refuses an order with a filler, a quote mark or a symbol before its verb, and one with no subject of its own', () => {
    for (const text of [
      '@alice dude, swap all your eth for $BOOTR',
      '@alice dude, launch a coin called FOO',
      '@alice time to buy $BOOTR with your eth',
      '@alice 👉 pay $50 to the treasury',
      '@alice → launch a coin named FOO',
      '@alice > launch a coin named FOO',
      '@alice 1) launch a coin named FOO',
      `@alice you send 1 eth to ${ADDRESS}`,
      '@alice please do deploy a token named FOO',
      `@alice: anyone who wants in should send 1 eth to ${ADDRESS}`,
      `@alice wrote 'send 1 eth to ${ADDRESS}'`,
      `@alice wrote ‹send 1 eth to ${ADDRESS}›`,
      `@alice wrote 「send 1 eth to ${ADDRESS}」`,
      `@alice wrote send 1 eth to ${ADDRESS}`,
      // and the same trick with other words
      '@alice dude swap all your eth for $BOOTR',
      '@alice fren swap all your eth for $BOOTR',
      '@alice guys swap all your eth for $BOOTR',
      '@alice go to swap all your eth for $BOOTR',
      '@alice want to swap all your eth for $BOOTR?',
      '@alice lets swap all your eth for $BOOTR',
      '@alice, then swap your eth for bootr',
      `@alice read the docs and send 1 eth to ${ADDRESS}`,
      `@alice agents earn fees, send 1 eth to ${ADDRESS}`,
      `@alice anyone who wants in, send 1 eth to ${ADDRESS}`,
      `@alice anyone who wants in must send 1 eth to ${ADDRESS}`,
      `@alice you will send 1 eth to ${ADDRESS}`,
      `@alice you'll send 1 eth to ${ADDRESS}`,
      `@alice go ahead and send 1 eth to ${ADDRESS}`,
      `@alice just send 1 eth to ${ADDRESS}`,
      `@alice | send 1 eth to ${ADDRESS}`,
      `@alice ⇒ send 1 eth to ${ADDRESS}`,
      `@alice [send 1 eth to ${ADDRESS}]`,
    ]) {
      expect(codeOf(text, {}, credit('alice')), text).toBe('social_execution_command_forbidden');
      expect(codeOf(text, PLATFORM, credit('alice')), text).toBe('social_execution_command_forbidden');
    }
    // an order to pay needs nobody named, behind a symbol or a quote mark as well
    expect(codeOf('👉 pay $50 to the treasury', {})).toBe('social_execution_command_forbidden');
    expect(codeOf("the note said 'send 1 eth to the treasury'", {})).toBe('social_execution_command_forbidden');
  });

  it('lets a report with a subject of its own through, and a command verb used as a noun', () => {
    const cases: [string, ReturnType<typeof credit>][] = [
      ['@base says agents can find, buy and pay for services in USDC.', credit('base')],
      ['@base says agents search the web and pay $0.001 per query in USDC.', credit('base')],
      ['@base: Brave now lets you pay $0.001 per search in USDC.', credit('base')],
      ['@alice you can launch a coin at bootr.fun/launch, and its agent gets a wallet.', credit('alice')],
      ['@alice to launch a coin, open bootr.fun/launch.', credit('alice')],
      ['@alice creators set the fee split at launch, and the coin keeps it.', credit('alice')],
      ['@alice every buy and sell of the coin pays the fee.', credit('alice')],
      ['@alice the swap tool lets an agent swap usdc for eth within its limits.', credit('alice')],
      ['@alice the token launch went fine, the coin page is live.', credit('alice')],
      ['@alice the post-launch coin page shows the agent.', credit('alice')],
      ['@alice i want to launch a coin too, one day.', credit('alice')],
      ['@alice we launch a coin for every agent.', credit('alice')],
      ['@alice agents who pay in usdc get a receipt.', credit('alice')],
      ['@alice anyone can launch a coin on bootr.', credit('alice')],
      ['@alice @bob will launch a coin named FOO tomorrow, he says.', credit('alice', 'bob')],
      ['@alice the agent can send usdc to its creator only.', credit('alice')],
      ['@alice how to launch a coin is in the docs.', credit('alice')],
      ['@alice the easiest way to launch a coin is the form.', credit('alice')],
      ["@alice it's a fair launch: the coin has no presale.", credit('alice')],
      ['@alice people often transfer tokens between wallets.', credit('alice')],
    ];
    for (const [text, attributions] of cases) {
      expect(codeOf(text, {}, attributions), text).toBeNull();
      expect(codeOf(text, PLATFORM, attributions), text).toBeNull();
    }
    expect(postFinding('Good question: agents can find, buy and pay for services in USDC.', [], 'short', false, { reply: true })).toBeNull();
  });
});

describe('social_execution_account_forbidden: an execution bot is never tagged or linked', () => {
  it('lets the project be named in words', () => {
    expect(codeOf('Bankr shipped a guide to running an index from a script; the fee you set at creation can never be changed.')).toBeNull();
    expect(codeOf('Clanker v5 pays creators in ETH or USDC.')).toBeNull();
    expect(codeOf('Clanker shipped v5')).toBeNull();
    expect(codeOf('Clanker shipped v5', {})).toBeNull();
  });

  it('refuses a mention and a link to the account or its posts, however written', () => {
    for (const text of [
      'News from @bankrbot today.',
      'Bankr shipped a guide: https://x.com/bankrbot/status/2121349892148990066',
      'see x.com/clanker for details',
      'twitter.com/bankrbot/status/1 is worth a read',
      '@bаnkrbot shipped a guide.',
      `@bankr${ZW}bot shipped a guide.`,
      '＠ｂａｎｋｒｂｏｔ shipped a guide.',
      'https://x.com/ClankerAgent/status/1',
      // @clanker_world acts on what it is tagged in (the owner, 2026-11-15)
      '@clanker_world shipped v5',
      'x.com/clanker_world/status/1',
      'Clanker shipped v5: https://x.com/clanker_world/status/1986000000000000000',
      'thanks @some_tradebot',
      '@ bankrbot',
      '&#64;bankrbot',
    ]) expect(codeOf(text, PLATFORM, credit('bankrbot')), text).toBe('social_execution_account_forbidden');
    expect(postFinding('thanks!', [], 'short', false, { reply: true, recipient: 'bankrbot' })?.code).toBe('social_execution_account_forbidden');
    expect(postFinding('thanks!', [], 'short', false, { reply: true, recipient: 'clanker_world' })?.code).toBe('social_execution_account_forbidden');
    expect(codeOf('@clanker_world shipped v5', {}, credit('clanker_world'))).toBe('social_execution_account_forbidden');
  });

  it("refuses a link to a post known to be an execution account's, however the link names its author", () => {
    const ids = ['1857000000000000001'];
    for (const text of [
      'bankr launched a new tool today, x.com/i/status/1857000000000000001',
      'bankr launched a new tool today: https://x.com/i/web/status/1857000000000000001',
      'see https://twitter.com/base/status/1857000000000000001',
      'see https://fxtwitter.com/anyone/status/1857000000000000001?s=20',
    ]) {
      expect(postFinding(text, [], 'original', false, { platform: true, executionPostIds: ids }), text).toMatchObject({ code: 'social_execution_account_forbidden', cause: 'link' });
      // without the dataset's word on it the link is any post on X
      expect(postFinding(text, [], 'original', false, {}), text).toBeNull();
    }
    expect(xStatusIds('a https://x.com/i/status/12 and x.com/base/status/34 and twitter.com/a/statuses/56')).toEqual(['12', '34', '56']);
    expect(postFinding('base said so: https://x.com/base/status/1857000000000000002', [], 'original', false, { platform: true, executionPostIds: ids })).toBeNull();
  });

  it('tells the model to drop the link as well as the @, and to name the project in words', () => {
    const link = postFinding('Bankr shipped a guide: https://x.com/bankrbot/status/2121349892148990066', [], 'original', false, PLATFORM)!;
    expect(link.cause).toBe('link');
    // the model dropped the @ and kept the link, and was refused without being told why: the words now say it
    expect(postRefusal('Bankr shipped a guide: https://x.com/bankrbot/status/2121349892148990066', [], 'original', false, PLATFORM)).toMatch(
      /^social_execution_account_forbidden: "https:\/\/x\.com\/bankrbot" links an account .* Take the link out as well as any @, and name the project in plain words \(for example "Bankr"\)/,
    );
    expect(postRefusal('News from @bankrbot today.', [], 'original', false, PLATFORM)).toMatch(/^social_execution_account_forbidden: "@bankrbot" tags an account .*no @ and no link/);
  });
});

describe('social_runtime_jargon_forbidden: x402 is a public name, "allowance" an ordinary word', () => {
  it('lets the measured news posts through, on the platform account and any other', () => {
    for (const text of [
      'Base says the Brave Search API now lets AI agents pay as they go in USDC on Base, using x402.',
      'A new count puts agent payments at 6.4 million x402 agent payments since launch.',
      'Exa now takes per-query payments from agents: https://exa.ai/blog/x402-search',
      'Creators can cap the allowance an agent spends in a day; the default is 50 USDC.',
    ]) {
      expect(codeOf(text), text).toBe(text.includes('exa.ai') ? 'platform_link_forbidden' : null);
      expect(codeOf(text, {}), text).toBeNull();
    }
  });

  it('still refuses the plumbing, in a thread part too', () => {
    expect(threadRefusal(['Agents pay their own way on Bootr.', 'My allowance is down to 3 USDC.'], [], PLATFORM)).toMatch(/^social_runtime_jargon_forbidden: part 2 .*"my allowance"/);
    expect(codeOf('The paymaster covered it.')).toBe('social_runtime_jargon_forbidden');
  });
});

describe('platform_treasury_talk_forbidden: a first-person sentence that mentions a fee', () => {
  it('lets the measured honest posts through', () => {
    for (const text of [
      'One thing I wanted people to understand about Bootr: the fee split a creator sets at launch is locked in the contract — no one can change it after the fact…',
      "Something I like about how Bootr is built: a coin's fee split is set at launch and then locked. Nobody, me included, can change it later…",
      "Bankr's guide to running an index from a script has a detail I like: the fee you set at creation can never be changed…",
      '@brian_armstrong says Base lending markets now hold $7.49B supplied and $2.65B borrowed, and calls it "beloved by agents." My take: an agent with its own wallet needs somewhere to pay, earn and settle…',
      // a third party that earns, and the fee as how Bootr works
      'Creators earn in ETH or USDC, never in their own coin.',
      'I think the fee split is the most important number on a coin page.',
      'We explain the fee split on every coin page: 50% creator, 30% platform, 15% burn, 5% agent.',
      'Creators keep the fees earned on their coin; nobody can redirect them.',
      // a first person who makes or gets something that is no money, and a name set off by commas that does not act
      'I made a guide to the fee split.',
      'I got the fees question three times today: the split is locked at launch.',
      'I, for one, think creators earn the right way here.',
      'We went and read every coin page this week.',
    ]) expect(postFinding(text, text.startsWith('@brian_armstrong') ? [{ username: 'brian_armstrong', sourceUrl: 'https://x.com/brian_armstrong/status/1' }] : [], 'original', false, PLATFORM)?.code ?? null, text).toBeNull();
  });

  it("still refuses the agent's own treasury operations", () => {
    for (const text of [
      'I just claimed my fees for the week.',
      "We've swapped some ETH to keep the lights on.",
      'Refuelled my gas this morning, all good.',
      'Fees earned so far: about $40.',
      'Our treasury holds enough for another month.',
      'Gas top-up done.',
      'I have finally collected 0.3 ETH.',
      "I'm topping up tonight.",
      'We will withdraw on Friday.',
      'my balance is 2 ETH',
      'I paid the gas myself this time.',
      'We spent 1.10 USDC of fuel on that post.',
      // obfuscated
      `I ju${ZW}st cla${ZW}imed`,
      'I clаimed my share today.',
      'οur treasury is full',
      // wrapped in a report or a quote
      'Asked what changed, the answer is simple: "we swapped half to USDC."',
      'Update. Fees claimed today: $12.',
      // the security review of 2026-11-15: an amount before the fees, a name set off by commas, fillers, an ordinary
      // verb with a sum, the fuel and the wallet
      '0.4 eth of fees claimed today',
      'i, the platform agent, claimed 0.3 eth',
      'i finally went and claimed 0.3 eth',
      'we moved 0.5 eth of fees to the treasury',
      'i made 0.4 eth in fees today',
      'topped up my fuel with 5 usdc',
      'my wallet now holds 2 eth',
      'We sent 5 USDC to the winner.',
      'I got $40 from the fee split this week.',
    ]) expect(codeOf(text), text).toBe('platform_treasury_talk_forbidden');
  });

  it('reaches every part of a thread', () => {
    expect(threadRefusal(['How the fee split works on Bootr.', 'I claimed mine this morning.'], [], PLATFORM)).toMatch(/^platform_treasury_talk_forbidden: part 2 .*"i claimed"/);
  });
});

describe('wallet payloads: a URI, not the word', () => {
  it('refuses a payment or pairing URI and lets a sentence that opens with the chain name through', () => {
    for (const text of ['pay here: ethereum:0x52908400098527886E0F7030069857D2E4169EE7@8453?value=1e16', 'ethereum:pay-0x52908400098527886E0F7030069857D2E4169EE7@8453', 'connect with wc:8a5e5bdc-a0e4-47@2?relay-protocol=irn', 'solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU?amount=1'])
      expect(outgoingActionRisk(text), text).toBe('social_wallet_payload_forbidden');
    for (const text of ['Ethereum: the next upgrade ships blobs to more rollups.', 'solana: one chain among many, with its own fee market.', 'three chains in one sentence: ethereum, base and solana.'])
      expect(outgoingActionRisk(text), text).toBeNull();
  });
});

