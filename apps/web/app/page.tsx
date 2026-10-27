import { BootBox } from '@/components/tokens/BootBox';
import { GridSkeleton, TabsRow, TokensView } from '@/components/tokens/TokensView';
import { ClientOnly } from '@/components/ui/ClientOnly';

export default function TokensPage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-display-lg font-semibold text-ink">Tokens</h1>
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
