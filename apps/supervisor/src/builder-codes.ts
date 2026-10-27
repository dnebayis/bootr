/**
 * Base Builder Codes (https://docs.base.org/specifications/builder-codes/for-agent-developers).
 *
 * Every agent kernel registers its own code with an unauthenticated
 * `POST BUILDER_CODES_URL { walletAddress }` (idempotent: the same wallet always gets the same code).
 * The code is stored in `sv_agents.builder_code` and appended to every session userOp's callData as an
 * ERC-8021 suffix (`codes ‖ codesLength ‖ schemaId ‖ 0x8021…` marker), which the Kernel, BootrCallPolicy
 * and the guardian hook ignore and indexers read. Registration failures are logged at warn and never
 * block onboarding; `backfillBuilderCodes` retries on later ticks.
 */
import { eq, isNull, and, inArray } from 'drizzle-orm';
import * as Attribution from 'ox/erc8021/Attribution';
import type { Address, Hex } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { agents } from './db/schema.js';

export const BUILDER_CODES_TIMEOUT_MS = 10_000;

/** ASCII, no comma (ERC-8021 separates codes with commas), bounded so the 1-byte length field cannot overflow. */
const BUILDER_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function isValidBuilderCode(code: unknown): code is string {
  return typeof code === 'string' && BUILDER_CODE_RE.test(code);
}

/** ERC-8021 schema-0 calldata suffix for one builder code (ends with the 16-byte `0x8021…` marker). */
export function attributionSuffix(builderCode: string): Hex {
  if (!isValidBuilderCode(builderCode)) throw new Error(`invalid builder code: ${JSON.stringify(builderCode)}`);
  return Attribution.toDataSuffix({ codes: [builderCode] });
}

export class BuilderCodeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BuilderCodeError';
  }
}

/** Registers (or re-fetches) the builder code for `walletAddress`. Throws on any failure. */
export async function fetchBuilderCode(
  walletAddress: Address,
  opts: { url: string; fetch: typeof fetch; timeoutMs?: number },
): Promise<string> {
  const res = await opts.fetch(opts.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ walletAddress }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? BUILDER_CODES_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new BuilderCodeError(`builder code registration failed: HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BuilderCodeError(`builder code registration returned non-JSON: ${text.slice(0, 200)}`, res.status);
  }
  const code = (body as { builderCode?: unknown } | null)?.builderCode;
  if (!isValidBuilderCode(code)) throw new BuilderCodeError(`builder code registration returned no usable builderCode: ${text.slice(0, 200)}`, res.status);
  const returned = (body as { walletAddress?: unknown }).walletAddress;
  if (typeof returned === 'string' && returned.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new BuilderCodeError(`builder code registration answered for another wallet: ${returned}`, res.status);
  }
  return code;
}

/**
 * Registers the agent kernel's builder code and stores it. Returns the code, or `null` when disabled
 * or when the registration failed (logged at warn; never throws).
 */
export async function ensureBuilderCode(ctx: SupervisorContext, agent: Pick<AgentRow, 'agentId' | 'kernel' | 'builderCode'>): Promise<string | null> {
  if (!ctx.config.BUILDER_CODES_ENABLED) return null;
  if (agent.builderCode) return agent.builderCode;
  const log = ctx.log.child({ agentId: agent.agentId, kernel: agent.kernel });
  let code: string;
  try {
    code = await fetchBuilderCode(agent.kernel as Address, { url: ctx.config.BUILDER_CODES_URL, fetch: ctx.fetch });
  } catch (err) {
    log.warn({ err, url: ctx.config.BUILDER_CODES_URL }, 'builder code registration failed; will retry on a later tick');
    return null;
  }
  await ctx.db.update(agents).set({ builderCode: code, updatedAt: new Date(ctx.now()) }).where(eq(agents.agentId, agent.agentId));
  log.info({ builderCode: code }, 'builder code registered');
  return code;
}

/** Retries registration for agents that still have no builder code (bounded per tick). */
export async function backfillBuilderCodes(ctx: SupervisorContext, limit = ctx.config.MAX_AGENTS_PER_TICK): Promise<number> {
  if (!ctx.config.BUILDER_CODES_ENABLED) return 0;
  const rows = await ctx.db
    .select({ agentId: agents.agentId, kernel: agents.kernel, builderCode: agents.builderCode })
    .from(agents)
    .where(and(isNull(agents.builderCode), inArray(agents.status, ['onboarding', 'active'])))
    .limit(limit);
  let registered = 0;
  for (const row of rows) if (await ensureBuilderCode(ctx, row)) registered += 1;
  return registered;
}
