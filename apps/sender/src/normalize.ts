import type { XTweet, XUser } from './x-client.js';

/** agent-core `XPost` shape (types.ts `xPostSchema`), as the supervisor's brain consumes it. */
export interface XPost {
  id: string;
  text: string;
  authorId: string;
  createdAt?: string;
  conversationId?: string;
  inReplyToUserId?: string | null;
  referencedPosts?: { type: 'replied_to' | 'quoted' | 'retweeted'; id: string }[];
  mentions?: { username: string; id?: string }[];
  urls?: { url: string; expandedUrl: string }[];
  mediaKeys?: string[];
  author?: {
    id: string;
    username?: string;
    verified?: boolean;
    verifiedType?: 'blue' | 'business' | 'government' | 'none';
  };
}

const VERIFIED_TYPES = new Set(['blue', 'business', 'government', 'none']);

export function toXPost(t: XTweet, users: Map<string, XUser> = new Map()): XPost {
  const entities = t.note_tweet?.entities ?? t.entities;
  const author = t.author_id ? users.get(t.author_id) : undefined;
  const post: XPost = { id: t.id, text: t.note_tweet?.text ?? t.text, authorId: t.author_id ?? '' };
  if (t.created_at) post.createdAt = t.created_at;
  if (t.conversation_id) post.conversationId = t.conversation_id;
  if (t.in_reply_to_user_id) post.inReplyToUserId = t.in_reply_to_user_id;
  if (t.referenced_tweets?.length)
    post.referencedPosts = t.referenced_tweets.map((r) => ({ type: r.type, id: r.id }));
  if (entities?.mentions?.length)
    post.mentions = entities.mentions.map((m) => ({
      username: m.username,
      ...(m.id ? { id: m.id } : {}),
    }));
  const urls = (entities?.urls ?? []).filter((u) => u.expanded_url);
  if (urls.length) post.urls = urls.map((u) => ({ url: u.url, expandedUrl: u.expanded_url! }));
  if (author) {
    post.author = {
      id: author.id,
      username: author.username,
      ...(author.verified !== undefined ? { verified: author.verified } : {}),
      ...(author.verified_type && VERIFIED_TYPES.has(author.verified_type)
        ? { verifiedType: author.verified_type as 'blue' | 'business' | 'government' | 'none' }
        : {}),
    };
  }
  return post;
}
