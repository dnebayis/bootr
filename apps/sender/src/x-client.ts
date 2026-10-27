/**
 * Fetch-based X API v2 client (user-context bearer tokens).
 *
 * - Never logs or echoes tokens.
 * - Every failure is mapped to `XError.definite`: `true` means X certainly did NOT perform the
 *   request (4xx, request never left the process); `false` means the outcome is unknown
 *   (timeout, network error, 5xx, malformed 2xx). For writes, `definite: false` must lead to
 *   `held`, never to a resend.
 * - 429 responses honour `x-rate-limit-reset`: the endpoint is cooled down until reset and, for
 *   reads only, retried once if the wait is short.
 */

export interface XError {
  definite: boolean;
  status?: number;
  code: string;
  message: string;
  /** Epoch ms when a rate limit resets. */
  retryAt?: number;
}

export type XResult<T> = { ok: true; status: number; data: T } | { ok: false; error: XError };

export interface XTweet {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: { type: 'replied_to' | 'quoted' | 'retweeted'; id: string }[];
  entities?: {
    urls?: {
      start: number;
      end: number;
      url: string;
      expanded_url?: string;
      display_url?: string;
    }[];
    mentions?: { start: number; end: number; username: string; id?: string }[];
  };
  note_tweet?: { text: string; entities?: XTweet['entities'] };
  public_metrics?: Record<string, number>;
}

export interface XUser {
  id: string;
  username: string;
  name?: string;
  verified?: boolean;
  verified_type?: string;
  description?: string;
  created_at?: string;
  protected?: boolean;
  public_metrics?: Record<string, number>;
}

export interface XListResponse {
  data?: XTweet[];
  includes?: { users?: XUser[]; tweets?: XTweet[] };
  meta?: { newest_id?: string; oldest_id?: string; result_count?: number; next_token?: string };
  errors?: unknown[];
}

export const TWEET_FIELDS =
  'author_id,conversation_id,created_at,entities,in_reply_to_user_id,referenced_tweets,note_tweet,public_metrics';
export const USER_FIELDS = 'username,verified,verified_type';

export interface XClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Max time a READ waits for a 429 reset before retrying once. */
  maxRateLimitWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | undefined>;

