#!/usr/bin/env node
/* global process, console, Buffer, URL, Response */
/**
 * A stand-in for the X API, for the own-agent end-to-end script (docs/design/byo-agent.md section 13.10). The sender
 * is started with `X_API_BASE_URL` pointed here; this answers the endpoints `apps/sender/src/x-client.ts` calls and
 * records what it receives, so the script can assert "the stub received exactly one post".
 *
 *   POST /2/tweets                      a post or a reply; answered with a new id
 *   POST /2/media/upload                one picture (multipart); answered with a media id
 *   POST /2/media/metadata              the alt text of a picture
 *   GET  /2/users/me                    the agent's account
 *   GET  /2/users/:id/mentions          the mentions the script put in, newer than since_id
 *   GET  /2/users/:id/tweets            the agent's own posts
 *   GET  /2/users/by/username/:name     an account
 *   GET  /2/tweets/:id, /2/tweets?ids=  posts by id
 *   GET  /2/tweets/search/recent        the replies of one conversation
 *
 * Its own routes, for the script:
 *   POST /__stub/mention {text, author?}   puts a mention of the agent in (from a verified stranger by default)
 *   POST /__stub/account {id, username}    the account `users/me` answers with
 *   GET  /__stub/received                  {posts, media, metadata, requests}
 *   POST /__stub/reset                     forgets everything
 *
 * It keeps no token and checks none: any bearer is the agent. Local use only: it binds 127.0.0.1.
 *
 * Run: STUB_X_PORT=4010 node packages/mcp/test/stub-x.mjs
 *      (STUB_X_USER_ID and STUB_X_HANDLE name the agent's account; they must be the ones the seed script stored)
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const DEFAULT_ACCOUNT = { id: '1900000000000000001', username: 'bootr_stub_agent' };
export const STRANGER = { id: '1900000000000000777', username: 'verified_stranger', name: 'A Stranger', verified: true, verified_type: 'blue', created_at: '2020-01-01T00:00:00.000Z' };

function fresh(account) {
  return { account: { ...account }, seq: 0, mentions: [], posts: [], media: [], metadata: [], requests: [] };
}

/** Ids that sort by time, as X's do: the mention read uses `since_id`. */
function nextId(state) {
  state.seq += 1;
  return String(1_950_000_000_000_000_000n + BigInt(Date.now()) * 1000n + BigInt(state.seq));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function userOf(state, id) {
  if (id === state.account.id) return { ...state.account, verified: false };
  return state.mentions.map((m) => m.author).find((a) => a.id === id) ?? { ...STRANGER, id };
}

function asTweet(post) {
  return { id: post.id, text: post.text, author_id: post.author_id, conversation_id: post.conversation_id, created_at: post.created_at, ...(post.in_reply_to_user_id ? { in_reply_to_user_id: post.in_reply_to_user_id } : {}), ...(post.referenced_tweets ? { referenced_tweets: post.referenced_tweets } : {}), entities: post.entities ?? {}, public_metrics: { like_count: 0, reply_count: 0, retweet_count: 0, quote_count: 0, impression_count: 0 } };
}

function listOf(state, tweets) {
  const users = [...new Map(tweets.map((t) => [t.author_id, userOf(state, t.author_id)])).values()];
  return { ...(tweets.length ? { data: tweets, includes: { users } } : {}), meta: { result_count: tweets.length, ...(tweets.length ? { newest_id: tweets[0].id, oldest_id: tweets.at(-1).id } : {}) } };
}

export async function startStubX({ port = 0, account = DEFAULT_ACCOUNT } = {}) {
  let state = fresh(account);
  const all = () => [...state.mentions, ...state.posts];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const p = url.pathname;
    const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const type = String(req.headers['content-type'] ?? '');
    let json = null;
    if (type.includes('application/json')) {
      try {
        json = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return send(res, 400, { title: 'Invalid Request', detail: 'The body is not JSON.' });
      }
    }
    if (!p.startsWith('/__stub/')) state.requests.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), hasBearer: /^Bearer \S+/.test(String(req.headers.authorization ?? '')), ...(json ? { body: json } : {}) });

    // ---- the script's own routes
    if (p === '/__stub/reset' && req.method === 'POST') {
      state = fresh(state.account);
      return send(res, 200, { ok: true });
    }
    if (p === '/__stub/account' && req.method === 'POST') {
      if (typeof json?.id === 'string' && /^[1-9][0-9]{0,18}$/.test(json.id)) state.account.id = json.id;
      if (typeof json?.username === 'string' && /^\w{1,15}$/.test(json.username)) state.account.username = json.username;
      return send(res, 200, state.account);
    }
    if (p === '/__stub/mention' && req.method === 'POST') {
      const author = { ...STRANGER, ...(json?.author ?? {}) };
      const handle = `@${state.account.username}`;
      const id = nextId(state);
      const mention = {
        id,
        text: `${handle} ${String(json?.text ?? 'gm')}`,
        author_id: author.id,
        author,
        conversation_id: id,
        created_at: new Date().toISOString(),
        in_reply_to_user_id: state.account.id,
        entities: { mentions: [{ start: 0, end: handle.length, username: state.account.username, id: state.account.id }] },
      };
      state.mentions.unshift(mention);
      return send(res, 200, { id, text: mention.text, authorId: author.id });
    }
    if (p === '/__stub/received' && req.method === 'GET') return send(res, 200, { account: state.account, posts: state.posts, media: state.media, metadata: state.metadata, mentions: state.mentions.map(asTweet), requests: state.requests });

    // ---- X
    if (p === '/2/users/me' && req.method === 'GET') return send(res, 200, { data: { ...state.account, verified: false } });
    let m;
    if (req.method === 'GET' && (m = /^\/2\/users\/by\/username\/(\w+)$/.exec(p))) {
      const known = m[1].toLowerCase() === state.account.username.toLowerCase() ? state.account : state.mentions.map((x) => x.author).find((a) => a.username.toLowerCase() === m[1].toLowerCase());
      return known ? send(res, 200, { data: { name: known.username, description: '', created_at: '2020-01-01T00:00:00.000Z', protected: false, public_metrics: { followers_count: 10, following_count: 10, tweet_count: 10 }, ...known } }) : send(res, 200, { errors: [{ title: 'Not Found Error', detail: `Could not find user with username: [${m[1]}].`, resource_type: 'user' }] });
    }
    if (req.method === 'GET' && (m = /^\/2\/users\/(\d+)\/mentions$/.exec(p))) {
      const since = url.searchParams.get('since_id');
      const fits = state.mentions.filter((x) => !since || BigInt(x.id) > BigInt(since)).map(asTweet);
      return send(res, 200, listOf(state, fits));
    }
    if (req.method === 'GET' && (m = /^\/2\/users\/(\d+)\/tweets$/.exec(p))) {
      return send(res, 200, listOf(state, state.posts.filter((x) => x.author_id === m[1]).map(asTweet)));
    }
    if (req.method === 'GET' && p === '/2/tweets/search/recent') {
      const conversation = /^conversation_id:(\d+)$/.exec(url.searchParams.get('query') ?? '')?.[1];
      return send(res, 200, listOf(state, all().filter((x) => x.conversation_id === conversation && x.id !== conversation).map(asTweet)));
    }
    if (req.method === 'GET' && p === '/2/tweets') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const found = all().filter((x) => ids.includes(x.id)).map(asTweet);
      const missing = ids.filter((id) => !found.some((f) => f.id === id)).map((id) => ({ resource_id: id, resource_type: 'tweet', title: 'Not Found Error', detail: `Could not find tweet with ids: [${id}].` }));
      return send(res, 200, { ...(found.length ? { data: found } : {}), ...(missing.length ? { errors: missing } : {}) });
    }
    if (req.method === 'GET' && (m = /^\/2\/tweets\/(\d+)$/.exec(p))) {
      const one = all().find((x) => x.id === m[1]);
      return one ? send(res, 200, { data: asTweet(one), includes: { users: [userOf(state, one.author_id)] } }) : send(res, 200, { errors: [{ resource_id: m[1], resource_type: 'tweet', title: 'Not Found Error', detail: `Could not find tweet with id: [${m[1]}].` }] });
    }
    if (req.method === 'POST' && p === '/2/tweets') {
      if (typeof json?.text !== 'string' || !json.text) return send(res, 400, { title: 'Invalid Request', detail: 'text is required.' });
      const replyTo = json.reply?.in_reply_to_tweet_id;
      const parent = replyTo ? all().find((x) => x.id === replyTo) : null;
      const id = nextId(state);
      state.posts.unshift({ id, text: json.text, author_id: state.account.id, conversation_id: parent?.conversation_id ?? id, created_at: new Date().toISOString(), ...(replyTo ? { in_reply_to_tweet_id: replyTo, in_reply_to_user_id: parent?.author_id, referenced_tweets: [{ type: 'replied_to', id: replyTo }] } : {}), media_ids: json.media?.media_ids ?? [] });
      return send(res, 201, { data: { id, text: json.text } });
    }
    if (req.method === 'POST' && p === '/2/media/upload') {
      let form;
      try {
        form = await new Response(raw, { headers: { 'content-type': type } }).formData();
      } catch {
        return send(res, 400, { title: 'Invalid Request', detail: 'The body is not multipart form data.' });
      }
      const file = form.get('media');
      if (!file || typeof file === 'string') return send(res, 400, { title: 'Invalid Request', detail: 'media is required.' });
      const bytes = Buffer.from(await file.arrayBuffer());
      const id = nextId(state);
      state.media.unshift({ id, mime: String(form.get('media_type') ?? file.type), category: String(form.get('media_category') ?? ''), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), firstBytesHex: bytes.subarray(0, 12).toString('hex') });
      return send(res, 200, { data: { id, media_key: `3_${id}`, expires_after_secs: 86_400 } });
    }
    if (req.method === 'POST' && p === '/2/media/metadata') {
      state.metadata.unshift({ id: json?.id, altText: json?.metadata?.alt_text?.text ?? null });
      return send(res, 200, { data: { id: json?.id } });
    }
    send(res, 404, { title: 'Not Found', detail: `The stub does not answer ${req.method} ${p}.` });
  });
  const url = await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { url, state: () => state, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const account = { id: process.env.STUB_X_USER_ID ?? DEFAULT_ACCOUNT.id, username: process.env.STUB_X_HANDLE ?? DEFAULT_ACCOUNT.username };
  const stub = await startStubX({ port: Number(process.env.STUB_X_PORT ?? 4010), account });
  console.error(`[stub-x] standing in for the X API on ${stub.url} as @${account.username} (${account.id}). It records what it receives: GET /__stub/received`);
}
