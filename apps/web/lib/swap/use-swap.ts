'use client';

/**
 * The trade panel's chain work: live figures, balances and the wallet steps of a swap. All of it goes through the user's
 * own wallet; the only thing added to what `core.ts` builds is the app's builder code.
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { erc20Abi, type Address, type Hash, type PublicClient } from 'viem';
import { useCapabilities, useConfig, useConnection, usePublicClient, useSendCalls, useSendTransaction } from 'wagmi';
import { waitForCallsStatus } from 'wagmi/actions';
import { builderDataSuffix } from '../attribution';
import { parseLaunchSource } from '../launch-source';
import { appChain } from '../chains';
import { env } from '../env';
import { qk } from '../indexer';
import type { Token } from '../types';
import {
  approvalCalls,
  buildBuyTx,
  buildSellTx,
  isErc20Paired,
  pairedCurrency,
  permit2Abi,
  poolKeyOf,
  SWAP_CONTRACTS,
  SWAP_DEADLINE_SECONDS,
  verifiedPoolKey,
  type Allowances,
  type ApprovalCall,
  type LaunchWindow,
  type PoolKey,
  type SwapSide,
  type SwapTx,
} from './core';
import { SwapFailure } from './errors';
import { MOCK_COIN_BALANCE, MOCK_ETH_BALANCE, MOCK_PAIRED_BALANCE, mockQuote } from './mock';
import { quoteSwap, type SwapQuote } from './quote';

/** The chain the panel trades on: Base, or the app's chain in mock mode. */
export const tradeChainId = env.useMock ? appChain.id : SWAP_CONTRACTS.chainId;

const QUOTE_POLL_MS = 12_000;
/** Clanker's launch fee falls every second for its first 16 seconds. */
const QUOTE_POLL_LAUNCH_MS = 4_000;
const BALANCE_POLL_MS = 15_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The pool to trade on, or null when this deployment cannot trade the coin: not on Base, or a coin whose indexed pool id
 * matches neither launch path.
 */
export function tradePoolKey(token: Pick<Token, 'id' | 'poolId' | 'source' | 'pairedToken'>): PoolKey | null {
  // A v5 coin's pool is paired with its quote (native ETH, or USDC for a coin launched with that setting).
  const paired = token.source === 'clanker-v5' ? token.pairedToken : null;
  if (env.useMock) return poolKeyOf(token.id, parseLaunchSource(token.source), paired);
  if (env.chainId !== SWAP_CONTRACTS.chainId) return null;
  return (
    verifiedPoolKey(token.id, 'clanker-v5', token.poolId, paired) ??
    verifiedPoolKey(token.id, 'clanker', token.poolId) ??
    verifiedPoolKey(token.id, 'bootr', token.poolId)
  );
}

export function useTradeClient() {
  return usePublicClient({ chainId: tradeChainId }) as PublicClient | undefined;
}

export function useSwapQuote(token: Token, key: PoolKey | null, side: SwapSide, amountIn: bigint | null) {
  const client = useTradeClient();
  return useQuery<SwapQuote, SwapFailure>({
    queryKey: ['swap', 'quote', token.id.toLowerCase(), side, amountIn?.toString() ?? ''],
    enabled: !!key && !!amountIn && (env.useMock || !!client),
    retry: false,
    gcTime: 0,
    refetchInterval: (q) => {
      const launching = q.state.error?.code === 'launch_window' || (q.state.data?.feePct ?? 0) > 5;
      return launching ? QUOTE_POLL_LAUNCH_MS : QUOTE_POLL_MS;
    },
    queryFn: async () => {
      try {
        if (env.useMock) return mockQuote(token, side, amountIn!);
        return await quoteSwap(client!, { key: key!, side, amountIn: amountIn! });
      } catch (e) {
        throw SwapFailure.from(e);
      }
    },
  });
}

/** `paired`: the wallet's balance of an ERC-20 paired asset (USDC), null on the ETH pools. */
export type SwapBalances = { eth: bigint; coin: bigint; paired: bigint | null };

