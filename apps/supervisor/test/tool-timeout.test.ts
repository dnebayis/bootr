import { describe, expect, it } from 'vitest';
import { parseAgentConfig } from '@bootr/agent-core';
import { ToolTimeoutError, executeAction, toolTimeoutMs, withToolTimeout, type BrokerEnv } from '../src/broker/index.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { agentConfig, makeWorld, seedAgent } from './helpers.js';

/**
 * Agents run one at a time, so one tool call that never answers (a web page that never ends, X or the sender hanging)
 * would hold every agent. Each call has a hard ceiling: a read fails, a write ends unknown and is settled from receipts.
 */

const pending = (id: string, tool: string, input: Record<string, unknown>) => ({ id, action: { tool, input }, status: 'bound', boundAt: 0 }) as unknown as Parameters<typeof executeAction>[3];
const env = (): BrokerEnv => ({ inbox: new Map(), eligibility: new Map() });
const mention = (postId: string, authorId: string, text: string): SenderInboxItem => ({
  postId,
  authorId,
  conversationId: postId,
  status: 'pending',
  observedAt: '2026-10-24T11:59:00Z',
  seenAt: null,
  deferredUntil: null,
  post: { id: postId, authorId, text, createdAt: '2026-10-24T11:58:00Z', conversationId: postId, author: { id: authorId, username: `user${authorId}`, verified: true, verifiedType: 'blue' } },
});
const never = <T>() => new Promise<T>(() => {});

describe('the ceiling on one tool call', () => {
  it('reads are cut at the read ceiling, writes and money at the long one, and never above the long one', () => {
    const c = { TOOL_TIMEOUT_MS: 180_000, TOOL_READ_TIMEOUT_MS: 60_000 };
    expect(toolTimeoutMs(c, 'read_url')).toBe(60_000);
    expect(toolTimeoutMs(c, 'read_x_account')).toBe(60_000);
    expect(toolTimeoutMs(c, 'publish_post')).toBe(180_000);
    expect(toolTimeoutMs(c, 'treasury_execute')).toBe(180_000);
    expect(toolTimeoutMs({ TOOL_TIMEOUT_MS: 30_000, TOOL_READ_TIMEOUT_MS: 60_000 }, 'read_url')).toBe(30_000);
  });

  it('a read tool that never answers fails as tool_timeout within its ceiling', async () => {
    const w = await makeWorld({ config: { TOOL_READ_TIMEOUT_MS: '1000', TOOL_TIMEOUT_MS: '5000' } });
    try {
      const agent = await seedAgent(w);
      const config = parseAgentConfig(agentConfig(w.ctx.now()));
      let fetched = 0;
      w.ctx.fetch = (() => {
        fetched += 1;
        return never<Response>();
      }) as typeof fetch;
      const started = Date.now();
      const out = await executeAction(w.ctx, agent, config, pending('a1', 'read_url', { url: 'https://example.com/a-page-that-never-ends' }), env());
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(fetched).toBe(1);
      expect(out.kind).toBe('failed');
      expect((out as { error: string }).error).toMatch(/^tool_timeout: read_url gave no answer within 1 s/);
    } finally {
      await w.close();
    }
  });

  it('a publish that never answers ends unknown, not failed, since the post may still land', async () => {
    const w = await makeWorld({ config: { TOOL_READ_TIMEOUT_MS: '5000', TOOL_TIMEOUT_MS: '1000' } });
    try {
      const agent = await seedAgent(w);
      const config = parseAgentConfig(agentConfig(w.ctx.now()));
      w.sender.items = [mention('1001', '42', '@bootr_agent what is your plan?')];
      const e = env();
      expect((await executeAction(w.ctx, agent, config, pending('a1', 'read_mentions', {}), e)).kind).toBe('completed');
      w.ctx.sender.publish = () => never();
      const started = Date.now();
      const out = await executeAction(w.ctx, agent, config, pending('a2', 'publish_reply', { postId: '1001', text: 'Here is the plan.' }), e);
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(out.kind).toBe('unknown');
      expect((out as { error: string }).error).toMatch(/^tool_timeout: publish_reply/);
    } finally {
      await w.close();
    }
  });

  it('a late answer or failure after the ceiling is dropped quietly', async () => {
    const lateFailure = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('late')), 20));
    await expect(withToolTimeout(lateFailure, 'read_url', 5)).rejects.toBeInstanceOf(ToolTimeoutError);
    const lateResult = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 20));
    await expect(withToolTimeout(lateResult, 'read_url', 5)).rejects.toThrow(/tool_timeout: read_url/);
    await new Promise((r) => setTimeout(r, 40));
    // ...and a prompt answer is passed through unchanged.
    expect(await withToolTimeout(Promise.resolve(7), 'read_url', 1_000)).toBe(7);
  });
});
