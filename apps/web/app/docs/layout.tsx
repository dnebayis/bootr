import { Suspense } from 'react';
import { DocsNav, DocsNavView } from '@/components/docs/DocsNav';

export default function DocsLayout({ children }: LayoutProps<'/docs'>) {
  return (
    <div className="grid gap-8 md:grid-cols-[200px_minmax(0,1fr)] md:gap-12">
      <aside className="md:sticky md:top-20 md:self-start">
        <div className="mb-2 hidden px-2.5 text-caption text-mute md:block">Docs</div>
        <Suspense fallback={<DocsNavView pathname={null} />}>
          <DocsNav />
        </Suspense>
      </aside>
      <article className="max-w-[720px] pb-8">{children}</article>
    </div>
  );
}
