import { NextResponse, type NextRequest } from 'next/server';
import { createPublicClient, getAddress, http, isAddress, type Address, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { clankerFeeLockerAbi } from '@/lib/abi/clankerFeeLocker';
import { rwagmiLpLockerV3Abi } from '@/lib/abi/rwagmiLpLockerV3';
import { builderDataSuffix } from '@/lib/attribution';
import { contracts } from '@/lib/contracts';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { buildClaims } from '@/lib/server/claim';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { rateLimitMessage } from '@/lib/server/refusals';
import { findTokensByCreator } from '@/lib/server/token-lookup';

const HEADERS = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
const limiter = new RateLimiter(20, 60_000);
const MOCK_LOCKER: Address = '0x000000000000000000000000000000000000dEaD';

function fail(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message }, { status, headers: { ...HEADERS, ...headers } });
}

/**
 * GET /api/agent/claim/{address}
 * The fee claims waiting for a creator, as unsigned transactions: the calls the profile page sends for both launch
 * paths, each with its target, data, value and a plain description. No key and no signature, and nothing is sent:
 * the creator's own wallet sends them. The answer is a read of public balances and any origin may read it. 20 calls
 * per minute per IP, since each one reads the indexer and the chain.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const retryAfter = limiter.hit(clientIp(req.headers));
  if (retryAfter) return fail(429, 'rate_limited', rateLimitMessage(20, retryAfter), { 'Retry-After': String(retryAfter) });
  const { id } = await ctx.params;
  if (!isAddress(id, { strict: false })) return fail(400, 'invalid_request', "address must be a 0x address of 40 hex characters.");
  const owner = getAddress(id);

  let coins: { id: string; symbol: string; poolId: string; source?: string | null }[];
  try {
    coins = env.useMock ? mock.tokensByCreator(owner) : await findTokensByCreator(owner);
  } catch {
    return fail(502, 'indexer_unavailable', 'Could not read this wallet’s coins from the indexer. Nothing was prepared: try again in a moment.');
  }
  const bootrCoins = coins.filter((c) => c.source !== 'clanker');
  const clankerCoins = coins.filter((c) => c.source === 'clanker');

  const lpLocker = contracts.lpLocker ?? (env.useMock ? MOCK_LOCKER : null);
  const clankerFeeLocker = contracts.clankerFeeLocker ?? (env.useMock ? MOCK_LOCKER : null);
  let settled = 0n;
  let unsettled: readonly bigint[] = [];
  let clankerAvailable = 0n;
  if (env.useMock) {
    settled = mock.claimable(owner, 'settled');
    unsettled = bootrCoins.map((c) => mock.claimable(owner, c.poolId));
    clankerAvailable = mock.clankerFees(owner);
  } else {
    const chain = env.chainId === 8453 ? base : baseSepolia;
    const client = createPublicClient({ chain, transport: http((env.chainId === 8453 ? process.env.BASE_RPC_URL : process.env.BASE_SEPOLIA_RPC_URL) || undefined) });
    const locker = contracts.lpLocker;
    const feeLocker = contracts.clankerFeeLocker;
    try {
      [settled, unsettled, clankerAvailable] = await Promise.all([
        locker ? client.readContract({ address: locker, abi: rwagmiLpLockerV3Abi, functionName: 'claimableQuote', args: [owner, contracts.weth] }) : 0n,
        locker && bootrCoins.length > 0
          ? client.multicall({
              allowFailure: false,
              contracts: bootrCoins.map((c) => ({ address: locker, abi: rwagmiLpLockerV3Abi, functionName: 'pendingQuote' as const, args: [c.poolId as Hex, owner] as const })),
            })
          : [],
        feeLocker ? client.readContract({ address: feeLocker, abi: clankerFeeLockerAbi, functionName: 'availableFees', args: [owner, contracts.weth] }) : 0n,
      ]);
    } catch {
      return fail(502, 'chain_unavailable', 'Could not read the fee lockers. Nothing was prepared: try again in a moment.');
    }
  }

  const claims = buildClaims({
    owner,
    weth: contracts.weth,
    lpLocker,
    clankerFeeLocker,
    settled,
    unsettled: bootrCoins.map((c, i) => ({ poolId: c.poolId as Hex, amount: unsettled[i] ?? 0n })),
    clankerAvailable,
    dataSuffix: builderDataSuffix,
  });
  const totalWei = claims.reduce((sum, c) => sum + BigInt(c.amountWei), 0n);

  return NextResponse.json(
    {
      address: owner,
      chainId: env.chainId,
      asset: contracts.weth,
      totalWei: totalWei.toString(),
      coins: {
        bootr: bootrCoins.map((c, i) => ({ token: c.id, symbol: c.symbol, poolId: c.poolId, unsettledWei: (unsettled[i] ?? 0n).toString() })),
        clanker: clankerCoins.map((c) => ({ token: c.id, symbol: c.symbol })),
      },
      claims,
      note: `Nothing was signed or sent. ${claims.length === 0 ? 'Nothing is waiting to be claimed right now.' : 'Each claim is a transaction for the wallet to send, and amounts are as read just now.'} A Clanker coin’s new fees reach the balance after collectRewards(coin) on Clanker’s LP locker, which anyone may call; in a coin’s first 2 minutes that call credits nothing yet.`,
      ...(env.useMock ? { mock: true } : {}),
    },
    { headers: HEADERS },
  );
}
