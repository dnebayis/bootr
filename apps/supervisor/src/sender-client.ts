import type { XPost } from '@bootr/agent-core';
import { signedFetch } from './hmac.js';

export interface SenderInboxItem {
  postId: string;
  authorId: string;
  conversationId: string;
  status: string;
  reason?: string | null;
  observedAt: string | number;
  deferredUntil?: string | number | null;
  seenAt?: string | number | null;
  post: XPost;
}

export interface SenderMentions {
  throttled: boolean;
  nextReadAt?: string;
  fetched?: number;
  sinceId?: string;
  items: SenderInboxItem[];
}

export interface SenderReceipt {
  actionId: string;
  agentId: string;
  kind: string;
  status: 'pending' | 'sent' | 'held' | 'rejected';
  providerPostId?: string | null;
  bodyHash?: string;
  attempts?: number;
  error?: string | null;
  createdAt?: string;
  sentAt?: string | null;
  signature?: string;
}

export interface SenderPublishResponse {
  status: 'sent' | 'held' | 'rejected' | 'pending';
  providerPostId?: string | null;
  receipt: SenderReceipt;
  duplicate?: boolean;
}

export interface SenderAccount {
  agentId: string;
  connected: boolean;
  revoked: boolean;
  handle?: string | null;
  xUserId?: string | null;
  scopes?: string;
  expiresAt?: string;
  connectedAt?: string | null;
}

export interface SenderRebind {
  from: string;
  to: string;
  status: 'moved' | 'already';
  handle: string | null;
}

/** agent-core `replyEligibility` outcome for a mention, as the sender expects it. */
export interface ReplyEligibility {
  eligible: boolean;
  reason?: string;
}

export class SenderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
    /** The request did not reach X / nothing was recorded; the same actionId may be retried later. */
    readonly retryable: boolean,
    readonly retryAt?: number,
  ) {
    super(`sender ${status} ${code}`);
    this.name = 'SenderError';
  }
}

/** HMAC client for apps/sender's internal API. Idempotent per `actionId`; never resends held publishes. */
export class SenderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await signedFetch(this.fetchImpl, this.key, this.baseUrl, method, path, body);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (res.ok) return json as T;
    const code = (json as { error?: string } | null)?.error ?? `http_${res.status}`;
    const retryable = res.status === 429 || res.status === 503 || (res.status === 409 && (code === 'not_connected' || code === 'revoked'));
    const retryAtRaw = (json as { retryAt?: string | number } | null)?.retryAt;
    const retryAt = typeof retryAtRaw === 'string' ? Date.parse(retryAtRaw) : typeof retryAtRaw === 'number' ? retryAtRaw : undefined;
    throw new SenderError(res.status, code, json, retryable, retryAt);
  }

  /**
   * Publishes an original post or a reply. A reply must carry the agent-core `replyEligibility` decision for
   * `replyTo` (the sender rejects replies without it: `policy:reply_not_eligible:<reason>`); the sender also rejects
   * replies whose target author or any @mentioned user opted out (`policy:mention_opted_out`,
   * `policy:reply_target_unavailable`) and answers 429/503 `consent_lookup_failed` when X cannot be reached for the
   * consent check (nothing sent; retryable with the same actionId).
   */
  publish(body: {
    agentId: string;
    actionId: string;
    text: string;
    replyTo?: string;
    replyAuthorId?: string;
    replyEligibility?: ReplyEligibility;
    attributions?: { username: string; sourceUrl: string }[];
    /** Addresses the text may name (own token, own treasury); the sender rejects any other. */
    publicAddresses?: string[];
    /** The X user the agent config expects; the sender refuses to post as any other account (409 account_mismatch). */
    xUserId?: string;
  }) {
    return this.call<SenderPublishResponse>('POST', '/internal/publish', body);
  }

  receipt(actionId: string) {
    return this.call<{ receipt: SenderReceipt } | SenderReceipt>('GET', `/internal/receipt/${encodeURIComponent(actionId)}`).then((r) =>
      'receipt' in r && r.receipt ? r.receipt : (r as SenderReceipt),
    );
  }

  readMentions(agentId: string, sinceId?: string) {
    return this.call<SenderMentions>('POST', '/internal/read/mentions', { agentId, ...(sinceId ? { sinceId } : {}) });
  }

  readThread(agentId: string, postId: string) {
    return this.call<{ posts: XPost[]; truncated: boolean }>('POST', '/internal/read/thread', { agentId, postId });
  }

  readAccount(agentId: string, username: string) {
    return this.call<{ user: Record<string, unknown> }>('POST', '/internal/read/account', { agentId, username });
  }

  resolve(body: { agentId: string; postId: string; outcome: 'skip' | 'opt_out' | 'defer'; reason: string; reviewAt?: string }) {
    return this.call<Record<string, unknown>>('POST', '/internal/inbox/resolve', body);
  }

  account(agentId: string) {
    return this.call<SenderAccount>('GET', `/internal/account/${encodeURIComponent(agentId)}`);
  }

  /**
   * Moves the X account connected under a launch draft id to the real agent id. Idempotent; 404 when neither id
   * has an account, 409 when the target already has one or (with `connectedBefore`) the account is newer.
   */
  rebind(fromAgentId: string, toAgentId: string, connectedBefore?: string) {
    return this.call<SenderRebind>('POST', `/internal/account/${encodeURIComponent(fromAgentId)}/rebind`, {
      to: toAgentId,
      ...(connectedBefore ? { connectedBefore } : {}),
    });
  }

  metering(agentId: string, month: string) {
    return this.call<Record<string, unknown>>('GET', `/internal/metering/${encodeURIComponent(agentId)}?month=${encodeURIComponent(month)}`);
  }
}
