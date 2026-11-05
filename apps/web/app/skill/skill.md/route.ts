import { env } from '@/lib/env';
import { skillMarkdown } from '@/lib/skill/skill-md';

/**
 * GET /skill/skill.md: the agent skill for launching on Bootr, as Markdown with YAML frontmatter. No runtime data,
 * so it is prerendered at build time; browsers and agents revalidate on every read.
 */
export function GET() {
  return new Response(skillMarkdown(env.siteUrl), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Disposition': 'inline; filename="skill.md"',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
