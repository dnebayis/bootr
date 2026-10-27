'use client';

import type { ReactNode } from 'react';
import { useMounted } from '@/lib/hooks';

/**
 * Renders `children` only after hydration; `fallback` is what the server (and the first client
 * render) outputs.
 *
 * Why: components that read URL data (`useSearchParams`, `useParams` with unknown params) must sit
 * in a Suspense boundary under Cache Components, and that boundary's content is *streamed* after the
 * static shell. React reveals streamed boundaries with `requestAnimationFrame` (`$RC` -> `$RV`), and
 * hydrates them from an rAF retry. In a background or hidden tab rAF never fires, so the boundary,
 * and every query inside it, stays on its skeleton until the tab becomes visible. Rendering these
 * components client-side keeps them out of the streamed HTML entirely.
 */
export function ClientOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const mounted = useMounted();
  return <>{mounted ? children : fallback}</>;
}
