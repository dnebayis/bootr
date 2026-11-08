'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useConnection, useWriteContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { useAgent, useFuelHistory, useHoldings, useTokensByCreator } from '@/lib/indexer';
import { guardianAbi } from '@/lib/abi/guardian';
import { contracts } from '@/lib/contracts';
import { appChain, explorer } from '@/lib/chains';
import { env } from '@/lib/env';
import { useMounted, useNow } from '@/lib/hooks';
import { useTxRunner } from '@/lib/tx';
import { ago, shortAddr, units, usd } from '@/lib/format';
import { formatGas, gasStatus, gasTotal, type KernelGas } from '@/lib/gas';
import { useKernelGas } from '@/lib/use-gas';
import { GasChip } from '@/components/token/GasForm';
import type { Token } from '@/lib/types';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { Panel, Empty } from '@/components/ui/Panel';
import { Button, LinkButton } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { TokenImage } from '@/components/ui/TokenImage';
import { CreatorFees } from './CreatorFees';
import { ClankerCreatorFees } from './ClankerCreatorFees';

export function Rows({ n = 3 }: { n?: number }) {
  return (
    <div className="flex flex-col gap-2 p-5">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}

/** A coin's image, name and symbol, as every list here and on the public creator page shows them. */
export function CoinLabel({ token }: { token: Pick<Token, 'image' | 'symbol' | 'name'> }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <TokenImage src={token.image} symbol={token.symbol} size={28} className="rounded-xs" />
      <span className="truncate text-sm text-ink">{token.name}</span>
      <span className="font-mono text-caption text-mute">${token.symbol}</span>
    </span>
  );
}

const th = 'px-5 py-2 text-left text-caption font-normal text-mute';
const td = 'px-5 py-2.5';

function AgentRow({ token, now, gas }: { token: Token; now: number; gas: KernelGas | null }) {
  const gasWei = gas ? gasTotal(gas) : null;
  const agent = useAgent(token.kernel);
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const client = useQueryClient();
  const status = agent.data?.status ?? token.agent?.status;
  const paused = status === 'paused';
  const final = status === 'dormant' || status === 'claimed';

  const toggle = async () => {
    if (env.useMock) {
      toast.success(`Mock: agent ${paused ? 'resumed' : 'paused'}`);
      return;
    }
    if (!contracts.guardian) return;
    const r = await run(paused ? 'Unpause agent' : 'Pause agent', () =>
      write.mutateAsync({
        address: contracts.guardian!,
        abi: guardianAbi,
        functionName: paused ? 'unpauseAgent' : 'pauseAgent',
        args: [token.kernel as Address],
        chainId: appChain.id,
      }),
    );
    if (r) void client.invalidateQueries({ queryKey: ['agent'] });
  };

  return (
    <tr className="border-t border-hairline">
      <td className={td}>
        <Link href={`/token/${token.id}`} className="hover:text-link">
          <CoinLabel token={token} />
        </Link>
      </td>
      <td className={td}>
        <Link href={`/agent/${token.kernel}`} className="hover:text-link" title="The agent’s public page">
          <StatusDot status={status} withLabel />
        </Link>
      </td>
      <td className={`${td} text-right font-mono text-sm tabular`}>{usd(agent.data?.treasuryUsd, { compact: false })}</td>
      <td className={td}>
        <span className="inline-flex items-center gap-2 font-mono text-sm tabular">
          {gasWei == null ? <span className="text-mute">—</span> : `${formatGas(gasWei)} ETH`}
          {gasWei != null ? <GasChip status={gasStatus(gasWei)} /> : null}
          {gasWei != null && gasStatus(gasWei) === 'empty' && !final ? (
            <Link href={`/token/${token.id}#gas`} className="text-caption text-link hover:underline">
              Add gas
            </Link>
          ) : null}
        </span>
      </td>
      <td className={`${td} font-mono text-caption text-mute`}>{ago(agent.data?.lastActivityAt, now)}</td>
      <td className={`${td} text-right`}>
        <Button
          size="sm"
          variant="secondary"
          onClick={toggle}
          disabled={final || (!env.useMock && !contracts.guardian)}
          loading={!!pending}
          title={!env.useMock && !contracts.guardian ? 'NEXT_PUBLIC_AGENT_GUARDIAN_ADDRESS is not set' : undefined}
        >
          {paused ? 'Unpause' : 'Pause'}
        </Button>
      </td>
    </tr>
  );
}

