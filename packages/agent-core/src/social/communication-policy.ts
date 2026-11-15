/**
 * Conversation is not an execution channel. These deterministic guards reject
 * outgoing text that reads like a financial command, a wallet payload or a
 * hand-off to an execution bot. They complement scoped signers; they do not
 * try to prove arbitrary text safe.
 *
 * The threat model (settled 2026-11-15). The model writing a post may be fully steered by a hostile mention, so what
 * decides is the shape of the words it sends, never who the text says it quotes. Three readers can act on a post:
 *  - an execution bot (a launcher, a trading agent, any handle ending in "bot") acts on what is addressed to it. Such
 *    an account is never tagged, never linked (on X a link to an account's post quotes it and notifies it, as an @
 *    does, and the gate cannot know what a bot does with a quote) and never answered, whatever the rest of the text.
 *    The project may be named in words ("Bankr");
 *  - a wallet or a client acts on a payload (a payment URI, a signing call, a share window): refused in any text;
 *  - a person or another agent may act on an order from an account it trusts. A post is refused when it gives an
 *    order to launch, pay, trade, approve or sign to somebody: the order's verb stands where an order stands (at the
 *    head of the text or of any clause, a quote included; right after a handle, "@alice send …", "@alice, please
 *    send …"; after "please", "can you", "you should", "you need to") and the text names an account (an @, or a link
 *    to the account or its post) or answers one. An order to pay (an amount, fees routed to an account, an unlimited
 *    approval) is refused even when nobody is named, and an order right after a handle in any text. In a text that
 *    names an account or answers one, any command verb with its object in the same sentence is an order unless it
 *    has a subject of its own or is a noun (`reportedAt` below; the security review of 2026-11-15 got orders through
 *    the list of positions with one filler word, quote mark or symbol).
 * A report about what somebody did or what a product lets people do ("@bootrfun added an MCP server: you can ask it
 * to launch a coin", "Brave now lets agents pay per search in USDC") has a subject before the verb and is not an
 * order, so naming its source no longer refuses it (before 2026-11-15 any handle anywhere plus any such phrase did,
 * and the platform account tags the author of every post it comments on). Wrapping an order in a report does not
 * help it through: '@alice says: "send 1 ETH to 0x…"' still has the order at the head of a clause.
 */
import { excerptOf, type GateFinding } from './gate-words.js';

/**
 * Cyrillic and Greek letters that read as Latin ones, both cases, to the Latin letter a reader sees. NFKC leaves them
 * alone, so "bυy $BOOTR" or "@bаnkr" (a Greek upsilon, a Cyrillic a) would read as the word and match as nothing. Only
 * the matching sees the folded text; a genuine Cyrillic or Greek word comes out as a mix that spells none of the
 * rules' words unless every one of its letters is a look-alike.
 */
const LOOKALIKES: Readonly<Record<string, string>> = Object.fromEntries(
  [
    ['аАαΑ', 'a'], ['вВβΒ', 'b'], ['сСϲϹ', 'c'], ['ԁ', 'd'], ['еЕёЁεΕ', 'e'], ['ɡ', 'g'], ['һнНηΗ', 'h'], ['іІїЇιΙӏ', 'i'],
    ['јЈ', 'j'], ['кКκΚ', 'k'], ['мМμΜ', 'm'], ['Νп', 'n'], ['оОοΟσ', 'o'], ['рРρΡ', 'p'], ['ԛ', 'q'], ['ѕЅ', 's'],
    ['тТτΤ', 't'], ['υ', 'u'], ['ν', 'v'], ['ԝѡ', 'w'], ['хХχΧ', 'x'], ['уУγΥ', 'y'], ['Ζ', 'z'],
  ].flatMap(([from, to]) => [...from!].map((c) => [c, to!])),
);
const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu');

/**
 * Decode entities and percent-escapes twice, fold with NFKC, drop default-ignorable code points, read Cyrillic and
 * Greek look-alikes as the Latin letters they show, lowercase.
 */
export function normalizedCommunication(value: unknown): string {
  let text = String(value ?? '');
  for (let pass = 0; pass < 2; pass++) {
    text = text.replace(/&#(?:x([a-f0-9]+)|(\d+));?/gi, (all, hex: string | undefined, dec: string | undefined) => {
      const code = parseInt(hex ?? dec ?? '', hex ? 16 : 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    });
    try {
      text = decodeURIComponent(text);
    } catch {
      /* keep the undecodable text as-is */
    }
  }
  return text
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(LOOKALIKE, (c) => LOOKALIKES[c]!)
    .toLowerCase();
}

