import type { MetadataRoute } from 'next';
import { env } from '@/lib/env';
import { DOC_PAGES, docPath } from '@/components/docs/pages';

/** Public routes only. The admin console is intentionally excluded. */
export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ['/', '/leaderboards', '/launch', '/analytics', '/profile', ...DOC_PAGES.map((p) => docPath(p.slug)), '/llms.txt', '/llms-full.txt', '/skill', '/skill/skill.md'];
  return routes.map((r) => ({ url: `${env.siteUrl}${r === '/' ? '' : r}`, changeFrequency: r === '/' ? 'always' : 'weekly' }));
}
