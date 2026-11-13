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
  OPEN_REPLIES_PER_DAY: '0',
};
