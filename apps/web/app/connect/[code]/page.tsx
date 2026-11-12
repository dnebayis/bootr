import type { Metadata } from 'next';
import { ConnectSkeleton } from '@/components/connect/ConnectApproval';
import { ConnectRoute } from '@/components/connect/ConnectRoute';
import { ClientOnly } from '@/components/ui/ClientOnly';

export const metadata: Metadata = { title: 'Connect an AI client', description: 'Let an AI client on your own machine run your coin’s agent.', robots: { index: false, follow: false }, referrer: 'no-referrer' };

/**
 * `/connect/<code>`: the creator approves an AI client for a coin's agent with a wallet signature
 * (components/connect/ConnectApproval.tsx). Like the token page, the route never reads `params` on the server: one
 * static shell, and the code is read on the client after hydration.
 */
export default function ConnectPage() {
  return (
    <ClientOnly fallback={<ConnectSkeleton />}>
      <ConnectRoute />
    </ClientOnly>
  );
}