export class XClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxWait: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** endpoint key -> epoch ms until which we do not call it again. */
  private readonly cooldown = new Map<string, number>();

  constructor(opts: XClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.x.com').replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxWait = opts.maxRateLimitWaitMs ?? 5_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  createPost(
    token: string,
    body: { text: string; replyTo?: string | null },
  ): Promise<XResult<{ data?: { id?: string; text?: string } }>> {
    const payload: Record<string, unknown> = { text: body.text };
    if (body.replyTo) payload.reply = { in_reply_to_tweet_id: body.replyTo };
    return this.request(token, 'POST', '/2/tweets', {
      body: payload,
      write: true,
      rateKey: 'post',
    });
  }

  me(token: string): Promise<XResult<{ data?: XUser }>> {
    return this.request(token, 'GET', '/2/users/me', { query: { 'user.fields': USER_FIELDS } });
  }

  mentions(
    token: string,
    userId: string,
    opts: { sinceId?: string; paginationToken?: string; maxResults?: number },
  ): Promise<XResult<XListResponse>> {
    return this.request(token, 'GET', `/2/users/${encodeURIComponent(userId)}/mentions`, {
      rateKey: 'mentions',
      query: {
        since_id: opts.sinceId,
        pagination_token: opts.paginationToken,
        max_results: opts.maxResults ?? 100,
        'tweet.fields': TWEET_FIELDS,
        expansions: 'author_id,referenced_tweets.id',
        'user.fields': USER_FIELDS,
      },
    });
  }

  userTimeline(
    token: string,
    userId: string,
    opts: { startTime: string; endTime: string; paginationToken?: string },
  ): Promise<XResult<XListResponse>> {
    return this.request(token, 'GET', `/2/users/${encodeURIComponent(userId)}/tweets`, {
      rateKey: 'timeline',
      query: {
        start_time: opts.startTime,
        end_time: opts.endTime,
        pagination_token: opts.paginationToken,
        max_results: 100,
        'tweet.fields': TWEET_FIELDS,
      },
    });
  }

  getPost(
    token: string,
    id: string,
  ): Promise<XResult<{ data?: XTweet; includes?: { users?: XUser[] } }>> {
    return this.request(token, 'GET', `/2/tweets/${encodeURIComponent(id)}`, {
      rateKey: 'tweet',
      query: {
        'tweet.fields': TWEET_FIELDS,
        expansions: 'author_id',
        'user.fields': USER_FIELDS,
      },
    });
  }

  userByUsername(token: string, username: string): Promise<XResult<{ data?: XUser }>> {
    return this.request(token, 'GET', `/2/users/by/username/${encodeURIComponent(username)}`, {
      rateKey: 'user',
      query: {
        'user.fields': `${USER_FIELDS},name,description,created_at,protected,public_metrics`,
      },
    });
  }

  async request<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Query; body?: unknown; write?: boolean; rateKey?: string } = {},
  ): Promise<XResult<T>> {
    const rateKey = `${opts.rateKey ?? path}:${tokenFingerprint(token)}`;
    const blockedUntil = this.cooldown.get(rateKey);
    if (blockedUntil !== undefined && blockedUntil > this.now()) {
      if (opts.write || blockedUntil - this.now() > this.maxWait) {
        return { ok: false, error: rateLimited(blockedUntil) };
      }
      await this.sleep(blockedUntil - this.now());
    }

    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const timeout =
          err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        return {
          ok: false,
          error: {
            definite: false,
            code: timeout ? 'timeout' : 'network_error',
            message: timeout ? 'X request timed out' : 'X request failed before a response',
          },
        };
      }

      if (res.status === 429) {
        const reset = Number(res.headers.get('x-rate-limit-reset'));
        const retryAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : this.now() + 60_000;
        this.cooldown.set(rateKey, retryAt);
        const wait = retryAt - this.now();
        if (!opts.write && attempt === 0 && wait <= this.maxWait) {
          await this.sleep(Math.max(0, wait));
          continue;
        }
        return { ok: false, error: rateLimited(retryAt) };
      }

      const text = await res.text().catch(() => '');
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (res.ok) {
        if (json === undefined) {
          return {
            ok: false,
            error: {
              definite: false,
              status: res.status,
              code: 'malformed_response',
              message: 'unparseable 2xx body',
            },
          };
        }
        return { ok: true, status: res.status, data: json as T };
      }

      // 408 and 5xx: X may or may not have acted on the request.
      const definite = res.status !== 408 && res.status < 500;
      return {
        ok: false,
        error: {
          definite,
          status: res.status,
          code: providerCode(res.status, json),
          message: providerMessage(json) ?? `X responded ${res.status}`,
        },
      };
    }
  }
}

function rateLimited(retryAt: number): XError {
  return {
    definite: true,
    status: 429,
    code: 'rate_limited',
    message: 'X rate limit reached',
    retryAt,
  };
}

/** Non-reversible short id for cooldown keys; the token itself is never stored in maps. */
function tokenFingerprint(token: string): string {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function providerMessage(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const o = json as Record<string, unknown>;
  const msg = o.detail ?? o.title ?? o.error_description ?? o.error;
  if (typeof msg === 'string') return msg.slice(0, 300);
  const first = Array.isArray(o.errors)
    ? (o.errors[0] as Record<string, unknown> | undefined)
    : undefined;
  const m = first?.message ?? first?.detail;
  return typeof m === 'string' ? m.slice(0, 300) : undefined;
}

function providerCode(status: number, json: unknown): string {
  const msg = providerMessage(json)?.toLowerCase() ?? '';
  if (status === 401) return 'unauthorized';
  if (status === 403 && msg.includes('duplicate')) return 'duplicate_content';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400) return 'bad_request';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'provider_unavailable';
  return `http_${status}`;
}
