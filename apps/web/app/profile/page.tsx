import type { Metadata } from 'next';
import { ProfileView } from '@/components/profile/ProfileView';

export const metadata: Metadata = { title: 'Profile', description: 'Your coins, your agents and your fuel history.' };

export default function ProfilePage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-display-lg font-semibold text-ink">Profile</h1>
        <p className="text-sm text-mute">Coins you launched, agents you run, coins you hold.</p>
      </div>
      <ProfileView />
    </div>
  );
}
