import { NextResponse, type NextRequest } from 'next/server';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { clankerFeeLockerAbi } from '@/lib/abi/clankerFeeLocker';
import { feeEscrowAbi, NATIVE_ETH } from '@/lib/abi/feeEscrow';
import { rwagmiLpLockerV3Abi } from '@/lib/abi/rwagmiLpLockerV3';
import { builderDataSuffix } from '@/lib/attribution';
import { contracts } from '@/lib/contracts';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { serverPublicClient } from '@/lib/server/chain';
import { buildClaims } from '@/lib/server/claim';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { rateLimitMessage } from '@/lib/server/refusals';
import { findTokensByCreator } from '@/lib/server/token-lookup';

const HEADERS = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
const limiter = new RateLimiter(20, 60_000);
const MOCK_LOCKER: Address = '0x000000000000000000000000000000000000dEaD';
const MOCK_ESCROW: Address = '0x000000000000000000000000000000000000bEEF';

function fail(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, message }, { status, headers: { ...HEADERS, ...headers } });
}

/**
 * GET /api/agent/claim/{address}
 * The fee claims waiting for a creator, as unsigned transactions: the calls the profile page sends for every launch
 * path (RWAGMI's locker, Clanker v4's fee locker, Clanker v5's fee escrow), each with its target, data, value and a plain description. No key and no signature, and nothing is sent:
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
  const bootrCoins = coins.filter((c) => c.source !== 'clanker' && c.source !== 'clanker-v5');
  const clankerCoins = coins.filter((c) => c.source === 'clanker');
  const clankerV5Coins = coins.filter((c) => c.source === 'clanker-v5');

  const lpLocker = contracts.lpLocker ?? (env.useMock ? MOCK_LOCKER : null);
  const clankerFeeLocker = contracts.clankerFeeLocker ?? (env.useMock ? MOCK_LOCKER : null);
  const clankerFeeEscrow = contracts.clankerFeeEscrow ?? (env.useMock ? MOCK_ESCROW : null);
  let settled = 0n;
  let unsettled: readonly bigint[] = [];
  let clankerAvailable = 0n;
  let clankerV5Owed = 0n;
  if (env.useMock) {
    settled = mock.claimable(owner, 'settled');
    unsettled = bootrCoins.map((c) => mock.claimable(owner, c.poolId));
    clankerAvailable = mock.clankerFees(owner);
    clankerV5Owed = clankerV5Coins.length > 0 ? mock.clankerFees(owner, 5) : 0n;
  } else {
    const client = serverPublicClient(env.chainId);
    const locker = contracts.lpLocker;
    const feeLocker = contracts.clankerFeeLocker;
    const feeEscrow = contracts.clankerFeeEscrow;
    try {
      [settled, unsettled, clankerAvailable, clankerV5Owed] = await Promise.all([
        locker ? client.readContract({ address: locker, abi: rwagmiLpLockerV3Abi, functionName: 'claimableQuote', args: [owner, contracts.weth] }) : 0n,
        locker && bootrCoins.length > 0
          ? client.multicall({
              allowFailure: false,
              contracts: bootrCoins.map((c) => ({ address: locker, abi: rwagmiLpLockerV3Abi, functionName: 'pendingQuote' as const, args: [c.poolId as Hex, owner] as const })),
            })
          : [],
        feeLocker ? client.readContract({ address: feeLocker, abi: clankerFeeLockerAbi, functionName: 'availableFees', args: [owner, contracts.weth] }) : 0n,
        // The escrow is shared by every Clanker v5 coin, Bootr's or not: read only for a wallet with a Bootr v5 coin.
        feeEscrow && clankerV5Coins.length > 0 ? client.readContract({ address: feeEscrow, abi: feeEscrowAbi, functionName: 'owed', args: [owner, NATIVE_ETH] }) : 0n,
      ]);
    } catch {
      return fail(502, 'chain_unavailable', 'Could not read the fee lockers and the fee escrow. Nothing was prepared: try again in a moment.');
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
    clankerFeeEscrow,
    clankerV5Owed,
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
        clankerV5: clankerV5Coins.map((c) => ({ token: c.id, symbol: c.symbol })),
      },
      claims,
      note: `Nothing was signed or sent. ${claims.length === 0 ? 'Nothing is waiting to be claimed right now.' : 'Each claim is a transaction for the wallet to send, and amounts are as read just now.'} A Clanker v4 coin’s new fees reach the balance after collectRewards(coin) on Clanker’s LP locker, which anyone may call; in a coin’s first 2 minutes that call credits nothing yet. A Clanker v5 coin’s fees reach Clanker’s fee escrow on every trade and are paid in ETH; totalWei counts ETH and WETH one to one.`,
      ...(env.useMock ? { mock: true } : {}),
    },
    { headers: HEADERS },
  );
}
