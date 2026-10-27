import type { MetadataRoute } from 'next';
import { env } from '@/lib/env';
import { DOC_PAGES } from '@/components/docs/pages';

/** Public routes only. The admin console is intentionally excluded. */
export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ['/', '/launch', '/analytics', '/docs', '/profile', ...DOC_PAGES.filter((p) => p.slug).map((p) => `/docs/${p.slug}`)];
  return routes.map((r) => ({ url: `${env.siteUrl}${r === '/' ? '' : r}`, changeFrequency: r === '/' ? 'always' : 'weekly' }));
}
