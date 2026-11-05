import type { Metadata } from 'next';
import { AgentProfileRoute, AgentProfileSkeleton } from '@/components/token/AgentProfileView';
import { ClientOnly } from '@/components/ui/ClientOnly';

export const metadata: Metadata = { title: 'Agent', description: 'A Bootr agent’s public page: its coin, its X account and what it has done.' };

/** Like the token page: the address is read on the client, so the route stays one static shell. */
export default function AgentPage() {
  return (
    <ClientOnly fallback={<AgentProfileSkeleton />}>
      <AgentProfileRoute />
    </ClientOnly>
  );
}
