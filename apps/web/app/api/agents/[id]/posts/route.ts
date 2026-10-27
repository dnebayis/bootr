import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { senderEnv } from '@/lib/server/env';
import type { AgentPost, AgentPosts } from '@/lib/types';

/**
 * GET /api/agents/:id/posts?limit=3 -> AgentPosts ({handle, items})
 * Server-side proxy to the sender's public `GET /public/posts/:agentId` (the sender is internal in
 * production). `:id` is the ERC-8004 agent id. Responses are cached in memory for 60 s per
 * (id, limit) and marked cacheable for 60 s. 404 = the sender has never seen the agent.
 */

const AGENT_ID_RE = /^[\w:.-]{1,128}$/;
const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;
const CACHEABLE = { 'Cache-Control': 'public, max-age=60' };
const NO_STORE = { 'Cache-Control': 'no-store' };

type Cached = { at: number; status: 200 | 404; body: AgentPosts | { error: 'not_found' } };
const cache = new Map<string, Cached>();

function remember(key: string, entry: Cached) {
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (Date.now() - v.at >= TTL_MS) cache.delete(k);
    while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, entry);
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** Keep only the fields the token page renders, from a trusted-but-typed-loosely upstream body. */
function sanitize(raw: unknown): AgentPosts {
  const o = (raw ?? {}) as { handle?: unknown; items?: unknown };
  const handle = str(o.handle, 15);
  const items: AgentPost[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const p = (it ?? {}) as Record<string, unknown>;
    const id = str(p.id, 128);
    const text = str(p.text, 25_000);
    const postId = str(p.postId, 25);
    const url = str(p.url, 200);
    const created = Date.parse(String(p.createdAt));
    if (!id || !text || !postId || !/^\d+$/.test(postId) || !url?.startsWith('https://x.com/') || !Number.isFinite(created)) continue;
    items.push({ id, kind: p.kind === 'reply' ? 'reply' : 'post', text, postId, url, createdAt: Math.floor(created / 1000) });
  }
  return { handle: handle && /^\w{1,15}$/.test(handle) ? handle : null, items };
}

export async function GET(req: NextRequest, ctx: RouteContext<'/api/agents/[id]/posts'>) {
  const { id } = await ctx.params;
  if (!AGENT_ID_RE.test(id)) return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
  const n = Number(req.nextUrl.searchParams.get('limit') ?? 3);
  const limit = Number.isFinite(n) ? Math.min(10, Math.max(1, Math.trunc(n))) : 3;

  if (env.useMock) {
    const posts = mock.postsByAgentId(id);
    if (!posts) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: CACHEABLE });
    return NextResponse.json({ handle: posts.handle, items: posts.items.slice(0, limit) } satisfies AgentPosts, { headers: CACHEABLE });
  }

  const { internalUrl } = senderEnv();
  if (!internalUrl) return NextResponse.json({ error: 'posts_unavailable' }, { status: 503, headers: NO_STORE });

  const key = `${id}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.body, { status: hit.status, headers: CACHEABLE });

  try {
    const res = await fetch(`${internalUrl}/public/posts/${encodeURIComponent(id)}?limit=${limit}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) {
      const entry: Cached = { at: Date.now(), status: 404, body: { error: 'not_found' } };
      remember(key, entry);
      return NextResponse.json(entry.body, { status: 404, headers: CACHEABLE });
    }
    if (!res.ok) throw new Error(`sender responded ${res.status}`);
    const entry: Cached = { at: Date.now(), status: 200, body: sanitize(await res.json()) };
    remember(key, entry);
    return NextResponse.json(entry.body, { headers: CACHEABLE });
  } catch (err) {
    console.warn('agent posts: sender call failed', (err as Error).message);
    // Serve the last good answer for a while rather than an error.
    if (hit) return NextResponse.json(hit.body, { status: hit.status, headers: NO_STORE });
    return NextResponse.json({ error: 'sender_unavailable' }, { status: 502, headers: NO_STORE });
  }
}
