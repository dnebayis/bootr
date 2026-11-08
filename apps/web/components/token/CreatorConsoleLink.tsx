'use client';

import { useConnection } from 'wagmi';
import { env } from '@/lib/env';
import { useApprovalCount } from '@/lib/indexer';
import { consoleHref } from '@/lib/console-sections';
import type { Token } from '@/lib/types';
import { LinkButton } from '@/components/ui/Button';

/**
 * The creator's way into the console (`/token/:address/console`), right under the Trade panel's primary action:
 * a full-width secondary button, with the number of posts waiting for review in mono beside the label. Nothing for
 * anyone but the creator's wallet (everyone in mock mode).
 */
export function CreatorConsoleLink({ token }: { token: Token }) {
  const { address } = useConnection();
  const isCreator = env.useMock || (!!address && !!token.creator && address.toLowerCase() === token.creator.toLowerCase());
  const approvals = useApprovalCount(token.kernel, isCreator);
  if (!isCreator) return null;
  const pending = approvals.data?.pending ?? 0;
  return (
    <LinkButton href={consoleHref(token.id)} variant="secondary" size="lg" className="w-full" data-testid="open-console">
      Creator console
      {pending > 0 ? (
        <span className="font-mono text-caption text-mute tabular" data-testid="approvals-pending">
          · {pending} pending
        </span>
      ) : null}
    </LinkButton>
  );
}
