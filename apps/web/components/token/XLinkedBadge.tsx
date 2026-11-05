'use client';

import { useAgentPosts } from '@/lib/indexer';
import { provenXHandle } from '@/lib/x-linked';
import { Badge } from '@/components/ui/Badge';

const WHY = 'Connected through X’s own sign-in, with the coin creator’s wallet signature for this agent. It says who runs the account, nothing about the coin.';

/** "X linked", only when `provenXHandle` says so. While loading, on an error and without proof it renders nothing: no badge claims nothing. */
export function XLinkedBadge({ agentId, className }: { agentId: string | null | undefined; className?: string }) {
  const posts = useAgentPosts(agentId || undefined);
  const handle = provenXHandle(agentId, posts.data);
  if (!handle) return null;
  return (
    <span title={`@${handle}. ${WHY}`} data-testid="x-linked" className={className}>
      <Badge>X linked</Badge>
    </span>
  );
}
