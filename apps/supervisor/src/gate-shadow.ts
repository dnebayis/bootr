/**
 * The shadow log of the publish gates (docs/design/agent-behaviour.md section 6.3 and measure M10): every new gate
 * runs in shadow first, which means it writes here what it would refuse and changes nothing. The weekly check counts
 * these rows per gate, 30 of them are read by hand, and a gate is enforced once fewer than one in ten was wrong. An
 * enforced gate keeps writing, with `enforced` true, so the count goes on after the switch.
 *
 * One helper, `logGateHit`, which every gate calls. It never throws and never slows a publish by more than one
 * insert: a row that cannot be written is a warning in the log and nothing else. A post found twice by the same gate
 * (a scheduled post is asked when it is scheduled and again when it is sent; a resumed step asks again) is one row.
 * Rows older than `GATE_SHADOW_KEEP_DAYS` are deleted by the said-ledger's hourly sweep (said.ts `sweepSaid`).
 */
import { createHash } from 'node:crypto';
import type { SupervisorContext } from './context.js';
import { gateShadow } from './db/schema.js';

/** The gates by their id in the design note: G1 repeat, G3 fee claims, G4 cross-agent, G5 number in evidence, G6 units. */
export type GateId = 'G1' | 'G3' | 'G4' | 'G5' | 'G6';
export type GateMode = 'enforce' | 'shadow' | 'off';

/** The setting of each gate (config.ts). */
const GATE_SETTING = { G1: 'REPEAT_GATE', G3: 'FEE_CLAIM_GATE', G4: 'CROSS_AGENT_GATE', G5: 'NUMBER_GATE', G6: 'UNITS_GATE' } as const;

/** The mode a gate runs in. A caller that holds only a part of the config (a test) gets the gate's default: `shadow`, and `enforce` for the fee claims. */
export function gateMode(ctx: { config?: Partial<Record<(typeof GATE_SETTING)[GateId], unknown>> | null }, gate: GateId): GateMode {
  const value = ctx.config?.[GATE_SETTING[gate]];
  if (value === 'enforce' || value === 'shadow' || value === 'off') return value;
  return gate === 'G3' ? 'enforce' : 'shadow';
}

/** approvals.ts `textHash`, repeated here so a gate does not import the review queue: sha256 of the text with its spacing and case folded. */
export function gateTextHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

export interface GateHit {
  agentId: string;
  gate: GateId;
  /** The head of the refusal: `repeat_fact`, `repeat_opener`, `repeat_record`, `fee_claim_false`, `similar_post`, `number_not_in_evidence`, `record_not_shown`, `unit_on_token_amount`. */
  code: string;
  /** The `sv_actions` row of the publish (for a scheduled post at its send, the id of the scheduled row); null when the caller has none. */
  actionId?: string | null;
  /** The text the gate read: one post, or one part of a thread. Only its hash is stored. */
  text: string;
  /** What the gate matched, for the person who reads the row: short, and never a whole post. */
  detail?: Record<string, unknown>;
  /** Whether the post was refused (`enforce`) or only would have been (`shadow`). */
  enforced: boolean;
}

/** The row's id: one per gate, agent, code, text and mode, so the same post found again adds nothing, and a text refused after the gate was enforced is a row of its own. */
export function gateHitId(hit: Pick<GateHit, 'agentId' | 'gate' | 'code' | 'enforced'>, textHash: string): string {
  return `gs_${createHash('sha256').update(`${hit.gate}\n${hit.agentId}\n${hit.code}\n${hit.enforced ? 'enforced' : 'shadow'}\n${textHash}`).digest('hex').slice(0, 32)}`;
}

/** Writes one row of `sv_gate_shadow`. Never throws; a context without a database (a test of a pure piece) writes nothing. */
export async function logGateHit(ctx: Partial<Pick<SupervisorContext, 'db' | 'now'>> & Pick<SupervisorContext, 'log'>, hit: GateHit): Promise<void> {
  try {
    if (!ctx.db) return;
    const textHash = gateTextHash(hit.text);
    await ctx.db
      .insert(gateShadow)
      .values({ id: gateHitId(hit, textHash), agentId: hit.agentId, gate: hit.gate, code: hit.code, actionId: hit.actionId ?? null, textHash, detail: hit.detail ?? {}, enforced: hit.enforced, createdAt: new Date(ctx.now ? ctx.now() : Date.now()) })
      .onConflictDoNothing();
  } catch (err) {
    ctx.log.warn({ agentId: hit.agentId, gate: hit.gate, code: hit.code, err: err instanceof Error ? err.message : String(err) }, 'gate shadow log: the row could not be written');
  }
}