/** Handles that act as execution bots (launchers, trading agents, anything ending in "bot"). */
export function executionAccount(value: unknown, exempt: readonly string[] = []): boolean {
  const name = normalizedCommunication(value).replace(/[^a-z0-9_]/g, '');
  if (!name) return false;
  if (exempt.some((handle) => handle.toLowerCase() === name)) return false;
  return /^(?:bankr|clanker)(?:bot|_bot|agent|_agent)?$/.test(name) || /bot$/.test(name);
}

const HANDLE_PATTERN =
  /@\s*[~*`]*\s*([a-z0-9_]{1,64})|(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|telegram\.me)\/([a-z0-9_]{1,64})/g;

/** A handle the text names, with the words that name it: an `@` (`mention`) or a link to the account (`link`). */
interface NamedHandle {
  handle: string;
  via: 'mention' | 'link';
  match: string;
}

function namedHandles(text: string): NamedHandle[] {
  return [...text.matchAll(HANDLE_PATTERN)].map((m) => ({ handle: (m[1] ?? m[2])!, via: m[1] ? 'mention' : 'link', match: m[0] }));
}

const ASSET = '(?:eth|usdc|usdt|btc|sol|coin|token|tokens|funds|money|balance|wallet|treasury|him|her|them)';
const ADDRESS = '0x[a-f0-9]{40}';

/** What an order to launch, trade or sign says, read from its verb on (sticky: matched at the verb's own position). */
const EXECUTION_PATTERN = new RegExp(
  [
    `(?:launch|deploy|create|mint|issue)(?:ing|ping)?\\b[\\s\\S]{0,100}\\b(?:coin|token|ticker|contract|nft|meme)\\b`,
    `(?:send|transfer|pay|tip|withdraw|bridge|swap|buy|sell)(?:ing|ping)?\\b[\\s\\S]{0,100}(?:\\b${ASSET}\\b|${ADDRESS}|\\$\\s*\\d)`,
    `(?:approve|permit2?|setapprovalforall|sign)(?:ing|ping)?\\b[\\s\\S]{0,100}\\b(?:transaction|typed.?data|permit|allowance|spender|wallet|message|signature)\\b`,
  ].join('|'),
  'y',
);
/** What an order to pay says, read from its verb on: an amount, or an unlimited approval. */
const PAYMENT_PATTERN = new RegExp(
  [
    `(?:send|transfer|pay|tip|withdraw)(?:ing|ping)?\\b[\\s\\S]{0,80}(?:\\$\\s*\\d|\\d+(?:\\.\\d+)?\\s*(?:eth|usdc|usdt|btc|sol)\\b)`,
    `(?:approve|permit)(?:ing|ping)?\\b[\\s\\S]{0,60}\\b(?:unlimited|infinite|max|spender)\\b`,
  ].join('|'),
  'y',
);
/** Fees routed to an account or a person ("fees go to @alice", "royalties to me"). */
const FEE_ROUTING = /\b(?:fees?|royalties|proceeds)\s+(?:go\s+)?to\s+(?:him|her|me|you|them|0x|@)/;

const COMMAND_VERB = '(?:launch|deploy|create|mint|issue|send|transfer|pay|tip|withdraw|bridge|swap|buy|sell|approve|permit2?|setapprovalforall|sign)';
/**
 * The head of a clause: the text's start, a sentence end, a colon or semicolon, a new line, a quote mark or a bracket
 * (opening or closing, a straight one only where a word does not run into it: "don't" is no quote), a dash, an arrow,
 * a pipe, a "> " quote line, a list number ("1)" ends in a bracket), any symbol or emoji ("👉 pay $50"). Before 2026-11-15 a
 * straight quote, an arrow or a list number let an order through.
 */
const CLAUSE_START =
  "(?:^|[.!?:;\\n\"“”‘«»‹›「」『』()\\[\\]{}—–…>|]|(?<![a-z0-9_])['’]|\\p{S}|\\p{Extended_Pictographic}|\\s-\\s|(?:^|\\n)\\s*[-*•·])";
const HANDLE_WORD = '[@\\uff20]\\s*[~*`]*\\s*[a-z0-9_]{1,64}';
const SEPARATOR = '[\\s,:;—–-]*';
/** What may stand between the head of an order and its verb: a greeting, a please, a request, a directive. */
const LEAD_WORD =
  "(?:hey|hi|yo|please|pls|plz|kindly|ok|okay|yes|then|now|so|just|go|quickly|also|and|first|next|simply|go ahead and|can you|could you|would you|will you|can u|i need you to|i want you to|you need to|you should|you must|you have to|you gotta|make sure to|remember to|don['’]?t forget to)";
