/**
 * Public text must not leak what the agent runs on. These deterministic guards
 * reject outgoing posts that carry secret material, internal infrastructure
 * references, runtime jargon from the agent loop, or on-chain addresses the
 * agent was not told it may publish. They complement the voice rules in the
 * system prompt: the model is asked to write for people, the gate makes sure
 * a slip never reaches X.
 */
import { normalizedCommunication } from './communication-policy.js';

export type DisclosureCode =
  | 'social_secret_material_forbidden'
  | 'social_internal_reference_forbidden'
  | 'social_runtime_jargon_forbidden'
  | 'social_private_address_forbidden';

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
    '\\ballowance\\b',
    '\\bsystem prompt\\b',
    '\\b(?:owner|bootr) rules?\\b',
    '\\bpending action\\b',
    '\\b(?:held|pending) (?:op|operation|effect)s?\\b',
    '\\buser ?ops?\\b',
    '\\bbundler\\b',
    '\\bpaymaster\\b',
    '\\bx402\\b',
    '\\bpermission id\\b',
    '\\bentry ?point\\b',
    '\\bagent card\\b',
  ].join('|'),
);

const EVM_ADDRESS = /0x[a-f0-9]{40}(?![a-f0-9])/g;

export interface DisclosureContext {
  /**
   * Addresses the agent may name in public (its own token, its own treasury).
   * `undefined` skips the address check for callers that do not know them.
   */
  publicAddresses?: readonly string[];
}

/** Returns a disclosure code when the outgoing text must not be published, otherwise null. */
export function outgoingDisclosureRisk(value: unknown, context: DisclosureContext = {}): DisclosureCode | null {
  const text = normalizedCommunication(value);
  if (SECRET_MATERIAL.test(text)) return 'social_secret_material_forbidden';
  if (INTERNAL_REFERENCE.test(text)) return 'social_internal_reference_forbidden';
  if (RUNTIME_JARGON.test(text)) return 'social_runtime_jargon_forbidden';
  if (context.publicAddresses) {
    const allowed = new Set(context.publicAddresses.map((a) => a.toLowerCase()));
    for (const match of text.matchAll(EVM_ADDRESS)) {
      if (!allowed.has(match[0])) return 'social_private_address_forbidden';
    }
  }
  return null;
}
