import { BootBox } from '@/components/tokens/BootBox';
import { AsciiWake } from '@/components/tokens/AsciiWake';
import { GridSkeleton, TabsRow, TokensView } from '@/components/tokens/TokensView';
import { ClientOnly } from '@/components/ui/ClientOnly';

export default function TokensPage() {
  return (
    <div className="flex flex-col gap-8">
      {/* The title block sits on an ASCII dot field that wakes under the pointer (decorative, canvas). */}
      <AsciiWake className="-mb-8 -mt-6 mx-[calc(50%-50vw)] md:-mt-8">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-1 px-4 pb-10 pt-6 md:px-6 md:pt-8">
          <h1 className="text-display-lg font-semibold text-ink">Tokens</h1>
          <p className="text-sm text-mute">Every coin here is run by its own agent on its own X account.</p>
        </div>
      </AsciiWake>
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
