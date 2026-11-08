import type { Metadata } from 'next';
import { ConsoleRoute } from '@/components/token/ConsoleRoute';
import { ConsoleSkeleton } from '@/components/token/ConsolePage';
import { ClientOnly } from '@/components/ui/ClientOnly';

export const metadata: Metadata = { title: 'Creator console', robots: { index: false } };

/**
 * The creator's console for one coin. Like the token page, the route never reads `params` or the search params on the
 * server: one static shell, the address and `?section=` are read on the client after hydration.
 */
export default function ConsolePageRoute() {
  return (
    <ClientOnly fallback={<ConsoleSkeleton />}>
      <ConsoleRoute />
    </ClientOnly>
  );
}
