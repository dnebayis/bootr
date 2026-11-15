/**
 * The platform account's voice applied to what it is about to publish (owner's decision of 2026-11-14: lowercase, no
 * emoji). The prompt asks for it (`PLATFORM_RULES`, `PLATFORM_IDENTITY_LINES`); this makes it certain for every text
 * the model writes, at the one point a tool call becomes an action, so the gate, the review queue, the record and X
 * all see the same text and no post is refused or bought twice over a capital letter. Posts written by code (a bounty
 * job, a payout notice) do not pass here. `PLATFORM_PLAIN_VOICE=false` switches it off.
 *
 * At the same point, for every agent and whatever that setting: a cashtag written twice keeps its `$` only the first
 * time (agent-core `oneCashtag`), each part of a thread by itself, so a post that names its one coin twice is not
 * refused for it.
 */
import { oneCashtag, plainVoice, type Action } from '@bootr/agent-core';
import type { AgentRow, SupervisorContext } from './context.js';

export function voicedAction(ctx: Pick<SupervisorContext, 'config'>, agent: Pick<AgentRow, 'config'>, action: Action): Action {
  const voiced = (agent.config as Record<string, unknown>).platform === true && ctx.config.PLATFORM_PLAIN_VOICE !== false;
  const fix = (text: string): string => (voiced ? plainVoice(oneCashtag(text)) : oneCashtag(text));
  if (action.tool === 'publish_reply') {
    const text = fix(action.input.text);
    return text === action.input.text ? action : { ...action, input: { ...action.input, text } };
  }
  if (action.tool === 'publish_post' || action.tool === 'schedule_post') {
    const text = fix(action.input.text);
    const thread = action.input.thread?.map((part) => ({ ...part, text: fix(part.text) }));
    if (text === action.input.text && (thread ?? []).every((part, i) => part.text === action.input.thread![i]!.text)) return action;
    return { ...action, input: { ...action.input, text, ...(thread ? { thread } : {}) } } as Action;
  }
  return action;
}
