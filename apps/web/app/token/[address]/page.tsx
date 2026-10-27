import type { Metadata } from 'next';
import { TokenRoute } from '@/components/token/TokenRoute';
import { TokenSkeleton } from '@/components/token/TokenView';
import { ClientOnly } from '@/components/ui/ClientOnly';

export const metadata: Metadata = { title: 'Token' };

/**
 * The page never reads `params` on the server, so the whole route is one static shell and nothing
 * is streamed after it. The address is read on the client (useParams) after hydration.
 */
export default function TokenPage() {
  return (
    <ClientOnly fallback={<TokenSkeleton />}>
      <TokenRoute />
    </ClientOnly>
  );
}
