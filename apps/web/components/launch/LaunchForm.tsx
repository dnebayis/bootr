'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useConnection, useReadContract, useWriteContract } from 'wagmi';
import { formatEther, formatUnits, keccak256, parseEther, parseEventLogs, parseUnits, toHex, type Address, zeroAddress } from 'viem';
import { toast } from 'sonner';
import { defaultsFromTuple, FALLBACK_BUYBACK, FALLBACK_STANDARD, launcherAbi, type LaunchDefaults } from '@/lib/abi/launcher';
import { erc20Abi } from '@/lib/abi/erc20';
import { contracts, USDC_DECIMALS } from '@/lib/contracts';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { bps as bpsLabel } from '@/lib/format';
import { fetchModels, fetchPlatformFlags, WORKER_TEMPLATES, type WorkerTemplate } from '@/lib/launch';
import { formatThoughtPrice, groupByProvider, RECOMMENDED_MODEL, THOUGHT } from '@/lib/models';
import { Badge } from '@/components/ui/Badge';
import { agentCardUrl } from '@/lib/agent-card';
import { builderDataSuffix } from '@/lib/attribution';
import { mockLaunch } from '@/lib/mock';
import { useTxRunner } from '@/lib/tx';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select, Switch, Textarea } from '@/components/ui/Field';
import { cn } from '@/components/ui/cn';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { SplitBar } from '@/components/token/FeeSplit';
import { ImageUpload, type ImageUploadState } from './ImageUpload';
import { XConnect } from './XConnect';

function Section({ n, title, description, children }: { n: number; title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-6 border-t border-hairline py-8 md:grid-cols-[240px_minmax(0,1fr)] md:gap-12">
      <div>
        <div className="font-mono text-caption text-mute">{String(n).padStart(2, '0')}</div>
        <h2 className="mt-1 text-display-sm font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-sm text-mute">{description}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
  );
}

const DRAFT_KEY = 'bootr.launch.draftId';

function freshDraftId(): string {
  const v = crypto.randomUUID();
  try {
    sessionStorage.setItem(DRAFT_KEY, v);
  } catch {
    /* private mode: id lives in memory only */
  }
  return v;
}

/**
 * Client-side launch id: the on-chain `context.id`, the agent card key, and the id the X account is
 * connected under before launch (the supervisor rebinds it to the ERC-8004 agent id afterwards).
 * `reset()` issues a new one, so a disconnected X account is never picked up by this launch.
 */
function useDraftId(): [string | null, () => void] {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let v: string | null = null;
    try {
      v = sessionStorage.getItem(DRAFT_KEY);
    } catch {
      v = null;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only id, must not render on the server
    setId(v || freshDraftId());
  }, []);
  return [id, () => setId(freshDraftId())];
}

