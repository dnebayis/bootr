import type { Metadata } from 'next';
import { LedgerRoute, LedgerSkeleton } from '@/components/token/LedgerPage';
import { ClientOnly } from '@/components/ui/ClientOnly';

export const metadata: Metadata = { title: 'Agent money' };

/**
 * The public money ledger of a coin's agent. Like the token page, the route never reads `params` on the server: one
 * static shell, the address is read on the client after hydration.
 */
export default function LedgerPageRoute() {
  return (
    <ClientOnly fallback={<LedgerSkeleton />}>
      <LedgerRoute />
    </ClientOnly>
  );
}
