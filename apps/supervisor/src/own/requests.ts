/**
 * Own agents (docs/design/byo-agent.md sections 5.3 and 13.9): `answer_request`, the special tool that closes one of
 * the creator's requests from an own agent's social or treasury turn.
 *
 * Requests are filed by the hosted chat alone (chat.ts; an own coin has no chat). What was open when a coin switched to
 * its own agent is still a row of `sv_memories`, so the existing sections show it (`creatorRequestsSection`, through
 * `buildFirstObservation` for the social turn and `buildTreasuryObservation` for the treasury one) and the turn keeps
 * the ids in `Turn.creatorRequests`, as a hosted turn does. This tool is offered while that list is not empty and
 * hands the call to the hosted `answerRequest` unchanged: the request must be one this turn was shown, `done` needs an
 * action of this turn that is not a read, and a request closes once. Nothing is published by it and it makes no action
 * row.
 */
import type { AgentConfig } from '@bootr/agent-core';
import { ANSWER_REQUEST_TOOL_NAME, answerRequest, answerRequestInputSchema, type RequestTurnState } from '../creator-requests.js';
import type { Turn } from '../runtime.js';
import type { OwnCall, OwnSpecialTool } from './registry.js';

type Answer = Awaited<ReturnType<OwnSpecialTool['run']>>;

/** The refusal as the hosted model reads it (`{error: 'invalid_tool_call', detail}`), in one line. */
function refusalOf(messages: RequestTurnState['messages']): string {
  const content = messages.at(-1)?.content;
  try {
    const body = JSON.parse(typeof content === 'string' ? content : '{}') as { error?: unknown; detail?: unknown };
    return `${typeof body.error === 'string' ? body.error : 'invalid_tool_call'}: ${typeof body.detail === 'string' ? body.detail : 'the request could not be answered'}`;
  } catch {
    return 'invalid_tool_call: the request could not be answered';
  }
}

export const answerRequestTool: OwnSpecialTool = {
  name: ANSWER_REQUEST_TOOL_NAME,
  roles: ['social', 'treasury'],
  input: answerRequestInputSchema,
  /** While the turn still holds a request it was shown; never in a judge turn, which sees a job and nothing else. */
  offered(turn: Turn, _config: AgentConfig): boolean {
    return (turn.role ?? 'social') !== 'judge' && !!turn.creatorRequests?.length;
  },
  async run(call: OwnCall, turn: Turn, input: unknown): Promise<Answer> {
    try {
      if ((turn.role ?? 'social') === 'judge' || !turn.creatorRequests?.length) return { status: 'failed', error: 'invalid_tool_call: this turn holds no open request of your creator' };
      // The hosted function writes its answer into the conversation it is given. An own turn keeps no conversation on
      // the server (`messages` stays empty), so it gets a scratch one; the step summary and the request list are the turn's own.
      const scratch: RequestTurnState = { startedAt: turn.startedAt, messages: [], recentSteps: turn.recentSteps, creatorRequests: turn.creatorRequests };
      const outcome = await answerRequest(call.ctx, call.agent.agentId, scratch, { id: 'own', name: ANSWER_REQUEST_TOOL_NAME, input });
      // `answerRequest` drops a request it closed (or found closed) from the list it was given: the turn keeps what is left.
      if (scratch.creatorRequests?.length) turn.creatorRequests = scratch.creatorRequests;
      else delete turn.creatorRequests;
      if (outcome !== 'answered') return { status: 'failed', error: refusalOf(scratch.messages) };
      const { requestId, outcome: answered } = answerRequestInputSchema.parse(input);
      return { status: 'completed', result: { requestId, outcome: answered, closed: true } };
    } catch (err) {
      call.ctx.log.warn({ agentId: call.agent.agentId, tool: ANSWER_REQUEST_TOOL_NAME, err }, 'own agent: answer_request failed');
      return { status: 'failed', error: 'answer_request_failed: the answer could not be stored; try once more' };
    }
  },
};
