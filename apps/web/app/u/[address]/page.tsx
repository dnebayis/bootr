import type { Metadata } from 'next';
import { PublicProfileRoute } from '@/components/profile/PublicProfileView';
import { ClientOnly } from '@/components/ui/ClientOnly';
import { Skeleton } from '@/components/ui/Skeleton';

export const metadata: Metadata = { title: 'Creator', description: 'A creator’s public page on Bootr: coins launched, agents and fees earned.' };

/** Like the token page: the address is read on the client, so the route stays one static shell. */
export default function CreatorPage() {
  return (
    <ClientOnly fallback={<Skeleton className="h-96 rounded-md" />}>
      <PublicProfileRoute />
    </ClientOnly>
  );
}
