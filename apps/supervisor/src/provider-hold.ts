/**
 * A global hold while the model provider is down. Each agent already backs off after its own inference failure
 * (`AgentState.inferenceRetryAt`, runtime.ts), but an outage upstream of the relay (the 2026-11-08 403s, a 5xx run,
 * the relay unreachable) is the same for every agent, and each one still paid for its own doomed first attempt. Like
 * the X credits hold (rhythm.ts `creditsHold`), this is one signal for the whole fleet: when `PROVIDER_OUTAGE_AGENTS`
 * distinct agents fail with an outage-shaped error inside `PROVIDER_OUTAGE_WINDOW_MS`, every agent's next thought waits
 * until the hold ends (runtime.ts checks it right before buying one and sets the agent's own `inferenceRetryAt` to it,
 * so tick.ts wakes nothing for free). One success anywhere clears it. In-process state: the supervisor runs as one
 * process, and a restart simply starts counting again.
 */

/** Distinct agents failing the same way inside the window before everyone waits. */
export const PROVIDER_OUTAGE_AGENTS = 2;
export const PROVIDER_OUTAGE_WINDOW_MS = 10 * 60_000;
/** How long the fleet waits before one agent tries again (and either clears the hold or extends it). */
export const PROVIDER_HOLD_MS = 10 * 60_000;

/**
 * Errors that mean the provider, the relay or the route to them is down, as every agent would see it: the provider
 * refusing the relay's account (401/403), rate limits, 5xx, the relay or BlockRun unreachable, a timeout. Not here:
 * an agent's own trouble (an empty float, a refused payment, a request too large, a credit exhausted for one key).
 */
const OUTAGE = /\b(?:upstream_rejected|upstream_failed(?:_credited)?|upstream_unavailable|http_(?:401|403|408|429|5\d\d)|relay_unreachable|direct_unavailable|direct_failed_unpaid|facilitator_unavailable)\b|TimeoutError|ECONNREFUSED|ECONNRESET|fetch failed/i;

export function isProviderOutage(error: string | null | undefined): boolean {
  // A model BlockRun does not know (`direct_unavailable: model_missing: ...`) is that agent's configuration, not an outage.
  return !!error && !/\bmodel_missing\b/.test(error) && OUTAGE.test(error);
}

export interface ProviderHold {
  reason: 'provider_down';
  until: number;
  /** The error that tripped it, for the log and the agent's `lastError`. */
  error: string;
  message: string;
}

interface HoldState {
  failures: { agentId: string; at: number; error: string }[];
  hold: ProviderHold | null;
}

let state: HoldState = { failures: [], hold: null };

function message(until: number, error: string): string {
  return `provider_down: the model provider is failing for every agent (${error}); no thoughts are bought until ${new Date(until).toISOString()}`;
}

/**
 * Records one agent's inference failure. Returns the hold in force afterwards: a new one when this failure is the
 * `PROVIDER_OUTAGE_AGENTS`th distinct agent inside the window, the running one extended while it lasts, else null.
 */
export function noteInferenceFailure(agentId: string, error: string, now: number): ProviderHold | null {
  if (!isProviderOutage(error)) return providerHold(now);
  state.failures = state.failures.filter((f) => f.at > now - PROVIDER_OUTAGE_WINDOW_MS);
  state.failures.push({ agentId, at: now, error });
  const distinct = new Set(state.failures.map((f) => f.agentId)).size;
  const running = providerHold(now);
  if (distinct >= PROVIDER_OUTAGE_AGENTS || running) {
    const until = now + PROVIDER_HOLD_MS;
    state.hold = { reason: 'provider_down', until, error, message: message(until, error) };
  }
  return state.hold && state.hold.until > now ? state.hold : null;
}

/** One thought answered: the provider is back, every agent may think again. */
export function noteInferenceSuccess(): void {
  state = { failures: [], hold: null };
}

/** The hold in force, or null. */
export function providerHold(now: number): ProviderHold | null {
  return state.hold && state.hold.until > now ? state.hold : null;
}

/** For tests. */
export function resetProviderHold(): void {
  state = { failures: [], hold: null };
}