export function LaunchForm() {
  const router = useRouter();
  const [draftId, resetDraftId] = useDraftId();
  const { address, isConnected } = useConnection();
  const write = useWriteContract();
  const { run, pending } = useTxRunner();

  // 01 Coin
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [upload, setUpload] = useState<ImageUploadState>({ status: 'idle' });

  // 02 Agent
  const [identity, setIdentity] = useState('');
  const [model, setModel] = useState('');
  const [worker, setWorker] = useState<WorkerTemplate['id']>('community');

  // 03 X
  const [xHandle, setXHandle] = useState<string | null>(null);

  // 04 Fuel & options
  const [fuel, setFuel] = useState('20');
  const [devBuy, setDevBuy] = useState('');
  const [buyback, setBuyback] = useState(false);

  // Priced, admin-filtered list from /api/models (the relay itself is internal).
  const models = useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 60_000 });
  // Admin console switches (M-7): paused launches. The model allowlist is applied by /api/models.
  const platform = useQuery({ queryKey: ['platform'], queryFn: fetchPlatformFlags, staleTime: 30_000 });
  const modelList = useMemo(() => models.data?.models ?? [], [models.data]);
  const modelGroups = useMemo(() => groupByProvider(modelList), [modelList]);
  const selectedModel = modelList.find((m) => m.id === model) ?? modelList.find((m) => m.id === RECOMMENDED_MODEL) ?? modelGroups[0]?.models[0];

  const onChain = !!contracts.launcher && !env.useMock;
  const standardRead = useReadContract({ address: contracts.launcher, abi: launcherAbi, functionName: 'standardDefaults', chainId: appChain.id, query: { enabled: onChain } });
  const buybackRead = useReadContract({ address: contracts.launcher, abi: launcherAbi, functionName: 'buybackDefaults', chainId: appChain.id, query: { enabled: onChain } });
  const pausedRead = useReadContract({ address: contracts.launcher, abi: launcherAbi, functionName: 'paused', chainId: appChain.id, query: { enabled: onChain } });
  // Flat ETH launch fee (0 when unset). Added to msg.value next to the dev buy; the contract forwards it to the platform.
  const launchFeeRead = useReadContract({ address: contracts.launcher, abi: launcherAbi, functionName: 'launchFeeWei', chainId: appChain.id, query: { enabled: onChain } });
  const launchFeeWei = launchFeeRead.data ?? 0n;
  const defaults: LaunchDefaults = buyback
    ? buybackRead.data
      ? defaultsFromTuple(buybackRead.data)
      : FALLBACK_BUYBACK
    : standardRead.data
      ? defaultsFromTuple(standardRead.data)
      : FALLBACK_STANDARD;
  const minFuel = Number(formatUnits(defaults.minFuelUsdc, USDC_DECIMALS));

  const fuelUnits = /^\d+(\.\d{0,6})?$/.test(fuel) ? parseUnits(fuel, USDC_DECIMALS) : null;
  const devBuyWei = devBuy === '' ? 0n : /^\d+(\.\d{0,18})?$/.test(devBuy) ? parseEther(devBuy) : null;

  const allowance = useReadContract({
    address: contracts.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && contracts.launcher ? [address, contracts.launcher] : undefined,
    chainId: appChain.id,
    query: { enabled: !!address && !!contracts.launcher && !env.useMock },
  });
  const needsApproval = !env.useMock && fuelUnits != null && (allowance.data ?? 0n) < fuelUnits;

  // Pinned image: the gateway URL goes on-chain (renders on clanker.world and in wallets), the ipfs:// URI into metadata.
  const pinned = upload.status === 'done' ? upload.result : null;
  const split = { agent: defaults.agentBps, creator: defaults.creatorBps, burn: defaults.burnBps, platform: defaults.platformBps };

  const errors: string[] = [];
  if (!name.trim()) errors.push('Name is required.');
  if (!/^[A-Za-z0-9]{2,10}$/.test(symbol)) errors.push('Symbol must be 2–10 letters or digits.');
  if (upload.status === 'uploading') errors.push('Wait for the image to finish uploading.');
  else if (!pinned) errors.push('Upload an image.');
  if (identity.trim().length < 20) errors.push('Describe the agent in at least 20 characters.');
  if (fuelUnits == null || Number(fuel) < minFuel) errors.push(`Fuel must be at least ${minFuel} USDC.`);
  if (devBuyWei == null) errors.push('Dev buy must be a valid ETH amount.');
  const blocked = platform.data?.launchesPaused
    ? 'Launches are paused by the platform.'
    : !env.useMock && !contracts.launcher
      ? 'The launcher contract is not configured (NEXT_PUBLIC_LAUNCHER_ADDRESS).'
      : pausedRead.data
        ? 'Launches are paused by the platform.'
        : !models.isPending && modelList.length === 0
          ? 'No model is available for new agents right now.'
          : null;

  const workerTpl = WORKER_TEMPLATES.find((w) => w.id === worker)!;
  const thoughts = selectedModel?.pricePerThoughtUsd ? Math.floor(Number(fuel || 0) / selectedModel.pricePerThoughtUsd) : null;

  async function approve() {
    if (!contracts.launcher || fuelUnits == null) return;
    const r = await run('Approve USDC', () =>
      write.mutateAsync({ address: contracts.usdc, abi: erc20Abi, functionName: 'approve', args: [contracts.launcher!, fuelUnits], chainId: appChain.id }),
    );
    if (r) void allowance.refetch();
  }

  /**
   * Saves the Identity text under the draft id before the launch tx, so the hosted agent card
   * (`agentURI`) can publish it and the supervisor can give the agent that persona. False when it
   * could not be saved: launching anyway would hand the agent the generic default persona.
   */
  async function saveIdentity(id: string): Promise<boolean> {
    try {
      const res = await fetch('/api/launch/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId: id, identity: identity.trim() }),
      });
      if (res.ok) return true;
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      toast.error(body.message ?? `Could not save the agent identity (${res.status}).`);
    } catch {
      toast.error('Could not save the agent identity. Check your connection and try again.');
    }
    return false;
  }

  async function launch() {
    if (errors.length || blocked || fuelUnits == null || devBuyWei == null || !draftId || !pinned || upload.status !== 'done') return;
    const modelId = selectedModel?.id ?? '';
    if (!(await saveIdentity(draftId))) return;
    if (env.useMock) {
      // The mock CID resolves nowhere, so the mock token keeps the local preview (same document after client navigation).
      const id = mockLaunch({ name: name.trim(), symbol: symbol.toUpperCase(), image: pinned.mock ? upload.preview : pinned.url, model: modelId, buyback, xHandle });
      toast.success(`Mock: $${symbol.toUpperCase()} launched`);
      sessionStorage.removeItem(DRAFT_KEY);
      router.push(`/token/${id}`);
      return;
    }
    const params = {
      name: name.trim(),
      symbol: symbol.toUpperCase(),
      image: pinned.url,
      // Clanker v4 metadata schema (shown on clanker.world): description, auditUrls, socialMediaUrls[{platform,url}].
      // `imageIpfs` is ours: the gateway-independent ipfs:// URI of the same image.
      metadata: JSON.stringify({
        description: `${identity.trim().split('\n')[0]} — an autonomous agent coin launched on Bootr.`,
        socialMediaUrls: [
          ...(xHandle ? [{ platform: 'x', url: `https://x.com/${xHandle}` }] : []),
          { platform: 'website', url: env.siteUrl },
        ],
        imageIpfs: pinned.ipfsUri,
      }),
      context: JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id: draftId }),
      salt: keccak256(toHex(draftId)),
      buybackBurn: buyback,
      fuelUsdc: fuelUnits,
      devBuyWei,
      workerHash: workerTpl.hash,
      model: modelId,
      // Hosted ERC-8004 registration file, keyed by the launch id; see app/agents/[id]/route.ts.
      agentURI: agentCardUrl(draftId),
      supervisorSessionKey: env.supervisorSessionKey ?? zeroAddress, // TODO(supervisor): fetch per-launch key
    } as const;
    const receipt = await run('Launch', () =>
      write.mutateAsync({
        address: contracts.launcher!,
        abi: launcherAbi,
        functionName: 'launch',
        args: [params],
        value: devBuyWei + launchFeeWei,
        chainId: appChain.id,
        dataSuffix: builderDataSuffix,
      }),
    );
    if (!receipt) return;
    const [ev] = parseEventLogs({ abi: launcherAbi, eventName: 'AgentLaunched', logs: receipt.logs });
    const token = (ev?.args as { token?: Address } | undefined)?.token;
    sessionStorage.removeItem(DRAFT_KEY);
    if (token) router.push(`/token/${token}`);
    else toast('Launched. The token page appears once the indexer catches up.');
  }

  return (
    <div className="pb-16">
      {platform.data?.launchesPaused ? (
        <div role="status" className="mb-6 rounded-sm border border-hairline-strong bg-canvas-soft px-4 py-3 text-sm text-ink">
          Launches are paused by the platform. You can prepare a launch, but it cannot be sent until launches resume.
        </div>
      ) : null}
      <Section n={1} title="Coin" description="Name, ticker and image. These are permanent.">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" inputSize="lg" maxLength={48} placeholder="Quiet Engine" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="symbol">Symbol</Label>
            <Input
              id="symbol"
              inputSize="lg"
              mono
              maxLength={10}
              placeholder="QENG"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            />
          </div>
        </div>
        <ImageUpload draftId={draftId} state={upload} onState={setUpload} />
      </Section>

      <Section n={2} title="Agent" description="Who the agent is, which model thinks for it, and what it works on.">
        <div>
          <Label htmlFor="identity" hint={`${identity.length}/600`}>
            Identity
          </Label>
          <Textarea
            id="identity"
            rows={4}
            maxLength={600}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            placeholder={'Who it is: a patient onchain analyst for small Base coins.\nHow it talks: short, plain, no hype, no emoji.\nWhat it never does: give price targets or financial advice.'}
          />
        </div>
        <div>
          <Label htmlFor="model" hint={models.data?.source === 'fallback' ? 'Estimated prices' : 'Price per thought'}>
            Model
          </Label>
          <Select id="model" value={selectedModel?.id ?? ''} onChange={(e) => setModel(e.target.value)} disabled={models.isPending || modelList.length === 0}>
            {models.isPending ? <option value="">Loading models…</option> : null}
            {modelGroups.map((g) => (
              <optgroup key={g.provider} label={g.provider}>
                {g.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {formatThoughtPrice(m.pricePerThoughtUsd)}
                    {m.id === RECOMMENDED_MODEL ? ' · Recommended' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          {selectedModel ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-mute" data-testid="model-summary">
              <span className="text-ink">{selectedModel.label}</span>
              <span>{selectedModel.provider}</span>
              <span className="font-mono tabular text-ink">{formatThoughtPrice(selectedModel.pricePerThoughtUsd)}</span>
              <span>per thought</span>
              {selectedModel.id === RECOMMENDED_MODEL ? <Badge>Recommended</Badge> : null}
            </div>
          ) : null}
          <p className="mt-1 text-caption text-mute">
            A thought is one model call: the agent reads its context (about {THOUGHT.promptTokens.toLocaleString('en-US')} tokens) and decides what to do next (up to{' '}
            {THOUGHT.outputTokens.toLocaleString('en-US')} tokens). Each one is paid in USDC from the agent&rsquo;s fuel.
          </p>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-caption font-medium text-ink">Worker template</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {WORKER_TEMPLATES.map((w) => (
              <label
                key={w.id}
                className={cn(
                  'flex cursor-pointer flex-col gap-1.5 rounded-sm border p-3 transition-colors duration-150',
                  worker === w.id ? 'border-ink' : 'border-hairline hover:border-hairline-strong',
                )}
              >
                <input type="radio" name="worker" value={w.id} checked={worker === w.id} onChange={() => setWorker(w.id)} className="sr-only" />
                <span className="text-sm font-medium text-ink">{w.label}</span>
                <span className="text-caption text-mute">{w.description}</span>
                <span className="mt-auto truncate font-mono text-micro text-mute" title={w.hash}>
                  {w.hash.slice(0, 10)}… placeholder
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section n={3} title="X account" description="The agent posts from its own account. Connect it here.">
        <XConnect
          draftId={draftId}
          handle={xHandle}
          onHandle={(h) => {
            // Disconnect: drop the draft id the account was bound to, so it is not rebound after launch.
            if (!h && xHandle && !env.useMock) resetDraftId();
            setXHandle(h);
          }}
          symbol={symbol}
        />
      </Section>

      <Section n={4} title="Fuel & options" description="Starting treasury, an optional dev buy, and the fee preset.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="fuel" hint={`Min ${minFuel} USDC`}>
              Fuel
            </Label>
            <Input id="fuel" inputSize="lg" inputMode="decimal" mono suffix="USDC" value={fuel} onChange={(e) => setFuel(e.target.value.trim())} aria-invalid={fuelUnits == null || Number(fuel) < minFuel} />
            <p className="mt-1.5 text-caption text-mute">{thoughts != null ? `About ${thoughts.toLocaleString('en-US')} thoughts at the selected model.` : 'Pays for the agent’s thoughts.'}</p>
          </div>
          <div>
            <Label htmlFor="devbuy" hint="Optional">
              Dev buy
            </Label>
            <Input id="devbuy" inputSize="lg" inputMode="decimal" mono suffix="ETH" placeholder="0" value={devBuy} onChange={(e) => setDevBuy(e.target.value.trim())} aria-invalid={devBuyWei == null} />
            <p className="mt-1.5 text-caption text-mute">Bought in the launch transaction, sent to your wallet.</p>
          </div>
        </div>
        <div className="flex items-start justify-between gap-6 rounded-sm border border-hairline p-4">
          <div>
            <label htmlFor="buyback" className="text-sm font-medium text-ink">
              Buyback & burn
            </label>
            <p className="mt-0.5 text-caption text-mute">Sends {bpsLabel(buybackRead.data ? defaultsFromTuple(buybackRead.data).burnBps : FALLBACK_BUYBACK.burnBps)} of the LP fee to buy this coin back and burn it, taken from the creator share. The locker converts it on-chain.</p>
          </div>
          <Switch id="buyback" checked={buyback} onChange={setBuyback} label="Buyback and burn" />
        </div>
        <div className="rounded-sm border border-hairline p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-ink">Split preview</span>
            <span className="font-mono text-caption text-mute">
              {[split.agent, split.creator, split.burn, split.platform].filter((v) => v > 0).map((v) => v / 100).join('/')} of the LP fee
            </span>
          </div>
          <SplitBar split={split} lpFeeBps={defaults.lpFeeBps} />
        </div>

        <dl className="grid gap-px overflow-hidden rounded-sm border border-hairline bg-hairline text-sm sm:grid-cols-2">
          {[
            ['Coin', name && symbol ? `${name} · $${symbol}` : '—'],
            ['Model', selectedModel?.label ?? '—'],
            ['Worker', workerTpl.label],
            ['X account', xHandle ? `@${xHandle}` : 'Not connected'],
            ['Fuel', `${fuel || 0} USDC`],
            ['Dev buy', devBuy ? `${devBuy} ETH` : 'None'],
            ['Launch fee', launchFeeWei > 0n ? `${formatEther(launchFeeWei)} ETH` : 'None'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 bg-canvas px-3 py-2">
              <dt className="text-mute">{k}</dt>
              <dd className="truncate font-mono text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        {!xHandle ? <p className="text-caption text-mute">Without an X account the agent runs but stays silent until one is connected.</p> : null}

        <div className="flex flex-col gap-3">
          {blocked ? <p className="text-sm text-danger">{blocked}</p> : null}
          {errors.length > 0 && (name || symbol || identity) ? (
            <ul className="flex flex-col gap-0.5 text-caption text-mute">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          {!isConnected && !env.useMock ? (
            <div className="flex items-center gap-3">
              <ConnectButton />
              <span className="text-caption text-mute">Connect a wallet on {appChain.name} to launch.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {needsApproval ? (
                <Button variant="secondary" size="lg" onClick={approve} loading={pending === 'Approve USDC'} disabled={!!blocked || fuelUnits == null}>
                  1. Approve {fuel} USDC
                </Button>
              ) : null}
              <Button
                variant="primary"
                size="lg"
                onClick={launch}
                disabled={errors.length > 0 || !!blocked || needsApproval || !draftId}
                loading={pending === 'Launch'}
                className="sm:min-w-40"
              >
                {needsApproval ? '2. Launch' : 'Launch'}
              </Button>
              {env.useMock ? <span className="text-caption text-mute">Mock mode: no transaction is sent.</span> : null}
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
