/**
 * The limits the posting workstream added, each at "off" (docs/design/agent-tools-2.md section 13: a limit of 0
 * switches its piece off): no threads, no comments, any account may be mentioned with a credit, the verified reply
 * audience alone. The count of posts with a link is the sender's and is off there when no limit is set.
 */
export const POSTING_OFF: Record<string, string> = {
  THREAD_MAX_PARTS: '0',
  THREADS_PER_DAY: '0',
  THREAD_MAX_LINK_PARTS: '0',
  COMMENT_POSTS_PER_DAY: '0',
  COMMENT_PER_AUTHOR_PER_DAY: '0',
  COMMENT_PER_AUTHOR_PER_WEEK: '0',
  COMMENT_SOURCE_MAX_AGE_MS: '0',
  MENTION_AUDIENCE: 'anyone',
  ENGAGED_WINDOW_MS: '0',
  REPLY_AUDIENCE_DEFAULT: 'verified',
  REPLY_QUESTIONS_FROM_ANYONE: 'false',
  OPEN_REPLIES_PER_DAY: '0',
};

/** The same limits at their defaults, for a test that needs the pieces on whichever run it is part of. */
export const POSTING_DEFAULTS: Record<string, string> = {
  THREAD_MAX_PARTS: '4',
  THREADS_PER_DAY: '2',
  THREAD_MAX_LINK_PARTS: '1',
  COMMENT_POSTS_PER_DAY: '3',
  COMMENT_PER_AUTHOR_PER_DAY: '1',
  COMMENT_PER_AUTHOR_PER_WEEK: '3',
  COMMENT_SOURCE_MAX_AGE_MS: String(72 * 3_600_000),
  MENTION_AUDIENCE: 'engaged',
  ENGAGED_WINDOW_MS: String(30 * 24 * 3_600_000),
  REPLY_AUDIENCE_DEFAULT: 'verified',
  REPLY_QUESTIONS_FROM_ANYONE: 'true',
  OPEN_REPLIES_PER_DAY: '10',
};
