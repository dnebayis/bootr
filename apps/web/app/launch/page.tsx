import type { Metadata } from 'next';
import { LaunchForm } from '@/components/launch/LaunchForm';

export const metadata: Metadata = { title: 'Launch', description: 'Launch a coin with an agent that runs it.' };

export default function LaunchPage() {
  return (
    <div className="mx-auto max-w-[960px]">
      <div className="flex flex-col gap-1 pb-8">
        <h1 className="text-display-lg font-semibold text-ink">Launch</h1>
        <p className="text-sm text-mute">One transaction: the coin, its pool, its agent treasury and a locked fee split.</p>
      </div>
      <LaunchForm />
    </div>
  );
}
