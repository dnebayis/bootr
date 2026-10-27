/**
 * Conversation is not an execution channel. These deterministic guards reject
 * outgoing text that reads like a financial command, a wallet payload or a
 * hand-off to an execution bot. They complement scoped signers; they do not
 * try to prove arbitrary text safe.
 */

/** Decode entities and percent-escapes twice, fold with NFKC, drop default-ignorable code points, lowercase. */
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
  return text.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').toLowerCase();
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

function namedHandles(text: string): string[] {
  return [...text.matchAll(HANDLE_PATTERN)].map((m) => (m[1] ?? m[2])!);
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

/** Returns a risk code when the outgoing text must not be published, otherwise null. */
export function outgoingActionRisk(value: unknown, context: RiskContext = {}): RiskCode | null {
  const { reply = false, recipient, participants = [], exemptAccounts = [] } = context;
  const text = normalizedCommunication(value);
  const named = namedHandles(text);
  if ([recipient, ...participants, ...named].some((h) => h && executionAccount(h, exemptAccounts)))
    return 'social_execution_account_forbidden';
  if (WALLET_PAYLOAD.test(text)) return 'social_wallet_payload_forbidden';
  if (INTENT_LINK.test(text)) return 'social_execution_link_forbidden';

  const action = EXECUTION_PATTERN.test(text);
  const addressed = named.length > 0;
  const opening = text.replace(/^[\s\p{P}]+/u, '').replace(/^(?:(?:hey|please|ok(?:ay)?|yes|then|now)[\s,]+)+/u, '');
  const command = COMMAND_OPENING.test(opening);
  const payment = PAYMENT_PATTERN.test(text);
  if ((action && (addressed || (reply && command))) || (payment && (addressed || command)))
    return 'social_execution_command_forbidden';
  if ((addressed || reply) && SIGN_WITH_ADDRESS.test(text)) return 'social_wallet_payload_forbidden';
  if (addressed && RAW_SIGNATURE_OR_FEE_ROUTING.test(text)) return 'social_wallet_payload_forbidden';
  return null;
}
