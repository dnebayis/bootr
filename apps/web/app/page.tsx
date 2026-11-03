import { BootBox } from '@/components/tokens/BootBox';
import { AsciiWake } from '@/components/tokens/AsciiWake';
import { Hero } from '@/components/tokens/Hero';
import { GridSkeleton, TabsRow, TokensView } from '@/components/tokens/TokensView';
import { ClientOnly } from '@/components/ui/ClientOnly';

export default function TokensPage() {
  return (
    <div className="relative z-[1] flex flex-col gap-8">
      {/* The whole page sits on an ASCII dot field fixed to the viewport that wakes under the pointer (decorative, canvas). */}
      <AsciiWake fixed />
      {/* One line, one input, one primary button; the drifting ASCII field sits behind it, inside the hero only. */}
      <Hero />
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
