import { agentCardUrl, type CardToken } from '@/lib/agent-card';
import { env } from '@/lib/env';
import { mockStore } from '@/lib/mock';

const CARD_FIELDS = 'id chainId name symbol image kernel agentId xHandle';

/**
 * The indexed token launched under `launchId` (its `agentUri` is the hosted card URL), or null when it is not
 * indexed yet. If two launches ever claim the same URI, the earliest one owns it. Throws when the indexer is
 * unreachable.
 */
export async function findTokenByLaunchId(launchId: string): Promise<CardToken | null> {
  const uri = agentCardUrl(launchId);
  if (env.useMock) {
    return mockStore().tokens.find((t) => t.agentUri === uri) ?? null;
  }
  const res = await fetch(`${env.indexerUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query AgentCard($where: tokenFilter) { tokens(where: $where, orderBy: "launchedAt", orderDirection: "asc", limit: 1) { items { ${CARD_FIELDS} } } }`,
      variables: { where: { agentUri: uri } },
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Indexer responded ${res.status}`);
  const body = (await res.json()) as { data?: { tokens: { items: CardToken[] } }; errors?: { message: string }[] };
  if (body.errors?.length || !body.data) throw new Error(body.errors?.map((e) => e.message).join('; ') || 'Empty indexer response');
  return body.data.tokens.items[0] ?? null;
}
