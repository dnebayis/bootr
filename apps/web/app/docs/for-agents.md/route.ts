import { markdownResponse } from '@/lib/docs/markdown';

/** GET /docs/for-agents.md: this page as Markdown, from the same blocks as the HTML. Prerendered at build time. */
export function GET() {
  return markdownResponse('for-agents');
}
