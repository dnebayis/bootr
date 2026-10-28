import { llmsFullTxt } from '@/lib/docs/markdown';

/** GET /llms-full.txt: every docs page as Markdown in one file (see /llms.txt). Prerendered at build time. */
export function GET() {
  return new Response(llmsFullTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