export function ProfileView() {
  const mounted = useMounted();
  const { address, isConnected } = useConnection();
  const now = useNow();
  const launched = useTokensByCreator(isConnected ? address : undefined);
  const holdings = useHoldings(isConnected ? address : undefined);
  const fuel = useFuelHistory(isConnected ? address : undefined);
  const launchedKernels = useMemo(() => (launched.data ?? []).map((t) => t.kernel as Address), [launched.data]);
  const rwagmiCoins = useMemo(() => (launched.data ?? []).filter((t) => t.source !== 'clanker'), [launched.data]);
  const clankerCoins = useMemo(() => (launched.data ?? []).filter((t) => t.source === 'clanker'), [launched.data]);
  const gas = useKernelGas(launchedKernels);

  if (!mounted) return <Rows n={6} />;

  if (!isConnected || !address) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-md border border-hairline px-6 py-10">
        <p className="text-sm text-mute">Connect a wallet to see the coins you launched, the agents you run and the coins you hold.</p>
        <ConnectButton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2 font-mono text-caption text-mute">
        <a href={explorer.address(address)} target="_blank" rel="noopener noreferrer" className="hover:text-link">
          {shortAddr(address, 10, 8)}
        </a>
        <Link href={`/u/${address}`} className="text-link hover:underline">
          Public page
        </Link>
        {env.useMock ? <span>· mock data</span> : null}
      </div>

      <Panel title="Your agents" bodyClassName="p-0" action={<span className="text-caption text-mute">Pausing stops thoughts and posts. Funds stay put.</span>}>
        {launched.isPending ? (
          <Rows />
        ) : !launched.data?.length ? (
          <Empty action={<LinkButton href="/launch" variant="secondary" size="sm">Launch a coin</LinkButton>}>You have not launched a coin yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead className="bg-canvas-soft">
                <tr>
                  <th scope="col" className={th}>Coin</th>
                  <th scope="col" className={th}>Agent</th>
                  <th scope="col" className={`${th} text-right`}>Treasury</th>
                  <th scope="col" className={th}>Gas</th>
                  <th scope="col" className={th}>Last activity</th>
                  <th scope="col" className={`${th} text-right`}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {launched.data.map((t) => (
                  <AgentRow key={t.id} token={t} now={now} gas={gas.of(t.kernel as Address)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* One panel per launch path: RWAGMI's locker for Bootr coins, Clanker's fee locker for Clanker coins (hidden without
          one). A wallet with Clanker coins only sees the Clanker panel alone; one with no coin at all sees one panel that says so. */}
      {launched.isPending || rwagmiCoins.length > 0 || clankerCoins.length === 0 ? (
        <CreatorFees owner={address} tokens={rwagmiCoins} loading={launched.isPending} />
      ) : null}
      <ClankerCreatorFees owner={address} tokens={clankerCoins} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Tokens you launched" bodyClassName="p-0">
          {launched.isPending ? (
            <Rows />
          ) : !launched.data?.length ? (
            <Empty>Nothing launched from this wallet.</Empty>
          ) : (
            <ul className="divide-y divide-hairline">
              {launched.data.map((t) => (
                <li key={t.id}>
                  <Link href={`/token/${t.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-canvas-sub">
                    <CoinLabel token={t} />
                    <span className="font-mono text-sm text-ink tabular">{usd(t.marketCapUsd)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Bootr coins you hold" bodyClassName="p-0">
          {holdings.isPending ? (
            <Rows />
          ) : !holdings.data?.length ? (
            <Empty>No Bootr coins in this wallet.</Empty>
          ) : (
            <ul className="divide-y divide-hairline">
              {holdings.data.map((h) => (
                <li key={h.token.id}>
                  <Link href={`/token/${h.token.id}`} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-canvas-sub">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <TokenImage src={h.token.image} symbol={h.token.symbol} size={28} className="rounded-xs" />
                      <span className="truncate text-sm text-ink">{h.token.name}</span>
                    </span>
                    <span className="flex items-baseline gap-3 font-mono tabular">
                      <span className="text-caption text-mute">
                        {units(h.balance, 18, 0)} ${h.token.symbol}
                      </span>
                      <span className="text-sm text-ink">{usd(h.valueUsd, { compact: false })}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Fuel history" bodyClassName="p-0">
        {fuel.isPending ? (
          <Rows />
        ) : !fuel.data?.length ? (
          <Empty>You have not fuelled an agent yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse">
              <thead className="bg-canvas-soft">
                <tr>
                  <th scope="col" className={th}>When</th>
                  <th scope="col" className={th}>Agent</th>
                  <th scope="col" className={`${th} text-right`}>Amount</th>
                  <th scope="col" className={`${th} text-right`}>Tx</th>
                </tr>
              </thead>
              <tbody className="font-mono text-sm tabular">
                {fuel.data.map((f) => (
                  <tr key={f.txHash} className="border-t border-hairline">
                    <td className={`${td} text-mute`}>{ago(f.timestamp, now)}</td>
                    <td className={td}>
                      <Link href={`/token/${f.token}`} className="text-ink hover:text-link">
                        ${f.symbol}
                      </Link>
                    </td>
                    <td className={`${td} text-right text-ink`}>{units(f.amountUsdc, 6, 2)} USDC</td>
                    <td className={`${td} text-right`}>
                      <a href={explorer.tx(f.txHash)} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
                        {f.txHash.slice(0, 10)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