export function useSwapBalances(coin: Address, owner: Address | undefined, pairedErc20: Address | null = null) {
  const client = useTradeClient();
  return useQuery<SwapBalances>({
    queryKey: ['swap', 'balances', coin.toLowerCase(), owner?.toLowerCase() ?? '', pairedErc20?.toLowerCase() ?? ''],
    enabled: !!owner && (env.useMock || !!client),
    refetchInterval: BALANCE_POLL_MS,
    queryFn: async () => {
      if (env.useMock) return { eth: MOCK_ETH_BALANCE, coin: MOCK_COIN_BALANCE, paired: pairedErc20 ? MOCK_PAIRED_BALANCE : null };
      const [eth, balance, paired] = await Promise.all([
        client!.getBalance({ address: owner! }),
        client!.readContract({ address: coin, abi: erc20Abi, functionName: 'balanceOf', args: [owner!] }),
        pairedErc20 ? client!.readContract({ address: pairedErc20, abi: erc20Abi, functionName: 'balanceOf', args: [owner!] }) : Promise.resolve(null),
      ]);
      return { eth, coin: balance, paired };
    },
  });
}

async function readAllowances(client: PublicClient, owner: Address, coin: Address): Promise<Allowances> {
  const [token, permit2] = await Promise.all([
    client.readContract({ address: coin, abi: erc20Abi, functionName: 'allowance', args: [owner, SWAP_CONTRACTS.permit2] }),
    client.readContract({
      address: SWAP_CONTRACTS.permit2,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [owner, coin, SWAP_CONTRACTS.universalRouter],
    }),
  ]);
  return { token, permit2Amount: permit2[0], permit2Expiration: permit2[1] };
}

/**
 * The approvals a swap paying `amount` of the ERC-20 `coin` still needs (the coin on a sell, USDC on a buy on a USDC
 * pool), to tell the user how many confirmations are coming.
 */
export function useSellApprovals(coin: Address, owner: Address | undefined, amount: bigint | null) {
  const client = useTradeClient();
  return useQuery<ApprovalCall[]>({
    queryKey: ['swap', 'approvals', coin.toLowerCase(), owner?.toLowerCase() ?? '', amount?.toString() ?? ''],
    enabled: !!owner && !!amount && (env.useMock || !!client),
    queryFn: async () => {
      const allowances = env.useMock ? { token: 0n, permit2Amount: 0n, permit2Expiration: 0 } : await readAllowances(client!, owner!, coin);
      return approvalCalls({ coin, amount: amount!, allowances, now: nowSeconds() });
    },
  });
}

/** Whether the connected wallet can do several calls as one transaction (Base Account, and other smart wallets). */
export function useAtomicBatch(): boolean {
  const { isConnected } = useConnection();
  const capabilities = useCapabilities({ chainId: tradeChainId, query: { enabled: isConnected && !env.useMock, retry: false, staleTime: 60_000 } });
  const c = capabilities.data as { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } } | undefined;
  return c?.atomic?.status === 'supported' || c?.atomic?.status === 'ready' || c?.atomicBatch?.supported === true;
}

export type SwapIntent = {
  side: SwapSide;
  coin: Address;
  symbol: string;
  key: PoolKey;
  amountIn: bigint;
  /** The minimum received the user saw: the floor on chain. */
  minOut: bigint;
  launchWindow: LaunchWindow | null;
};

export type SwapResult = { status: 'done'; hash: Hash | null } | { status: 'repriced' };

