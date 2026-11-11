/**
 * Economy mode (`config.routing.decideModel`): most steps of a turn read and decide (mentions, feed, memory,
 * research); only the last ones write. With the mode on, a turn starts on the cheaper decide model with the
 * publishing tools replaced by `draft_intent`. When the decide model calls it, the rest of the turn runs on
 * `config.model` (the writer): the intent comes back as a tool result ("you decided to write this; now write it"),
 * the real publishing tools and `generate_image` return, `draft_intent` goes away. A turn that never calls
 * `draft_intent` (nothing to say, only memory or treasury work) finishes entirely on the cheap model. The step
 * budget (`MAX_TOOL_STEPS`) is one counter across both phases. The phase lives on the persisted `Turn`
 * (`turn.routing`), so a continued turn resumes in the phase it was in. runtime.ts only calls into here.
 */
import {
  DRAFT_INTENT_TOOL,
  DRAFT_INTENT_TOOL_NAME,
  PUBLISHING_TOOLS,
  buildSystemPrompt,
  draftIntentInputSchema,
  postLimitsFor,
  type AgentConfig,
  type ChatMessage,
  type DraftIntent,
  type ModelTool,
  type RoutingPhase,
  type ToolDefinition,
} from '@bootr/agent-core';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { TurnRequest } from './creator-requests.js';
import type { InferenceResult } from './inference.js';

export interface RoutingState {
  phase: RoutingPhase;
  /** The cheap model of the decide phase (the writer is `config.model`). */
  decideModel: string;
  /** What the decide model asked the writer to write; set on the switch. */
  intent: DraftIntent | null;
  /** Paid steps per phase, for the turn log and the creator's savings. */
  steps: { decide: number; write: number };
}

/** Tools only the writer gets: the publishing tools and the picture that goes with a post. */
const WRITER_ONLY: readonly string[] = [...PUBLISHING_TOOLS, 'generate_image'];

/** The decide model in force, or null when economy mode is off (unset, null, or the same model as the writer). */
export function decideModelOf(config: Pick<AgentConfig, 'model' | 'routing'>): string | null {
  const m = config.routing?.decideModel ?? null;
  return m && m !== config.model ? m : null;
}

/** The routing state a fresh turn starts with; null when economy mode is off. */
export function startRouting(config: Pick<AgentConfig, 'model' | 'routing'>): RoutingState | null {
  const decideModel = decideModelOf(config);
  return decideModel ? { phase: 'decide', decideModel, intent: null, steps: { decide: 0, write: 0 } } : null;
}

export function phaseOf(routing: RoutingState | null | undefined): RoutingPhase | null {
  return routing?.phase ?? null;
}

/** The model the next step is paid on. */
export function modelFor(config: Pick<AgentConfig, 'model'>, routing: RoutingState | null | undefined): string {
  return routing?.phase === 'decide' ? routing.decideModel : config.model;
}

/**
 * The function set of the current phase. Decide: the catalog minus the writer-only tools, plus `draft_intent` when
 * at least one publishing tool is open (with both paused there is nothing to decide about). Write, or mode off: the
 * catalog as is.
 */
export function toolsForPhase(routing: RoutingState | null | undefined, tools: readonly ToolDefinition[]): ModelTool[] {
  if (routing?.phase !== 'decide') return [...tools];
  const canPublish = tools.some((t) => (PUBLISHING_TOOLS as readonly string[]).includes(t.name));
  const kept: ModelTool[] = tools.filter((t) => !WRITER_ONLY.includes(t.name));
  return canPublish ? [...kept, DRAFT_INTENT_TOOL] : kept;
}

export interface RoutedTurn {
  messages: ChatMessage[];
  recentSteps: { tool: string; status: string; summary: string }[];
  routing?: RoutingState | null;
  /** The account's Premium flag (runtime.ts `Turn.premium`): the writer's prompt names the same post limit as the first one. */
  premium?: boolean | null;
  /** The open creator requests this turn was shown (creator-requests.ts): an intent may name one by `requestId`. */
  creatorRequests?: TurnRequest[];
  /** The picture section of this turn said `suggested` (picture-hint.ts): the writer of a post is told to make one. */
  pictureSuggested?: boolean;
}

/**
 * The picture the writer is told to make, or null: the intent's own `picture`, else (for a post) the picture section's
 * suggestion or a creator request for a picture that the intent names. Only while `generate_image` is in the catalog.
 */
