/**
 * Conversation is not an execution channel. These deterministic guards reject
 * outgoing text that reads like a financial command, a wallet payload or a
 * hand-off to an execution bot. They complement scoped signers; they do not
 * try to prove arbitrary text safe.
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

const EXECUTION_PATTERN = new RegExp(
  [
    `\\b(?:launch|deploy|create|mint|issue)\\b[\\s\\S]{0,100}\\b(?:coin|token|ticker|contract|nft|meme)\\b`,
    `\\b(?:send|transfer|pay|tip|withdraw|bridge|swap|buy|sell)\\b[\\s\\S]{0,100}(?:\\b${ASSET}\\b|${ADDRESS}|\\$\\s*\\d)`,
    `\\b(?:approve|permit2?|setapprovalforall|sign)\\b[\\s\\S]{0,100}\\b(?:transaction|typed.?data|permit|allowance|spender|wallet|message|signature)\\b`,
    `\\b(?:fees?|royalties|proceeds)\\s+(?:go\\s+)?to\\b`,
  ].join('|'),
);
const PAYMENT_PATTERN = new RegExp(
  [
    `\\b(?:send|transfer|pay|tip|withdraw)\\b[\\s\\S]{0,80}(?:\\$\\s*\\d|\\d+(?:\\.\\d+)?\\s*(?:eth|usdc|usdt|btc|sol)\\b)`,
    `\\b(?:fees?|royalties|proceeds)\\s+(?:go\\s+)?to\\s+(?:him|her|me|you|them|0x|@)`,
    `\\b(?:approve|permit)\\b[\\s\\S]{0,60}\\b(?:unlimited|infinite|max|spender)\\b`,
  ].join('|'),
);
const COMMAND_OPENING =
  /^(?:launch|deploy|create|mint|issue|send|transfer|pay|tip|withdraw|bridge|swap|buy|sell|approve|permit|sign)\b/u;
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

  const action = EXECUTION_PATTERN.exec(text);
  const addressed = named.length > 0;
  const opening = text.replace(/^[\s\p{P}]+/u, '').replace(/^(?:(?:hey|please|ok(?:ay)?|yes|then|now)[\s,]+)+/u, '');
  const command = COMMAND_OPENING.test(opening);
  const payment = PAYMENT_PATTERN.exec(text);
  if (action && (addressed || (reply && command))) return found('social_execution_command_forbidden', action);
  if (payment && (addressed || command)) return found('social_execution_command_forbidden', payment);
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
