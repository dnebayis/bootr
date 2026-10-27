'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useConnection, useReadContract, useWriteContract } from 'wagmi';
import { formatUnits, isAddress, parseUnits, type Address } from 'viem';
import { toast } from 'sonner';
import { defaultsFromTuple, FALLBACK_BUYBACK, FALLBACK_STANDARD, launcherAbi, type LaunchDefaults } from '@/lib/abi/launcher';
import { guardianAbi } from '@/lib/abi/guardian';
import { erc20Abi } from '@/lib/abi/erc20';
import { contracts, USDC_DECIMALS } from '@/lib/contracts';
import { appChain, explorer } from '@/lib/chains';
import { env } from '@/lib/env';
import { useAgents } from '@/lib/indexer';
import { useNow } from '@/lib/hooks';
import { useTxRunner } from '@/lib/tx';
import { ago, shortAddr, usd } from '@/lib/format';
import type { AgentWithToken } from '@/lib/types';
import type { PlatformConfig } from '@/lib/server/admin-config';
import { Button } from '@/components/ui/Button';
import { Input, Label, Switch } from '@/components/ui/Field';
import { Panel, Empty } from '@/components/ui/Panel';
import { StatusDot } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { cn } from '@/components/ui/cn';
import { PlatformFeesPanel } from './PlatformFees';

const th = 'px-4 py-2 text-left text-caption font-normal text-mute';
const td = 'px-4 py-2.5 align-middle';

function useOwner(address: Address | undefined, abi: typeof launcherAbi | typeof guardianAbi) {
  return useReadContract({ address, abi, functionName: 'owner', chainId: appChain.id, query: { enabled: !!address && !env.useMock } });
}

function OwnerNote({ owner, label }: { owner: Address | undefined; label: string }) {
  const { address } = useConnection();
  if (env.useMock) return <span className="font-mono text-micro text-mute">MOCK</span>;
  if (!owner) return null;
  const me = address?.toLowerCase() === owner.toLowerCase();
  return (
    <span className={cn('font-mono text-micro', me ? 'text-mute' : 'text-danger')} title={`${label} owner ${owner}`}>
      {me ? 'OWNER CONNECTED' : `OWNER ${shortAddr(owner, 6, 4)}`}
    </span>
  );
}

// ------------------------------------------------------------------ launcher defaults

type DraftDefaults = { lpFeePct: string; agent: string; creator: string; burn: string; platform: string; recipient: string; minFuel: string; dormancyDays: string };

function toDraft(d: LaunchDefaults): DraftDefaults {
  return {
    lpFeePct: String(d.lpFeeBps / 10_000),
    agent: String(d.agentBps),
    creator: String(d.creatorBps),
    burn: String(d.burnBps),
    platform: String(d.platformBps),
    recipient: d.platformRecipient,
    minFuel: formatUnits(d.minFuelUsdc, USDC_DECIMALS),
    dormancyDays: String(Math.round(d.dormancyPeriod / 86400)),
  };
}

