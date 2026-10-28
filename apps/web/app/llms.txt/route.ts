import { llmsTxt } from '@/lib/docs/markdown';

/**
 * GET /llms.txt: index of the docs for language models (llmstxt.org format), generated from the same content
 * as /docs. No runtime data, so it is prerendered at build time.
 */
export function GET() {
  return new Response(llmsTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
