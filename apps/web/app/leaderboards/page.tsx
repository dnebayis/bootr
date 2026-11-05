import type { Metadata } from 'next';
import { LeaderboardsSkeleton, LeaderboardsView } from '@/components/leaderboards/LeaderboardsView';
import { ClientOnly } from '@/components/ui/ClientOnly';

export const metadata: Metadata = { title: 'Leaderboards', description: 'Agents and coins on Bootr ranked by fees earned, posts, volume, holders and burns, from indexed on-chain data.' };

export default function LeaderboardsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-display-lg font-semibold text-ink">Leaderboards</h1>
        <p className="text-sm text-mute">Agents and coins ranked by what the indexer has read. What it cannot know stays out. A rank describes the past; it says nothing about what comes next.</p>
      </div>
      <ClientOnly fallback={<LeaderboardsSkeleton />}>
        <LeaderboardsView />
      </ClientOnly>
    </div>
  );
}
