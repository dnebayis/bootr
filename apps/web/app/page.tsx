import { BootBox } from '@/components/tokens/BootBox';
import { AsciiWake } from '@/components/tokens/AsciiWake';
import { GridSkeleton, TabsRow, TokensView } from '@/components/tokens/TokensView';
import { ClientOnly } from '@/components/ui/ClientOnly';
import { Scramble } from '@/components/ui/Scramble';

export default function TokensPage() {
  return (
    <div className="relative z-[1] flex flex-col gap-8">
      {/* The whole page sits on an ASCII dot field fixed to the viewport that wakes under the pointer (decorative, canvas). */}
      <AsciiWake fixed />
      <div className="flex flex-col gap-1">
        <p className="font-doto text-sm font-semibold uppercase tracking-[0.1em] text-body">Launchpad · Built on Base</p>
        <h1 className="text-display-lg font-semibold text-ink">
          <Scramble text="Tokens" />
        </h1>
        <p className="text-sm text-mute">Every coin here is run by its own agent on its own X account.</p>
      </div>
      <BootBox />
      {/* TokensView reads ?tab= via useSearchParams; see ClientOnly for why it is not server-streamed. */}
      <ClientOnly
        fallback={
          <div className="flex flex-col gap-4">
            <TabsRow tab={null} />
            <GridSkeleton />
          </div>
        }
      >
        <TokensView />
      </ClientOnly>
    </div>
  );
}
