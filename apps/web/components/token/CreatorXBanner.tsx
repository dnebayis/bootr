'use client';

import { useConnection } from 'wagmi';
import { env } from '@/lib/env';
import { useNow } from '@/lib/hooks';
import { useAgentConfig } from '@/lib/indexer';
import type { Token } from '@/lib/types';
import { activeXHold, formatHoldEnd, xHoldCopy, xRevokedCopy, xTrouble } from '@/lib/x-hold';
import { XLogoIcon } from '@/components/ui/Icons';
import { Isometric } from '@/components/art/Isometric';
import { ConnectAgentX } from './ConnectAgentX';

/**
 * The first thing a creator sees on their coin page while the agent has no X account: the agent cannot post,
 * and the indexer shows it as sleeping, until one is connected. Shown only to the creator's wallet (everyone
 * in mock mode) and never for a claimed or dormant agent. Visitors get the Posts section's note instead.
 *
 * With an X account, the same place carries the two X problems that need the creator (lib/x-hold.ts `xTrouble`): the
 * connection lost (`AgentConfig.xConnection === 'revoked'`: X dropped it, as when the creator resets the app's access on
 * X; the inbox's `x_revoked`) and, failing that, X refusing the account's posts (403 "not permitted", `AgentConfig.xHold`
 * while the supervisor's hold lasts). Each panel says what happened, and the Connect X button reconnects the same
 * account, which brings the agent back on the next pass and ends a hold at once.
 */
export function CreatorXBanner({ token }: { token: Token }) {
  const { address } = useConnection();
  const isCreator = env.useMock || (!!address && !!token.creator && address.toLowerCase() === token.creator.toLowerCase());
  const status = token.agent?.status;
  const eligible = isCreator && status !== 'claimed' && status !== 'dormant';
  // The config (with the hold) is read only for the creator of an agent that has an X account; nobody else pays the call.
  const config = useAgentConfig(token.kernel, eligible && !!token.xHandle);
  const now = useNow();
  if (!eligible) return null;
  if (token.xHandle) {
    const trouble = xTrouble(config.data?.xConnection, config.data?.xHold, now);
    if (!trouble) return null;
    const hold = trouble === 'hold' ? activeXHold(config.data?.xHold, now) : null;
    const copy = trouble === 'revoked' ? xRevokedCopy(token.xHandle) : xHoldCopy(token.xHandle, formatHoldEnd(hold!.until, now));
    const id = trouble === 'revoked' ? 'creator-x-revoked' : 'creator-x-hold';
    return (
      <section aria-labelledby={id} className="rounded-md border border-danger bg-canvas-soft p-4" data-testid={id} data-until={hold?.until}>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
          <Isometric kind="antenna" size={48} className="hidden shrink-0 text-body sm:block" />
          <div className="min-w-0 flex-1">
            <h2 id={id} className="inline-flex items-center gap-2 text-base font-semibold text-ink">
              <XLogoIcon /> {copy.title}
            </h2>
            <p className="mt-1 text-sm text-body">{copy.body}</p>
          </div>
          <div className="w-full md:w-[360px] md:shrink-0">
            <ConnectAgentX token={token} variant={trouble === 'revoked' ? 'again' : 'forbidden'} />
          </div>
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby="creator-x-banner" className="rounded-md border border-warning bg-canvas-soft p-4" data-testid="creator-x-banner">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <Isometric kind="antenna" size={48} className="hidden shrink-0 text-body sm:block" />
        <div className="min-w-0 flex-1">
          <h2 id="creator-x-banner" className="inline-flex items-center gap-2 text-base font-semibold text-ink">
            <XLogoIcon /> Your agent is waiting for an X account
          </h2>
          <p className="mt-1 text-sm text-body">
            ${token.symbol}&rsquo;s agent is funded and ready, but it only speaks through its own X account. Until you connect one it posts nothing and
            shows as sleeping. Create a fresh X account for the agent, then connect it here with the wallet that launched the coin.
          </p>
        </div>
        <div className="w-full md:w-[360px] md:shrink-0">
          <ConnectAgentX token={token} />
        </div>
      </div>
    </section>
  );
}
