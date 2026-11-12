'use client';

import { AI_CLIENTS, KEEP_RUNNING_FACTS, keepRunningRecipe, type AiClientId, type CopyBlock } from '@/lib/keep-running';
import { CopyButton } from '@/components/ui/CopyButton';
import { Tab, TabList, Tabs } from '@/components/ui/Tabs';
import { cn } from '@/components/ui/cn';

/**
 * A block of text to paste somewhere else (a command, a config, a sentence), with its copy button. Long lines wrap
 * rather than scroll, so the whole text is readable on a phone.
 */
export function CopyBlockView({ block, className, 'data-testid': testId }: { block: CopyBlock; className?: string; 'data-testid'?: string }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-sm border border-hairline bg-canvas-soft py-1 pr-1 pl-3', className)} data-testid={testId}>
      <pre className="min-w-0 flex-1 whitespace-pre-wrap py-1.5 font-mono text-caption leading-5 text-ink [overflow-wrap:anywhere]">{block.text}</pre>
      <CopyButton value={block.text} label={`Copy: ${block.label}`} className="size-8 shrink-0" />
    </div>
  );
}

/** The client picker shared by the connect steps and the recipes: one tab per client, scrolling sideways on a phone. */
export function ClientTabs({ value, onChange, label }: { value: AiClientId; onChange: (id: AiClientId) => void; label: string }) {
  return (
    <Tabs<AiClientId> value={value} onValueChange={onChange}>
      <TabList variant="underline" dense aria-label={label} className="overflow-x-auto [scrollbar-width:none]">
        {AI_CLIENTS.map((c) => (
          <Tab key={c.id} value={c.id}>
            {c.label}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}

/**
 * "Keep it running" (docs/design/byo-agent.md section 2.6): an own agent works only while something on the creator's
 * machine starts a turn, so this hands the creator a ready way to do that for the client they use, with the coin
 * filled in. Help, nothing more: Bootr never reminds, and never takes over. Shown in the launch page's connect step
 * once a client is connected, and in the console's Agent card. With `onClient` it carries its own client tabs.
 */
export function KeepRunning({ symbol, client, onClient, className, bare }: { symbol: string | null | undefined; client: AiClientId; onClient?: (id: AiClientId) => void; className?: string; /** Without its own title: the caller's heading (a disclosure) says "Keep it running". */ bare?: boolean }) {
  const recipe = keepRunningRecipe(client, symbol);
  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="keep-running" data-client={client}>
      <div>
        {bare ? null : <h3 className="text-caption font-medium text-ink">Keep it running</h3>}
        <p className={cn('text-caption text-mute', !bare && 'mt-0.5')}>The agent acts when your AI client starts a round of work. Here is a ready way to do that.</p>
      </div>
      {onClient ? <ClientTabs value={client} onChange={onClient} label="Your AI client, for the recipe" /> : null}
      <p className="text-sm text-ink" data-testid="keep-running-summary">
        {recipe.summary}
      </p>
      {recipe.copy ? <CopyBlockView block={recipe.copy} data-testid="keep-running-copy" /> : null}
      <ol className="flex flex-col gap-1.5 text-caption text-body">
        {recipe.steps.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="font-mono text-mute">{i + 1}.</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{step}</span>
          </li>
        ))}
      </ol>
      <ul className="flex flex-col gap-1 border-t border-hairline pt-3 text-caption text-mute">
        {KEEP_RUNNING_FACTS.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    </div>
  );
}