/**
 * Where an order's verb stands: at the head of a clause (after any handles it names first), right after a handle,
 * after a please or a "so", after a directive to "you", or in a request ("can you", "would you mind sending"). The
 * verb is the last group. An order right after a handle names that handle, so the text that holds it always counts
 * as addressed.
 */
const ORDER_POSITION = new RegExp(
  `(?:(?:${CLAUSE_START}\\s*(?:${HANDLE_WORD}${SEPARATOR})*|${HANDLE_WORD}${SEPARATOR}|\\b(?:please|pls|plz|kindly|so)\\s+|\\b(?:you|u|y['’]?all)\\s+(?:should|must|need to|have to|gotta|better|ought to)\\s+(?:[a-z]+\\s+)?|\\b(?:can|could|would|will)\\s+(?:you|u)\\s+)(?:${LEAD_WORD}${SEPARATOR}){0,3}(${COMMAND_VERB})|\\b(?:would|do|could)\\s+(?:you|u)\\s+(?:please\\s+)?mind\\s+(${COMMAND_VERB})(?:ing|ping))\\b`,
  'gu',
);

/** Where the verb of every order in the text stands. */
function orders(text: string): number[] {
  return [...text.matchAll(ORDER_POSITION)].map((m) => {
    const verb = m[1] ?? m[2]!;
    const end = m.index + m[0].length;
    return m[1] !== undefined ? end - verb.length : text.lastIndexOf(verb, end);
  });
}

/** The words of the first order whose content `pattern` reads from its verb on, or null. */
function orderSaying(text: string, at: readonly number[], pattern: RegExp): string | null {
  for (const verb of at) {
    pattern.lastIndex = verb;
    const m = pattern.exec(text);
    if (m) return m[0];
  }
  return null;
}

/*
 * In a text that names an account, or a reply, every command verb is read for its subject (2026-11-15). The places an
 * order's verb may stand (ORDER_POSITION) are a list, and one word the list did not hold ("@alice dude, swap all your
 * eth", "@alice wrote send 1 eth to 0x…", "@alice time to buy") let an order through. Here it is the other way round:
 * a command verb (in its plain form, its object in the same sentence) is an order to the account the text names unless
 * something before it in its clause makes it a report or a noun:
 *  - a subject that is not the reader: "i", "we", "they", "people", "who", "that", a plural noun ("agents pay",
 *    "people often transfer tokens"), or any subject with a modal of ability or report ("agents can send them",
 *    "you can launch a coin", "@alice will launch"; not "you will", which is a command);
 *  - "you" only after "let", "help" or "make" ("Brave lets you pay per search");
 *  - an infinitive that no directive governs ("ask in plain words to launch a coin", "how to launch"; not "time to
 *    buy", "you need to send", "make sure to pay", "i want you to send");
 *  - a determiner or a preposition, which makes the verb a noun ("the swap tool", "at launch", "every buy and sell",
 *    "coin's launch"), and the domain nouns that make one a compound ("token launch", "fair launch", "usdc swap");
 *  - a verb joined by "and" or a comma to one that has such a subject ("agents can find, buy and pay in usdc",
 *    "agents search the web and pay $0.001"); a plural that is only an object ("read the docs and send") is none.
 * A directive ("should", "must", "need to", "have to", "gotta", "better", "you will", "let's") is an order whatever
 * its subject ("anyone who wants in should send 1 eth"). Anything else before the verb, a vocative ("dude"), a quote
 * mark of any kind, an arrow, a list number, an emoji, a "please do", a speech verb ("wrote send"), leaves it an order.
 */