/** Runs a swap through the wallet. `stage` says what is happening; failures throw `SwapFailure`. */
export function useSwapRunner() {
  const config = useConfig();
  const client = useTradeClient();
  const { address, chainId } = useConnection();
  const sendTransaction = useSendTransaction();
  const sendCalls = useSendCalls();
  const atomic = useAtomicBatch();
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<string | null>(null);

  const run = useCallback(
    async (intent: SwapIntent): Promise<SwapResult> => {
      const { side, coin, symbol, key, amountIn, minOut } = intent;
      const fail = (e: unknown) => SwapFailure.from(e, { launchWindow: intent.launchWindow, now: nowSeconds() });

      const refresh = () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: ['swap'] }),
          queryClient.invalidateQueries({ queryKey: qk.token(coin) }),
        ]);

      try {
        if (!address) throw new SwapFailure('not_connected');
        if (chainId !== tradeChainId) throw new SwapFailure('wrong_chain');

        if (env.useMock) {
          setStage('Confirm in your wallet');
          await new Promise((r) => setTimeout(r, 500));
          return { status: 'done', hash: null };
        }
        if (!client) throw new SwapFailure('network');

        setStage('Checking the price');
        const fresh = await quoteSwap(client, { key, side, amountIn });
        if (fresh.amountOut < minOut) {
          await refresh();
          return { status: 'repriced' };
        }

        const swapArgs = { key, coin, amountIn, minOut, deadline: BigInt(nowSeconds() + SWAP_DEADLINE_SECONDS), dataSuffix: builderDataSuffix };

        /** Dry run: a swap that would revert stops here, in words, before the wallet asks anything. */
        const dryRun = async (tx: SwapTx, attempts = 1) => {
          for (let i = 1; ; i++) {
            try {
              await client.call({ account: address, to: tx.to, data: tx.data, value: tx.value });
              return;
            } catch (e) {
              const failure = fail(e);
              // A flaky read should not block a swap the wallet can still check, and an RPC can lag an approval it just confirmed.
              if (failure.code === 'network') return;
              if (i >= attempts) throw failure;
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
        };

        const sendOne = async (tx: SwapTx): Promise<Hash> => {
          const hash = await sendTransaction.mutateAsync({ to: tx.to, data: tx.data, value: tx.value, chainId: tradeChainId });
          setStage('Waiting for confirmation');
          const receipt = await client.waitForTransactionReceipt({ hash });
          if (receipt.status !== 'success') {
            // Replays the failed transaction for its reason.
            await client.call({ account: address, to: tx.to, data: tx.data, value: tx.value, blockNumber: receipt.blockNumber });
            throw new SwapFailure('reverted');
          }
          return hash;
        };

        // ETH in needs no approval; a sell spends the coin and a buy on a USDC pool spends USDC, both through Permit2.
        if (side === 'buy' && !isErc20Paired(key)) {
          const tx = buildBuyTx(swapArgs);
          await dryRun(tx);
          setStage('Confirm in your wallet');
          return { status: 'done', hash: await sendOne(tx) };
        }

        const tx = side === 'buy' ? buildBuyTx(swapArgs) : buildSellTx(swapArgs);
        const spent = side === 'buy' ? pairedCurrency(key) : coin;
        const allowances = await readAllowances(client, address, spent);
        const approvals = approvalCalls({ coin: spent, amount: amountIn, allowances, now: nowSeconds(), dataSuffix: builderDataSuffix });

        if (approvals.length === 0) {
          await dryRun(tx);
          setStage('Confirm in your wallet');
          return { status: 'done', hash: await sendOne(tx) };
        }

        if (atomic) {
          // One confirmation: the exact approvals and the sell land together or not at all.
          setStage('Confirm in your wallet');
          const { id } = await sendCalls.mutateAsync({
            chainId: tradeChainId,
            forceAtomic: true,
            calls: [...approvals, tx].map(({ to, data, value }) => ({ to, data, value })),
          });
          setStage('Waiting for confirmation');
          const status = await waitForCallsStatus(config, { id, timeout: 180_000 });
          if (status.status !== 'success') throw new SwapFailure('reverted');
          return { status: 'done', hash: status.receipts?.[0]?.transactionHash ?? null };
        }

        const total = approvals.length + 1;
        for (const [i, call] of approvals.entries()) {
          setStage(`Step ${i + 1} of ${total}: approve in your wallet`);
          await sendOne(call);
        }
        await dryRun(tx, 3);
        setStage(`Step ${total} of ${total}: confirm the ${side === 'buy' ? 'buy' : 'sell'} of $${symbol}`);
        return { status: 'done', hash: await sendOne(tx) };
      } catch (e) {
        throw fail(e);
      } finally {
        setStage(null);
        void refresh();
      }
    },
    [address, atomic, chainId, client, config, queryClient, sendCalls, sendTransaction],
  );

  return { run, stage, atomic };
}
