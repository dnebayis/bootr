/**
 * Smoke test against a running indexer (`pnpm --filter indexer dev`).
 *   INDEXER_URL=http://localhost:42069 pnpm --filter indexer smoke
 * Queries GraphQL `platformStats(id: "global")`, a token page, and Ponder's /status.
 */
const base = (process.env.INDEXER_URL ?? `http://localhost:${process.env.PORT ?? 42069}`).replace(/\/$/, '');

async function gql(query: string) {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
  if (!res.ok || json.errors?.length) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  return json.data;
}

async function main() {
  // Ponder's built-in status endpoint (per-chain block / ready flag).
  const status = await fetch(`${base}/status`).then((r) => r.json());
  console.log('status', JSON.stringify(status));
  const stats = await gql(`{ platformStats(id: "global") {
    tokens agentsAwake volume24hUsd volumeTotalUsd feesTotalUsd bootToken bootPriceUsd
    graduationThresholdUsd ethPriceUsd updatedAt } }`);
  console.log('platformStats', JSON.stringify(stats));
  const tokens = await gql(`{ tokens(limit: 3, orderBy: "launchedAt", orderDirection: "desc") {
    items { id symbol priceUsd marketCapUsd holders agent { id status } } } }`);
  console.log('tokens', JSON.stringify(tokens));
  const agents = await gql(`{ agents(limit: 3) { items { id status tokenRef { id symbol } } } }`);
  console.log('agents', JSON.stringify(agents));
  const daily = await gql(`{ dailyStats(orderBy: "id", orderDirection: "desc", limit: 3) { items { id launches volumeUsd } } }`);
  console.log('dailyStats', JSON.stringify(daily));
}

main().catch((err) => {
  console.error('smoke failed:', (err as Error).message);
  process.exit(1);
});