export function writerPicture(turn: Pick<RoutedTurn, 'creatorRequests' | 'pictureSuggested'>, intent: DraftIntent, tools: readonly { name: string }[]): { brief: string | null; why: string } | null {
  if (!tools.some((t) => t.name === 'generate_image')) return null;
  if (intent.picture) return { brief: intent.picture.brief, why: 'you planned one' };
  if (intent.kind !== 'post') return null;
  if (intent.requestId && turn.creatorRequests?.some((r) => r.id === intent.requestId && r.picture)) return { brief: null, why: 'your creator asked for one' };
  if (turn.pictureSuggested) return { brief: null, why: 'the picture section suggests one' };
  return null;
}

function toolMessage(toolCallId: string, content: unknown): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(content) };
}

/**
 * The decide model's `draft_intent` call. Returns null when the call is anything else (or the turn is not in the
 * decide phase), so the caller treats it as an ordinary action. Otherwise the call is consumed here: a valid intent
 * switches the turn to the writer (system prompt, tools and model change from the next step on) and answers the
 * call with the intent restated; an invalid one is answered with the validation error and the phase stays.
 */
export function handleIntent(config: AgentConfig, turn: RoutedTurn, tools: readonly ToolDefinition[], call: { id: string; name: string; input: unknown }): 'switched' | 'invalid' | null {
  const routing = turn.routing;
  if (!routing || routing.phase !== 'decide' || call.name !== DRAFT_INTENT_TOOL_NAME) return null;
  let intent: DraftIntent;
  try {
    intent = draftIntentInputSchema.parse(call.input);
    const needed = intent.kind === 'reply' ? 'publish_reply' : 'publish_post';
    if (!tools.some((t) => t.name === needed)) throw new Error(`${intent.kind === 'reply' ? 'replies' : 'original posts'} are not available this turn; resolve or finish instead`);
    if (intent.requestId && !turn.creatorRequests?.some((r) => r.id === intent.requestId)) throw new Error(`${intent.requestId} is not an open creator request of this turn`);
  } catch (err) {
    const detail = err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : String(err);
    turn.messages.push(toolMessage(call.id, { error: 'invalid_tool_call', detail }));
    turn.recentSteps.push({ tool: DRAFT_INTENT_TOOL_NAME, status: 'invalid', summary: detail.slice(0, 200) });
    return 'invalid';
  }
  routing.phase = 'write';
  routing.intent = intent;
  const system = turn.messages[0];
  if (system && system.role === 'system') system.content = buildSystemPrompt(config, 'social', { phase: 'write', postLimit: postLimitsFor(turn.premium ?? null).original });
  const tool = intent.kind === 'reply' ? 'publish_reply' : 'publish_post';
  const picture = writerPicture(turn, intent, tools);
  const pictureNote = picture
    ? ` Make the picture first (${picture.why}): call generate_image with ${picture.brief ? 'a prompt from intent.picture.brief' : 'a prompt of your own that fits the post'} and a plain alt text, then pass its imageId to ${tool}. Never a real person, another project's logo, a chart, a price or a number. If generate_image fails, publish the words without it.`
    : '';
  const requestNote = intent.requestId ? ` This fulfils your creator's request ${intent.requestId}; it is marked done when the ${intent.kind} goes out.` : '';
  turn.messages.push(
    toolMessage(call.id, {
      decided: true,
      intent,
      ...(picture ? { picture: { make: true, brief: picture.brief, why: picture.why } } : {}),
      note: `You decided to write this; now write it. From this step on you have ${tool} and the other publishing tools${picture ? ', and generate_image' : ''}; draft_intent is gone.${pictureNote} Write the one ${intent.kind} described in intent.about, in your own voice, from the facts gathered in this turn, then finish.${requestNote}`,
    }),
  );
  turn.recentSteps.push({ tool: DRAFT_INTENT_TOOL_NAME, status: 'completed', summary: `${intent.kind}${intent.target ? ` to ${intent.target}` : ''}: ${intent.about}`.slice(0, 200) });
  return 'switched';
}

/**
 * One line per paid step with the model it ran on, so the log shows the split (the same model is on the
 * `sv_inference` row's request, which `thoughtsByModel` in inference.ts sums for the creator).
 */
export function logThought(log: Logger, routing: RoutingState | null | undefined, step: number, model: string, inf: InferenceResult): void {
  const phase = phaseOf(routing);
  if (routing && phase) routing.steps[phase] += 1;
  const receipt = inf.kind === 'ok' ? inf.receipt : null;
  log.info(
    {
      step,
      model,
      phase,
      key: inf.key,
      outcome: inf.kind,
      ...(inf.kind === 'ok' ? { replayed: inf.replayed, tool: inf.toolCall?.name ?? null, ...(inf.truncated ? { truncated: true } : {}) } : {}),
      ...(receipt ? { chargedMicroUsdc: receipt.chargedMicroUsdc, quoteMicroUsdc: receipt.quoteMicroUsdc } : {}),
    },
    'thought',
  );
}