const WORD_RUN = /\s*(?:[@＠]?[a-z0-9_]+(?:['’][a-z]+)?(?:\s+|$))*$/u;
const WORD_IN_RUN = /[@＠]?[a-z0-9_]+(?:['’][a-z]+)?/gu;
const words = (list: string) => new Set(list.split(' '));
/** Words that may stand between a subject and its verb without changing who acts. */
const SKIPPED = words("now also just already often then still soon easily directly automatically even only finally instantly actually really simply never always usually sometimes quickly first next today together not do does did don't doesn't didn't dont doesnt didnt don’t doesn’t didn’t");
const REPORT_MODAL = words("can could may might will would shall cannot can't cant won't wont wouldn't couldn't can’t won’t wouldn’t couldn’t");
const DIRECTIVE = words("should shouldn't shouldn’t must mustn't mustn’t gotta better lets let's let’s");
const YOU = words("you u ya ye yall y'all y’all");
const CAUSATIVE = words('let lets letting help helps helped helping make makes made making');
const SUBJECT = words('i we they who which that people men women children');
/** A relative pronoun is the subject of its own clause only, never of a verb after a comma ("anyone who wants in, send"). */
const RELATIVE = words('who which that');
/** A determiner, a preposition, a possessive or a domain noun before the verb makes it a noun ("the swap tool", "token launch"). */
const NOUN_BEFORE = words(
  'a an the this that these those its their our my your every each any no per at on of for after before since until from by via whose another other same one coin token agent fair stealth soft public free nft meme usdc eth weth btc sol base bootr clanker bankr x402 test',
);
/** "-s" words that are no plural subject: function words, speech verbs, vocatives. */
const NOT_PLURAL = words(
  'is was has does yes this thus plus its his hers ours yours theirs as us always sometimes perhaps besides unless whereas lets says asks tells wants needs writes posts tweets notes adds suggests urges insists claims reckons thinks means replies guys frens friends folks gents bros lads ladies homies degens anons chads kings queens legends mates pals sirs fellas peeps boys girls thanks congrats cheers kudos lots pls',
);
const TO_DIRECTIVE = words('time need needs needed have has had got ought gotta remember forget forgot sure better urge urged beg go come');
/** Verbs whose infinitive is as much an order as they are ("i want to launch" reports, "@alice want to send 1 eth?" asks). */
const TO_INHERITS = words('want wanted like love try care wish hope plan decide choose prefer mean');
const CONJUNCTION = words('and or nor plus but');
const BE = words("is are was were be been being 're ’re am");

const isPlural = (w: string) => /^[a-z][a-z0-9]*[^siu'’\W]s$/u.test(w) && w.length >= 3 && !NOT_PLURAL.has(w);
const isHandle = (w: string) => /^[@＠]/u.test(w);
const suffixOf = (w: string) => /['’](ll|d)$/u.exec(w)?.[1] ?? null;
const stemOf = (w: string) => w.replace(/['’][a-z]+$/u, '');

interface Word {
  w: string;
  at: number;
}

/** The words of the clause right before `at`, nearest last, and the character that ended the run ('' at the text's start). */
function clauseBefore(text: string, at: number): { run: Word[]; stop: string; stopAt: number } {
  const head = text.slice(Math.max(0, at - 200), at);
  const offset = at - head.length;
  const m = WORD_RUN.exec(head)!;
  const run = [...m[0].matchAll(WORD_IN_RUN)].map((x) => ({ w: x[0], at: offset + m.index + x.index }));
  const stopAt = offset + m.index - 1;
  return { run, stop: stopAt >= 0 && m.index > 0 ? text[stopAt]! : '', stopAt };
}

/** The index of the nearest word before `i` that is not a skipped adverb, or -1. */
function previous(run: readonly Word[], i: number): number {
  let j = i - 1;
  while (j >= 0 && SKIPPED.has(run[j]!.w)) j--;
  return j;
}

/** True when the words before `i` give run[i] a subject that is not the reader (`relative`: a who/which/that counts). */
function subjectBefore(run: readonly Word[], i: number, relative: boolean): boolean {
  const j = previous(run, i);
  if (j < 0) return false;
  const w = run[j]!.w;
  if (suffixOf(w)) return !(suffixOf(w) === 'll' && YOU.has(stemOf(w)));
  if (REPORT_MODAL.has(w)) {
    const k = previous(run, j);
    if (k < 0) return false;
    const s = run[k]!.w;
    if (/^(?:please|pls|plz|kindly|so|and|or|then|hey|hi|yo|ok|okay|go)$/u.test(s)) return false;
    return !(YOU.has(s) && /^(?:will|shall|won['’]?t|wont)$/u.test(w));
  }
  if (w === 'to') return !infinitiveDirected(run, j);
  if (YOU.has(w)) return previous(run, j) >= 0 && CAUSATIVE.has(run[previous(run, j)]!.w);
  if (SUBJECT.has(w)) return relative || !RELATIVE.has(w);
  return isPlural(w);
}

/** True when the infinitive's "to" at run[j] follows a directive ("time to", "need to", "you to", "you're going to"). */
function infinitiveDirected(run: readonly Word[], j: number): boolean {
  const p = run[j - 1]?.w;
  if (p === undefined) return false;
  if (TO_DIRECTIVE.has(p) || YOU.has(p)) return true;
  if (TO_INHERITS.has(p)) return !subjectBefore(run, j - 1, true);
  if (p === 'going' || p === 'gonna') return run.slice(Math.max(0, j - 4), j - 1).some((x) => YOU.has(stemOf(x.w)) || /^(?:your|ur|youre)$/u.test(x.w));
  return false;
}

/** A word that may be the verb of a reported clause ("search" in "agents search the web and pay"). */
const verbLike = (w: string) =>
  !isHandle(w) && !CONJUNCTION.has(w) && !NOUN_BEFORE.has(w) && !SKIPPED.has(w) && !SUBJECT.has(w) && !REPORT_MODAL.has(w) && !YOU.has(w) && !BE.has(w) && w !== 'to' && !isPlural(w);

const COMMAND_WORD = new RegExp(`^${COMMAND_VERB}$`, 'u');

/** True when the command verb at `at` is a report or a noun, not an order (see above). */
function reportedAt(text: string, at: number, depth = 0): boolean {
  if (depth > 4) return false;
  // a compound ("post-launch", "pay-per-search"), a handle or a cashtag: the verb is part of a word
  if (at > 0 && /[-@\uff20$]/u.test(text[at - 1]!)) return true;
  const { run, stop, stopAt } = clauseBefore(text, at);
  const i = run.length;
  const j = previous(run, i);
  if (j < 0) {
    // nothing before it in the clause; after a comma it may share the verb before the comma ("agents can find, buy")
    if (stop !== ',' || run.length > 0) return false;
    const before = clauseBefore(text, stopAt);
    const k = before.run.length - 1;
    return k >= 0 && !isHandle(before.run[k]!.w) && (COMMAND_WORD.test(before.run[k]!.w) ? reportedAt(text, before.run[k]!.at, depth + 1) : subjectBefore(before.run, k, false));
  }
  const w = run[j]!.w;
  if (DIRECTIVE.has(w)) return false;
  if (NOUN_BEFORE.has(w) || (/['’]s$/u.test(w) && !/^(?:let|it|that|what|here|there|he|she)['’]s$/u.test(w))) return true;
  if (CONJUNCTION.has(w)) {
    const k = previous(run, j);
    if (k >= 0 && COMMAND_WORD.test(run[k]!.w)) return reportedAt(text, run[k]!.at, depth + 1);
    for (let v = 0; v < j; v++) if (verbLike(run[v]!.w) && subjectBefore(run, v, true)) return true;
    return false;
  }
  return subjectBefore(run, i, true);
}

/** Every command verb of the text that is not reported (see above): where an order to the account named stands. */
function unreportedVerbs(text: string): number[] {
  return [...text.matchAll(new RegExp(`(?<![a-z0-9_])${COMMAND_VERB}(?![a-z0-9_'’-])`, 'gu'))].map((m) => m.index).filter((at) => !reportedAt(text, at));
}

/** The same content as EXECUTION_PATTERN and PAYMENT_PATTERN, inside the verb's own sentence (a decimal point is no end). */
const inSentence = (pattern: RegExp) => new RegExp(pattern.source.replaceAll('[\\s\\S]', '(?:[^.!?\\n]|\\.(?=\\d))'), 'yu');
const EXECUTION_IN_SENTENCE = inSentence(EXECUTION_PATTERN);
const PAYMENT_IN_SENTENCE = inSentence(PAYMENT_PATTERN);

const WALLET_PAYLOAD =
  /\b(?:ethereum|solana|wc):|\btg:\/\/[^\s]*(?:start|send|text)=|\b(?:eth_sendtransaction|eth_signtypeddata(?:_v4)?|personal_sign|wallet_sendcalls|wallet_signtypeddata)\b/;
const INTENT_LINK = /(?:x\.com|twitter\.com)\/(?:intent|share)\b[^\s]*(?:text|url)=/;
const SIGN_WITH_ADDRESS = /\b(?:approve|permit2?|sign|setapprovalforall)\b[\s\S]{0,80}0x[a-f0-9]{40,}/;
const RAW_SIGNATURE_OR_FEE_ROUTING = /0x[a-f0-9]{130,}|\b(?:fees?|royalties)\b[\s\S]{0,80}@/;

export interface RiskContext {
  /** The text is a reply (a bare command in a reply is treated as addressed). */
  reply?: boolean;
  /** Who receives the text, if known. */
  recipient?: string | null;
  /** Other participants named in the conversation. */
  participants?: readonly (string | null | undefined)[];
  /** Handles that are never treated as execution accounts (for example our own). */
  exemptAccounts?: readonly string[];
}

export type RiskCode =
  | 'social_execution_account_forbidden'
  | 'social_wallet_payload_forbidden'
  | 'social_execution_link_forbidden'
  | 'social_execution_command_forbidden';

/** A refusal of this file's rules: the code, and the words of the agent's own text that tripped it. */
export interface RiskFinding extends GateFinding {
  code: RiskCode;
}

const found = (code: RiskCode, match: RegExpExecArray | string | null, cause?: string): RiskFinding => ({
  code,
  excerpt: excerptOf(typeof match === 'string' ? match : (match?.[0] ?? null)),
  ...(cause ? { cause } : {}),
});

/**
 * Why the outgoing text must not be published, or null: the code with the matched words of the text itself. An
 * execution account that came from the conversation (`recipient`, `participants`) is never quoted: it is not the
 * agent's own text.
 */
export function outgoingActionFinding(value: unknown, context: RiskContext = {}): RiskFinding | null {
  const { reply = false, recipient, participants = [], exemptAccounts = [] } = context;
  const text = normalizedCommunication(value);
  const named = namedHandles(text);
  const bot = named.find((n) => executionAccount(n.handle, exemptAccounts));
  if (bot) return found('social_execution_account_forbidden', bot.match, bot.via);
  if ([recipient, ...participants].some((h) => h && executionAccount(h, exemptAccounts))) return { code: 'social_execution_account_forbidden', excerpt: null, cause: 'recipient' };
  const payload = WALLET_PAYLOAD.exec(text);
  if (payload) return found('social_wallet_payload_forbidden', payload);
  const intent = INTENT_LINK.exec(text);
  if (intent) return found('social_execution_link_forbidden', intent);

  // A text names somebody by an @ or by a link to the account or its post; a reply answers somebody.
  const addressed = named.length > 0;
  const given = orders(text);
  // In a text that reaches somebody, every command verb without a subject of its own is an order too (see above).
  const unreported = addressed || reply ? unreportedVerbs(text) : [];
  const payment = orderSaying(text, given, PAYMENT_PATTERN) ?? orderSaying(text, unreported, PAYMENT_IN_SENTENCE);
  if (payment) return found('social_execution_command_forbidden', payment);
  const action = addressed || reply ? (orderSaying(text, given, EXECUTION_PATTERN) ?? orderSaying(text, unreported, EXECUTION_IN_SENTENCE)) : null;
  if (action) return found('social_execution_command_forbidden', action);
  const fees = FEE_ROUTING.exec(text);
  if (fees && (addressed || given.length > 0)) return found('social_execution_command_forbidden', fees);
  const signing = addressed || reply ? SIGN_WITH_ADDRESS.exec(text) : null;
  if (signing) return found('social_wallet_payload_forbidden', signing);
  const routing = addressed ? RAW_SIGNATURE_OR_FEE_ROUTING.exec(text) : null;
  if (routing) return found('social_wallet_payload_forbidden', routing);
  return null;
}

/** Returns a risk code when the outgoing text must not be published, otherwise null. */
export function outgoingActionRisk(value: unknown, context: RiskContext = {}): RiskCode | null {
  return outgoingActionFinding(value, context)?.code ?? null;
}