function LauncherDefaultsPanel() {
  const launcher = contracts.launcher;
  const enabled = !!launcher && !env.useMock;
  const standard = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'standardDefaults', chainId: appChain.id, query: { enabled } });
  const buyback = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'buybackDefaults', chainId: appChain.id, query: { enabled } });
  const paused = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'paused', chainId: appChain.id, query: { enabled } });
  const minPlatform = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'minPlatformBps', chainId: appChain.id, query: { enabled } });
  const owner = useOwner(launcher, launcherAbi);
  const [preset, setPreset] = useState<'standard' | 'buyback'>('standard');
  const current = preset === 'standard' ? (standard.data ? defaultsFromTuple(standard.data) : FALLBACK_STANDARD) : buyback.data ? defaultsFromTuple(buyback.data) : FALLBACK_BUYBACK;
  const [drafts, setDrafts] = useState<Partial<Record<'standard' | 'buyback', DraftDefaults>>>({});
  const draft = drafts[preset] ?? toDraft(current);
  const set = (k: keyof DraftDefaults, v: string) => setDrafts((d) => ({ ...d, [preset]: { ...draft, [k]: v } }));
  const write = useWriteContract();
  const { run, pending } = useTxRunner();

  const nums = { agent: Number(draft.agent), creator: Number(draft.creator), burn: Number(draft.burn), platform: Number(draft.platform) };
  const sum = nums.agent + nums.creator + nums.burn + nums.platform;
  const errors: string[] = [];
  if (Object.values(nums).some((n) => !Number.isInteger(n) || n < 0)) errors.push('Bps must be whole numbers.');
  if (sum !== 10_000) errors.push(`Bps must sum to 10000 (now ${sum}).`);
  if (preset === 'buyback' ? nums.burn === 0 : nums.burn !== 0) errors.push(preset === 'buyback' ? 'Buyback preset needs burn bps > 0.' : 'Standard preset must have burn bps = 0.');
  if (minPlatform.data != null && nums.platform < minPlatform.data) errors.push(`Platform bps must be ≥ ${minPlatform.data}.`);
  const lpFee = Math.round(Number(draft.lpFeePct) * 10_000);
  if (!(lpFee > 0 && lpFee <= 100_000)) errors.push('LP fee must be between 0 and 10%.');
  if (!isAddress(draft.recipient)) errors.push('Platform recipient must be an address.');
  if (!(Number(draft.dormancyDays) >= 30)) errors.push('Dormancy must be at least 30 days.');
  if (!/^\d+(\.\d{0,6})?$/.test(draft.minFuel)) errors.push('Min fuel must be a USDC amount.');

  const submit = async () => {
    if (errors.length) return;
    if (env.useMock) return void toast.success('Mock: setDefaults sent');
    if (!launcher) return;
    const d = {
      lpFeeBps: lpFee,
      agentBps: nums.agent,
      creatorBps: nums.creator,
      burnBps: nums.burn,
      platformBps: nums.platform,
      platformRecipient: draft.recipient as Address,
      minFuelUsdc: parseUnits(draft.minFuel, USDC_DECIMALS),
      dormancyPeriod: Math.round(Number(draft.dormancyDays) * 86400),
    };
    const r = await run('setDefaults', () => write.mutateAsync({ address: launcher, abi: launcherAbi, functionName: 'setDefaults', args: [preset === 'buyback', d], chainId: appChain.id }));
    if (r) {
      void (preset === 'standard' ? standard.refetch() : buyback.refetch());
      setDrafts((x) => ({ ...x, [preset]: undefined }));
    }
  };

  const togglePause = async () => {
    if (env.useMock) return void toast.success('Mock: launcher pause toggled');
    if (!launcher) return;
    const r = await run(paused.data ? 'Unpause launches' : 'Pause launches', () =>
      write.mutateAsync({ address: launcher, abi: launcherAbi, functionName: paused.data ? 'unpause' : 'pause', chainId: appChain.id }),
    );
    if (r) void paused.refetch();
  };

  const field = (k: keyof DraftDefaults, label: string, suffix?: string, mono = true) => (
    <div>
      <Label htmlFor={`d-${k}`}>{label}</Label>
      <Input id={`d-${k}`} mono={mono} suffix={suffix} value={draft[k]} onChange={(e) => set(k, e.target.value.trim())} />
    </div>
  );

  return (
    <Panel title="Launcher defaults" action={<OwnerNote owner={owner.data} label="Launcher" />}>
      {!launcher && !env.useMock ? (
        <p className="text-sm text-mute">NEXT_PUBLIC_LAUNCHER_ADDRESS is not set.</p>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" className="inline-flex rounded-sm border border-hairline p-0.5">
              {(['standard', 'buyback'] as const).map((p) => (
                <button
                  key={p}
                  role="tab"
                  aria-selected={preset === p}
                  onClick={() => setPreset(p)}
                  className={cn('h-7 rounded-xs px-3 text-caption', preset === p ? 'bg-ink text-on-ink' : 'text-mute hover:text-ink')}
                >
                  {p === 'standard' ? 'Standard' : 'Buyback & burn'}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-caption text-mute">Launches {paused.data ? 'paused' : 'open'}</span>
              <Button size="sm" variant="secondary" onClick={togglePause} loading={pending === 'Pause launches' || pending === 'Unpause launches'}>
                {paused.data ? 'Unpause launches' : 'Pause launches'}
              </Button>
            </div>
          </div>
          {standard.isPending && enabled ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                {field('agent', 'Agent bps')}
                {field('creator', 'Creator bps')}
                {field('burn', 'Burn bps')}
                {field('platform', 'Platform bps')}
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                {field('lpFeePct', 'LP fee', '%')}
                {field('minFuel', 'Min fuel', 'USDC')}
                {field('dormancyDays', 'Dormancy', 'days')}
                {field('recipient', 'Platform recipient')}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <ul className="text-caption text-mute">{errors.length ? errors.map((e) => <li key={e}>{e}</li>) : <li>Bps split the full LP fee. Clanker&rsquo;s 20% is charged on top.</li>}</ul>
                <Button variant="ink" onClick={submit} disabled={errors.length > 0} loading={pending === 'setDefaults'}>
                  Send setDefaults({preset === 'buyback' ? 'true' : 'false'})
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ platform config

function PlatformConfigPanel({ initial }: { initial: PlatformConfig }) {
  const now = useNow();
  const [cfg, setCfg] = useState(initial);
  const [models, setModels] = useState(initial.allowedModels.join(', '));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...cfg, allowedModels: models.split(',').map((m) => m.trim()).filter(Boolean) }),
      });
      const body = (await res.json()) as PlatformConfig & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
      setCfg(body);
      setModels(body.allowedModels.join(', '));
      toast.success('Platform config saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const numField = (label: string, value: number, on: (n: number) => void, suffix?: string) => (
    <div>
      <Label>{label}</Label>
      <Input mono suffix={suffix} inputMode="numeric" value={String(value)} onChange={(e) => on(Number(e.target.value.replace(/[^\d]/g, '') || 0))} />
    </div>
  );

  return (
    <Panel
      title="Platform config"
      action={<span className="font-mono text-micro text-mute">{cfg.updatedAt ? `SAVED ${ago(cfg.updatedAt, now).toUpperCase()} BY ${shortAddr(cfg.updatedBy, 6, 4).toUpperCase()}` : 'DEFAULTS'}</span>}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {numField('Graduation threshold', cfg.graduationThresholdUsd, (n) => setCfg({ ...cfg, graduationThresholdUsd: n }), 'USD')}
          {numField('Posts per day', cfg.xQuotas.postsPerDay, (n) => setCfg({ ...cfg, xQuotas: { ...cfg.xQuotas, postsPerDay: n } }))}
          {numField('Replies per day', cfg.xQuotas.repliesPerDay, (n) => setCfg({ ...cfg, xQuotas: { ...cfg.xQuotas, repliesPerDay: n } }))}
          {numField('Post interval min', cfg.postIntervalMinutes.min, (n) => setCfg({ ...cfg, postIntervalMinutes: { ...cfg.postIntervalMinutes, min: n } }), 'min')}
          {numField('Post interval max', cfg.postIntervalMinutes.max, (n) => setCfg({ ...cfg, postIntervalMinutes: { ...cfg.postIntervalMinutes, max: n } }), 'min')}
          <div>
            <Label htmlFor="cfg-swap">Swap link base</Label>
            <Input id="cfg-swap" placeholder="https://app.uniswap.org/swap?outputCurrency=" value={cfg.swapLinkBase} onChange={(e) => setCfg({ ...cfg, swapLinkBase: e.target.value })} />
          </div>
        </div>
        <div>
          <Label htmlFor="cfg-models" hint="Comma-separated model ids">
            Allowed models
          </Label>
          <Input id="cfg-models" mono value={models} onChange={(e) => setModels(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-3 text-sm text-ink">
            <Switch checked={cfg.launchesPaused} onChange={(v) => setCfg({ ...cfg, launchesPaused: v })} label="Pause launches in the app" />
            Pause launches in the app <span className="text-caption text-mute">(off-chain flag; the launcher pause above is the hard stop)</span>
          </label>
          <Button variant="ink" onClick={save} loading={saving} loadingLabel="Saving…">
            Save config
          </Button>
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ agents

function AgentsPanel({ agents, loading }: { agents: AgentWithToken[]; loading: boolean }) {
  const now = useNow();
  const [q, setQ] = useState('');
  const [refuel, setRefuel] = useState<{ kernel: Address; amount: string } | null>(null);
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const guardian = contracts.guardian;

  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return agents.filter((a) => !n || a.id.toLowerCase().includes(n) || a.tokenInfo?.name.toLowerCase().includes(n) || a.tokenInfo?.symbol.toLowerCase().includes(n));
  }, [agents, q]);

  const revoke = async (kernel: Address) => {
    if (env.useMock) return void toast.success('Mock: session keys revoked');
    if (!guardian) return;
    await run('Revoke session keys', () => write.mutateAsync({ address: guardian, abi: guardianAbi, functionName: 'revokeAllSessionKeys', args: [kernel], chainId: appChain.id }));
  };

  const sendRefuel = async () => {
    if (!refuel || !/^\d+(\.\d{0,6})?$/.test(refuel.amount)) return;
    if (env.useMock) {
      toast.success(`Mock: ${refuel.amount} USDC sent`);
      return setRefuel(null);
    }
    const r = await run('Force refuel', () =>
      write.mutateAsync({ address: contracts.usdc, abi: erc20Abi, functionName: 'transfer', args: [refuel.kernel, parseUnits(refuel.amount, USDC_DECIMALS)], chainId: appChain.id }),
    );
    if (r) setRefuel(null);
  };

  return (
    <Panel
      title="Agents"
      bodyClassName="p-0"
      action={<Input placeholder="Filter by name, symbol, kernel" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />}
    >
      <p className="border-b border-hairline px-4 py-2 text-caption text-mute">
        Pause / Resume on AgentGuardian is creator-only on-chain. To stop an agent as the platform, revoke its session keys (bumps the kernel nonce).
        Force refuel sends USDC from the connected wallet.
      </p>
      {loading ? (
        <div className="p-4">
          <Skeleton className="h-48" />
        </div>
      ) : list.length === 0 ? (
        <Empty>No agents match.</Empty>
      ) : (
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full min-w-[860px] border-collapse">
            <thead className="sticky top-0 bg-canvas-soft">
              <tr>
                <th className={th}>Coin</th>
                <th className={th}>Status</th>
                <th className={th}>Kernel</th>
                <th className={`${th} text-right`}>Treasury</th>
                <th className={th}>Last activity</th>
                <th className={`${th} text-right`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} className="border-t border-hairline hover:bg-canvas-sub">
                  <td className={td}>
                    <a href={`/token/${a.token}`} className="text-sm text-ink hover:text-link">
                      {a.tokenInfo?.name ?? shortAddr(a.token)} <span className="font-mono text-caption text-mute">${a.tokenInfo?.symbol}</span>
                    </a>
                  </td>
                  <td className={td}>
                    <StatusDot status={a.status} withLabel />
                  </td>
                  <td className={`${td} font-mono text-caption`}>
                    <a href={explorer.address(a.id)} target="_blank" rel="noopener noreferrer" className="text-body hover:text-link">
                      {shortAddr(a.id, 6, 4)}
                    </a>
                  </td>
                  <td className={`${td} text-right font-mono text-sm tabular`}>{usd(a.treasuryUsd, { compact: false })}</td>
                  <td className={`${td} font-mono text-caption text-mute`}>{ago(a.lastActivityAt, now)}</td>
                  <td className={`${td}`}>
                    {refuel?.kernel === a.id ? (
                      <div className="flex items-center justify-end gap-1.5">
                        <Input mono suffix="USDC" className="w-32" value={refuel.amount} onChange={(e) => setRefuel({ kernel: a.id, amount: e.target.value.trim() })} />
                        <Button size="sm" variant="ink" onClick={sendRefuel} loading={pending === 'Force refuel'}>
                          Send
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRefuel(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="ghost" disabled title="AgentGuardian.pauseAgent / unpauseAgent can only be called by the creator">
                          {a.status === 'paused' ? 'Resume' : 'Pause'}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void revoke(a.id)} disabled={!env.useMock && !guardian} loading={pending === 'Revoke session keys'}>
                          Revoke keys
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setRefuel({ kernel: a.id, amount: '20' })} disabled={a.status === 'claimed'}>
                          Force refuel
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function DormantPanel({ agents, loading }: { agents: AgentWithToken[]; loading: boolean }) {
  const now = useNow();
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const owner = useOwner(contracts.guardian, guardianAbi);
  const dormant = agents.filter((a) => a.status === 'dormant');
  const claimable = dormant.filter((a) => now / 1000 >= a.lastActivityAt + a.dormancyPeriod);
  const total = claimable.reduce((s, a) => s + a.treasuryUsd, 0);

  const claim = async (kernel: Address) => {
    if (env.useMock) return void toast.success('Mock: claimDormant sent');
    if (!contracts.guardian) return;
    await run('claimDormant', () => write.mutateAsync({ address: contracts.guardian!, abi: guardianAbi, functionName: 'claimDormant', args: [kernel], chainId: appChain.id }));
  };

  return (
    <Panel title="Dormant / claimable" bodyClassName="p-0" action={<OwnerNote owner={owner.data} label="Guardian" />}>
      <div className="grid grid-cols-3 gap-px border-b border-hairline bg-hairline">
        {[
          ['Dormant', String(dormant.length)],
          ['Claimable', String(claimable.length)],
          ['Claimable treasury', usd(total, { compact: false })],
        ].map(([k, v]) => (
          <div key={k} className="bg-canvas px-4 py-3">
            <div className="text-caption text-mute">{k}</div>
            <div className="font-mono text-base text-ink tabular">{v}</div>
          </div>
        ))}
      </div>
      {loading ? (
        <div className="p-4">
          <Skeleton className="h-32" />
        </div>
      ) : dormant.length === 0 ? (
        <Empty>No dormant agents.</Empty>
      ) : (
        <table className="w-full border-collapse">
          <thead className="bg-canvas-soft">
            <tr>
              <th className={th}>Coin</th>
              <th className={`${th} text-right`}>Idle</th>
              <th className={`${th} text-right`}>Treasury</th>
              <th className={`${th} text-right`}>
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {dormant.map((a) => {
              const idleDays = Math.floor((now / 1000 - a.lastActivityAt) / 86400);
              const ok = now / 1000 >= a.lastActivityAt + a.dormancyPeriod;
              return (
                <tr key={a.id} className="border-t border-hairline">
                  <td className={td}>
                    <span className="text-sm text-ink">{a.tokenInfo?.name ?? shortAddr(a.token)}</span> <span className="font-mono text-caption text-mute">${a.tokenInfo?.symbol}</span>
                  </td>
                  <td className={`${td} text-right font-mono text-sm tabular`}>{idleDays}d</td>
                  <td className={`${td} text-right font-mono text-sm tabular`}>{usd(a.treasuryUsd, { compact: false })}</td>
                  <td className={`${td} text-right`}>
                    <Button size="sm" variant="ink" onClick={() => void claim(a.id)} disabled={!ok || (!env.useMock && !contracts.guardian)} loading={pending === 'claimDormant'}>
                      claimDormant
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ shell

export function ConsoleView({ admin, initialConfig }: { admin: string; initialConfig: PlatformConfig }) {
  const agents = useAgents();
  const router = useRouter();
  const { isConnected } = useConnection();
  const list = agents.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-display-lg font-semibold text-ink">Console</h1>
          <p className="font-mono text-caption text-mute">Signed in as {shortAddr(admin, 8, 6)}</p>
        </div>
        <div className="flex items-center gap-2">
          {!isConnected ? <ConnectButton /> : null}
          <Button
            variant="secondary"
            onClick={async () => {
              await fetch('/api/siwe/logout', { method: 'POST' });
              router.replace('/');
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
      <div role="note" className="rounded-sm border border-hairline-strong bg-canvas-soft px-4 py-3 text-sm text-ink">
        Splits of existing tokens are locked on-chain; defaults apply to future launches only.
      </div>
      <LauncherDefaultsPanel />
      <PlatformConfigPanel initial={initialConfig} />
      <AgentsPanel agents={list} loading={agents.isPending} />
      <DormantPanel agents={list} loading={agents.isPending} />
      <PlatformFeesPanel agents={list} loading={agents.isPending} />
    </div>
  );
}
