import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DocsNav, DocsNavView } from '@/components/docs/DocsNav';
import { DOCS_ALTERNATES } from '@/components/docs/pages';

/** Points language models at the plain-text docs (/llms.txt, generated from the same content). */
export const metadata: Metadata = { alternates: DOCS_ALTERNATES };

export default function DocsLayout({ children }: LayoutProps<'/docs'>) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[200px_minmax(0,1fr)] md:gap-12">
      <aside className="min-w-0 md:sticky md:top-20 md:self-start">
        <Suspense fallback={<DocsNavView pathname={null} />}>
          <DocsNav />
        </Suspense>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
