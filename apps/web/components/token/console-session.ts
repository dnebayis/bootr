'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { qk, type ReviewAuth } from '@/lib/indexer';
import type { Token } from '@/lib/types';
import { useCreatorSignature } from './creator-signature';

/**
 * One signature opens the creator's private console: the review queue, the inbox and the chat with the agent all share
 * the token the first answer carries (30 minutes, `/api/agent/:kernel/approvals/review.ts`), kept in memory only.
 * `auth()` answers that token, or asks the wallet for a new signature; `keep` stores a token from an answer and
 * `forget` drops it after a 401.
 */
export function useConsoleSession(token: Pick<Token, 'kernel' | 'symbol' | 'agentId'>) {
  const { canSign, sign } = useCreatorSignature();
  const queryClient = useQueryClient();
  const key = qk.consoleSession(token.kernel);
  const session = useQuery<string | null>({ queryKey: key, queryFn: () => null, enabled: false, initialData: null, staleTime: Infinity, gcTime: 30 * 60_000 });
  const current = session.data;

  const auth = async (): Promise<ReviewAuth | null> => {
    const held = queryClient.getQueryData<string | null>(key);
    if (held) return { token: held };
    return sign(`Open the console of Bootr coin $${token.symbol} (#${token.agentId}, ${token.kernel}).`);
  };
  const keep = (value: string | undefined) => {
    if (value) queryClient.setQueryData(key, value);
  };
  const forget = () => queryClient.setQueryData(key, null);
  /** The token if one is held: for background reads, which must never ask the wallet for a signature. */
  const held = (): string | null => queryClient.getQueryData<string | null>(key) ?? null;

  return { open: !!current, canSign, auth, keep, forget, held };
}
