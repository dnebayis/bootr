/**
 * Public text must not leak what the agent runs on. These deterministic guards
 * reject outgoing posts that carry secret material, internal infrastructure
 * references, runtime jargon from the agent loop, or on-chain addresses the
 * agent was not told it may publish. They complement the voice rules in the
 * system prompt: the model is asked to write for people, the gate makes sure
 * a slip never reaches X.
 */
import { normalizedCommunication } from './communication-policy.js';
import { excerptOf, type GateFinding } from './gate-words.js';

export type DisclosureCode =
  | 'social_secret_material_forbidden'
  | 'social_internal_reference_forbidden'
  | 'social_runtime_jargon_forbidden'
  | 'social_private_address_forbidden'
  | 'social_unreadable_number_forbidden';

/** Private keys, HMAC secrets, API keys, JWTs, verification tokens, PEM blocks. */
const SECRET_MATERIAL = new RegExp(
  [
    '0x[a-f0-9]{64}', // 32-byte hex: private key or service secret
    '(?<![a-z0-9])[a-f0-9]{64}(?![a-z0-9])', // bare 32-byte hex
    '\\bsk-(?:or-)?[a-z0-9_-]{16,}', // openrouter / openai style keys
    '\\beyj[a-z0-9_-]{10,}\\.[a-z0-9_-]{10,}', // jwt (normalized to lowercase)
    '\\brailway-verify=',
    'begin (?:rsa |ec |openssh |pgp )?private key',
    '\\b(?:bearer|hmac) [a-z0-9:._-]{20,}',
  ].join('|'),
  'i',
);

/** Internal hosts, env-var names and the service topology. */
const INTERNAL_REFERENCE = new RegExp(
  [
    '\\blocalhost\\b',
    '\\b127\\.0\\.0\\.1\\b',
    '\\b(?:[a-z0-9-]+\\.)+railway\\.internal\\b',
    '\\b[a-z0-9-]+\\.up\\.railway\\.app\\b',
    '\\bbackboard\\.railway\\.com\\b',
    '\\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:key|secret|token|password|private_key|url)\\b', // ENV_VAR_NAMES (lowercased)
    '\\bx-sender-|\\bx-supervisor-',
    '/internal/[a-z]',
  ].join('|'),
);

/**
 * Words from the agent loop that only make sense to the people who built it.
 * A post that contains them is a log line, not a post.
 *
 * Not here since 2026-11-15: `x402`, the public name of a payment protocol that Base, Coinbase, Brave and Exa use in
 * their own announcements (five news posts about it were refused in the week of 8 to 14 November), and the bare word
 * "allowance", ordinary English for what a user lets an agent spend; the plumbing sense stays (a spender's or a
 * session's allowance, "my allowance", a token's allowance). The list reads the text with its links taken out.
 */
const RUNTIME_JARGON = new RegExp(
  [
    '\\bcheckpoint(?:s|ed|ing)?\\b',
    '\\bobservation[- ]only\\b',
    '\\bno predictions,? no calls\\b',
    '\\boperational at\\b',
    '\\bwake (?:reason|time|decision)s?\\b',
    '\\bwoken (?:at|by)\\b',
    '\\btick(?:s|ed|ing)?\\b',
    '\\btool (?:call|result|step)s?\\b',
    '\\bruntime\\b',
    '\\binference\\b',
    '\\b(?:spender|session)[- ](?:key|allowance|signer)s?\\b',
    '\\b(?:my|our|spender|session|signer|kernel|usdc|eth|weth|token|erc-?20|approval|unlimited|infinite|max)\\s+allowances?\\b',
    '\\ballowances?\\s+(?:for|of|to)\\s+(?:the\\s+|its\\s+|my\\s+|our\\s+)?(?:spender|session|key|signer|kernel|contract|router|permit2)\\b',
    '\\bsystem prompt\\b',
    '\\b(?:owner|bootr) rules?\\b',
    '\\bpending action\\b',
    '\\b(?:held|pending) (?:op|operation|effect)s?\\b',
    '\\buser ?ops?\\b',
    '\\bbundler\\b',
    '\\bpaymaster\\b',
    '\\bpermission id\\b',
    '\\bentry ?point\\b',
    '\\bagent card\\b',
  ].join('|'),
);

const EVM_ADDRESS = /0x[a-f0-9]{40}(?![a-f0-9])/g;

/** A link, explicit or a bare host with a path, as the jargon rule leaves it out. */
const LINK = /\bhttps?:\/\/\S+|(?<![\w@/.-])(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/g;

/** Scientific notation ($2.3e-7, 1e18): a number nobody reads, round it instead. */
const SCIENTIFIC_NOTATION = /(?<![a-z0-9.])\d+(?:\.\d+)?e[+-]?\d+(?![a-z0-9])/;

export interface DisclosureContext {
  /**
   * Addresses the agent may name in public (its own token, its own treasury).
   * `undefined` skips the address check for callers that do not know them.
   */
  publicAddresses?: readonly string[];
}

/**
 * A transaction on the Base explorer, the one place a 32-byte hex is public by nature: a Basescan tx link names a
 * confirmed movement (a bounty payment's receipt, a claim), never a key. Only the explorer's own `/tx/` path is exempt;
 * a bare hash, or one behind any other host, still reads as secret material.
 */
const EXPLORER_TX_LINK = /https?:\/\/(?:www\.)?(?:sepolia\.)?basescan\.org\/tx\/0x[a-f0-9]{64}(?![a-z0-9])/gi;

/** A refusal of this file's rules: the code, and the words of the agent's own text that tripped it. */
export interface DisclosureFinding extends GateFinding {
  code: DisclosureCode;
}

/** An address as a refusal names it: enough to tell which one, never the whole of something that might be a key. */
const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Why the outgoing text must not be published, or null: the code with the matched words of the text itself. Secret
 * material is never quoted back (a refusal is logged and read by a model), and an address is cut to its two ends.
 */
export function outgoingDisclosureFinding(value: unknown, context: DisclosureContext = {}): DisclosureFinding | null {
  const text = normalizedCommunication(value);
  if (SECRET_MATERIAL.test(text.replace(EXPLORER_TX_LINK, ' '))) return { code: 'social_secret_material_forbidden', excerpt: null };
  const internal = INTERNAL_REFERENCE.exec(text);
  if (internal) return { code: 'social_internal_reference_forbidden', excerpt: excerptOf(internal[0]) };
  // A word inside a link is the address of a page, not a word of the post ("…/x402-payments-on-base").
  const jargon = RUNTIME_JARGON.exec(text.replace(LINK, ' '));
  if (jargon) return { code: 'social_runtime_jargon_forbidden', excerpt: excerptOf(jargon[0]) };
  const number = SCIENTIFIC_NOTATION.exec(text);
  if (number) return { code: 'social_unreadable_number_forbidden', excerpt: excerptOf(number[0]) };
  if (context.publicAddresses) {
    const allowed = new Set(context.publicAddresses.map((a) => a.toLowerCase()));
    for (const match of text.matchAll(EVM_ADDRESS)) {
      if (!allowed.has(match[0])) return { code: 'social_private_address_forbidden', excerpt: shortAddress(match[0]) };
    }
  }
  return null;
}

/** Returns a disclosure code when the outgoing text must not be published, otherwise null. */
export function outgoingDisclosureRisk(value: unknown, context: DisclosureContext = {}): DisclosureCode | null {
  return outgoingDisclosureFinding(value, context)?.code ?? null;
}
