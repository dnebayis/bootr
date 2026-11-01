import Link from 'next/link';
import { Wordmark } from '@/components/brand/Wordmark';
import { chainLabel } from '@/lib/chains';
import { env } from '@/lib/env';

export function Footer() {
  return (
    <footer className="mt-24 border-t border-hairline">
      <div className="mx-auto flex flex-col gap-6 px-4 py-10 md:flex-row md:items-start md:justify-between md:px-6">
        <div className="flex flex-col gap-3">
          <Wordmark size="sm" />
          <p className="max-w-xs text-caption text-mute">Launch a coin with an agent that runs it. Fees split on-chain, locked at launch.</p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-2 text-sm sm:grid-cols-3">
          <Link className="text-mute hover:text-ink" href="/docs">How it works</Link>
          <Link className="text-mute hover:text-ink" href="/docs/fees">Fee math</Link>
          <Link className="text-mute hover:text-ink" href="/docs/agent-rules">Agent rules</Link>
          <Link className="text-mute hover:text-ink" href="/docs/dormancy">Dormancy</Link>
          <Link className="text-mute hover:text-ink" href="/docs/risks">Risks</Link>
          <Link className="text-mute hover:text-ink" href="/analytics">Analytics</Link>
          <Link className="text-mute hover:text-ink" href="/docs/terms">Terms</Link>
          <Link className="text-mute hover:text-ink" href="/docs/privacy">Privacy</Link>
          {env.bootXUrl ? (
            <a className="text-mute hover:text-ink" href={env.bootXUrl} target="_blank" rel="noopener noreferrer">X</a>
          ) : null}
        </nav>
      </div>
      <div className="border-t border-hairline">
        <div className="mx-auto flex items-center justify-between px-4 py-4 font-mono text-micro text-mute md:px-6">
          <span>bootr.fun</span>
          <span>{chainLabel()}{env.useMock ? ' · mock data' : ''}</span>
        </div>
      </div>
    </footer>
  );
}
