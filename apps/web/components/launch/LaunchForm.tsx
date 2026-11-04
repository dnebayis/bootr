'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useConnection, useReadContract, useWriteContract } from 'wagmi';
import { formatEther, formatUnits, keccak256, parseEther, parseEventLogs, parseUnits, toHex, type Address, zeroAddress } from 'viem';
import { entryPoint, entryPointAbi, GAS_TOPUP_DEFAULT_ETH, GAS_TOPUP_MIN_ETH, validTopUp } from '@/lib/gas';
import { toast } from 'sonner';
import {
  CADENCE_OPTIONS,
  CAPABILITIES,
  CUSTOM_WORKER_ID,
  customWorker,
  normalizeWorkerPreset,
  WORKER_BOUNDS,
  type CapabilityKey,
  type WorkerPreset,
  type WorkerTemplateId,
} from '@bootr/shared/workers';
import { clankerLauncherAbi, defaultsFromTuple, FALLBACK_BUYBACK, FALLBACK_STANDARD, launcherAbi, type LaunchDefaults } from '@/lib/abi/launcher';
import { erc20Abi } from '@/lib/abi/erc20';
import { ofVolume, pctLabel, traderPaysPct, type FeeModel } from '@/lib/fee-split';
import type { LaunchSource } from '@/lib/types';
import { contracts, USDC_DECIMALS } from '@/lib/contracts';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { fetchModels, fetchPlatformFlags, WORKER_TEMPLATES } from '@/lib/launch';
import { formatThoughtPrice, groupByProvider, RECOMMENDED_MODEL, THOUGHT } from '@/lib/models';
import { Badge } from '@/components/ui/Badge';
import { agentCardUrl, contractUriUrl } from '@/lib/agent-card';
import { builderDataSuffix } from '@/lib/attribution';
import { mockLaunch } from '@/lib/mock';
import { useTxRunner } from '@/lib/tx';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select, Switch, Textarea } from '@/components/ui/Field';
import { cn } from '@/components/ui/cn';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { SplitBar } from '@/components/token/FeeSplit';
import { AgentPortrait } from '@/components/art/AgentPortrait';
import { ImageUpload, type ImageUploadState } from './ImageUpload';
import { XConnect } from './XConnect';
import { normalizeXLink, xHandleOfUrl } from '@/lib/x-link';

function Section({ n, title, description, children }: { n: number; title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 border-t border-hairline py-8">
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

/** What the creator picks in 03 Kind: a preset (its template hash goes on-chain) or a custom worker. */
type Kind = WorkerTemplateId | typeof CUSTOM_WORKER_ID;

/** The powers a creator can switch; `memory` and `treasury` are always on (the fee -> fuel loop needs the treasury). */
const POWER_KEYS = ['xRead', 'xReply', 'xPublish', 'research', 'images'] as const satisfies readonly CapabilityKey[];
type PowerKey = (typeof POWER_KEYS)[number];
const ALWAYS_ON = ['memory', 'treasury'] as const satisfies readonly CapabilityKey[];

const H = 60 * 60 * 1000;
const DEFAULT_CADENCE_MS = 2 * H;
const DEFAULT_POWERS: Record<PowerKey, boolean> = { xRead: true, xReply: true, xPublish: true, research: true, images: true };

function cadenceLabel(ms: number): string {
  const known = CADENCE_OPTIONS.find((o) => o.ms === ms);
  if (known) return known.label;
  if (ms % H === 0) return `Every ${ms / H} h`;
  return `Every ${Math.round(ms / 60_000)} min`;
}

/**
 * The two launch paths (docs/design/clanker-launch.md). Plain words: what the coin opens at, who takes what from the
 * fee, where it is listed. The form keeps the 1% fee for everyone; only the platform's own coin uses another fee.
 */
const LAUNCH_THROUGH: { id: LaunchSource; label: string; lines: string[] }[] = [
  {
    id: 'bootr',
    label: 'RWAGMI',
    lines: [
      'Opens at about 2.7 ETH of market cap (around $6k).',
      '1% fee on every trade: 90% of it goes to the agent, you and the platform, 10% to RWAGMI, the launcher.',
      'Listed on bootr.fun.',
    ],
  },
  {
    id: 'clanker',
    label: 'Clanker',
    lines: [
      'Opens at about 10 ETH of market cap (around $27k).',
      '1% fee on every trade, all of it to the agent, you and the platform; Clanker adds 20% on top, so a trader pays 1.2%.',
      'Listed on bootr.fun and clanker.world.',
    ],
  },
];

const KIND_CARDS: { id: Kind; label: string; description: string; does: string[] }[] = [
  ...WORKER_TEMPLATES.map((w) => ({ id: w.id as Kind, label: w.label, description: w.description, does: w.does })),
  {
    id: CUSTOM_WORKER_ID,
    label: 'Custom',
    description: 'Pick its powers and cadence, and write its own job lines.',
    does: ['Any of the five powers', 'Any cadence from 30 min to once a day', `Up to ${WORKER_BOUNDS.maxJobLines} job lines`, 'Claims fees and keeps its treasury'],
  },
];

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
  // Optional links, shown on the coin page and written into the contract URI. Telegram and Discord on their own hosts;
  // X is the project's account (a URL or a handle), not the agent's, which is connected in section 04.
  const [website, setWebsite] = useState('');
  const [projectX, setProjectX] = useState('');
  const [telegram, setTelegram] = useState('');
  const [discord, setDiscord] = useState('');

  // 02 Mind
  const [model, setModel] = useState('');
  const [modelQuery, setModelQuery] = useState('');

  // 03 Kind: a preset, or a custom worker with its own powers and cadence.
  const [kind, setKind] = useState<Kind>('community');
  const [customPowers, setCustomPowers] = useState<Record<PowerKey, boolean>>(DEFAULT_POWERS);
  const [customCadenceMs, setCustomCadenceMs] = useState(DEFAULT_CADENCE_MS);

  // 04 Character: the Instructions text and, for a custom worker, its job lines.
  const [identity, setIdentity] = useState('');
  const [jobLines, setJobLines] = useState<string[]>(['']);

  // 05 X
  const [xHandle, setXHandle] = useState<string | null>(null);
  // Launching without an X account is allowed, but never by accident: the agent is silent until one is connected.
  const [silentOk, setSilentOk] = useState(false);

  // 06 Fuel & options
  const [fuel, setFuel] = useState('20');
  // The agent's first gas: ETH the creator deposits into the EntryPoint for the new kernel right after the launch
  // (a second transaction). The platform pays no gas; the agent refills from its own WETH fees afterwards.
  const [gas, setGas] = useState(GAS_TOPUP_DEFAULT_ETH);
  const [devBuy, setDevBuy] = useState('');
  const [buyback, setBuyback] = useState(false);
  // Launch through RWAGMI (the default; source id 'bootr') or Clanker. The Clanker launcher is optional per deployment; while it
  // is not configured the choice is hidden and every launch goes through RWAGMI. Mock mode always offers both.
  const clankerAvailable = env.useMock || !!contracts.clankerLauncher;
  const [launchThroughPick, setLaunchThrough] = useState<LaunchSource>('bootr');
  const launchThrough: LaunchSource = clankerAvailable ? launchThroughPick : 'bootr';
  const launcher = launchThrough === 'clanker' ? contracts.clankerLauncher : contracts.launcher;
  const abi = launchThrough === 'clanker' ? clankerLauncherAbi : launcherAbi;
  const fee: FeeModel = { source: launchThrough, lpFeeBps: 10_000 };

  // Priced, admin-filtered list from /api/models (the relay itself is internal).
  const models = useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 60_000 });
  // Admin console switches (M-7): paused launches. The model allowlist is applied by /api/models.
  const platform = useQuery({ queryKey: ['platform'], queryFn: fetchPlatformFlags, staleTime: 30_000 });
  const modelList = useMemo(() => models.data?.models ?? [], [models.data]);
  const selectedModel = modelList.find((m) => m.id === model) ?? modelList.find((m) => m.id === RECOMMENDED_MODEL) ?? groupByProvider(modelList)[0]?.models[0];
  // The search box narrows the list; the selected model always stays in it so the select never shows blank.
  const modelGroups = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const list = q ? modelList.filter((m) => m.id === selectedModel?.id || `${m.label} ${m.provider} ${m.id}`.toLowerCase().includes(q)) : modelList;
    return groupByProvider(list);
  }, [modelList, modelQuery, selectedModel?.id]);

  // Presets, pause switch and launch fee come from the chosen launcher (both launchers share the ABI).
  const onChain = !!launcher && !env.useMock;
  const standardRead = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'standardDefaults', chainId: appChain.id, query: { enabled: onChain } });
  const buybackRead = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'buybackDefaults', chainId: appChain.id, query: { enabled: onChain } });
  const pausedRead = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'paused', chainId: appChain.id, query: { enabled: onChain } });
  // Flat ETH launch fee (0 when unset). Added to msg.value next to the dev buy; the contract forwards it to the platform.
  const launchFeeRead = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'launchFeeWei', chainId: appChain.id, query: { enabled: onChain } });
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
  // Empty or 0 = launch without gas (the agent waits until someone adds some); otherwise at least the form minimum.
  const gasWei = gas === '' || /^0(\.0*)?$/.test(gas) ? 0n : validTopUp(gas) ? parseEther(gas) : null;

  const allowance = useReadContract({
    address: contracts.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && launcher ? [address, launcher] : undefined,
    chainId: appChain.id,
    query: { enabled: !!address && !!launcher && !env.useMock },
  });
  const needsApproval = !env.useMock && fuelUnits != null && (allowance.data ?? 0n) < fuelUnits;

  // Pinned image: the gateway URL goes on-chain (renders in wallets and explorers), the ipfs:// URI into metadata.
  const pinned = upload.status === 'done' ? upload.result : null;
  const preview = upload.status === 'idle' ? null : upload.preview;
  // The launcher's presets are out of 10000. Through Bootr the locker stores them as 9000-bps slots of the 1% swap fee
  // (RWAGMI takes the other 10%), so agent 500 -> slot 450 -> 0.045% of volume; through Clanker the slots share the
  // whole fee (agent 500 -> 0.05%) and Clanker charges 20% on top.
  const split = { agent: defaults.agentBps, creator: defaults.creatorBps, burn: defaults.burnBps, platform: defaults.platformBps };
  const buybackDefaults = buybackRead.data ? defaultsFromTuple(buybackRead.data) : FALLBACK_BUYBACK;
  const burnPct = ofVolume({ agent: buybackDefaults.agentBps, creator: buybackDefaults.creatorBps, burn: buybackDefaults.burnBps, platform: buybackDefaults.platformBps }, 'burn', fee);

  // The worker the launch commits to. Presets: the template and its hash. Custom: the preset built from the form,
  // normalized like the server does (always-on powers forced, empty job lines dropped), hashed like a template.
  const template = WORKER_TEMPLATES.find((w) => w.id === kind) ?? null;
  const customPreset = useMemo<WorkerPreset | null>(
    () =>
      kind === CUSTOM_WORKER_ID
        ? normalizeWorkerPreset({ capabilities: { ...customPowers, memory: true, treasury: true }, postIntervalMs: customCadenceMs, identity: jobLines })
        : null,
    [kind, customPowers, customCadenceMs, jobLines],
  );
  const custom = customPreset ? customWorker(customPreset) : null;
  const workerHash = template ? template.hash : custom ? custom.hash : null;
  const kindLabel = KIND_CARDS.find((k) => k.id === kind)?.label ?? kind;
  // What the Powers grid and the Cadence select show: the preset's values (read-only) or the custom ones (editable).
  const shownPowers: Record<PowerKey, boolean> = template ? template.preset.capabilities : customPowers;
  const shownCadenceMs = template ? template.preset.postIntervalMs : customCadenceMs;
  const cadenceChoices = CADENCE_OPTIONS.some((o) => o.ms === shownCadenceMs) ? CADENCE_OPTIONS : [...CADENCE_OPTIONS, { ms: shownCadenceMs, label: cadenceLabel(shownCadenceMs) }].sort((a, b) => a.ms - b.ms);
  const shownJobLines = template ? template.preset.identity : jobLines;

  const errors: string[] = [];
  if (!name.trim()) errors.push('Name is required.');
  if (!/^[A-Za-z0-9]{2,10}$/.test(symbol)) errors.push('Symbol must be 2–10 letters or digits.');
  if (upload.status === 'uploading') errors.push('Wait for the image to finish uploading.');
  else if (!pinned) errors.push('Upload an image.');
  if (identity.trim().length < 20) errors.push('Write at least 20 characters of instructions.');
  if (kind === CUSTOM_WORKER_ID && !customPreset) errors.push(`Job lines must be at most ${WORKER_BOUNDS.maxJobLineChars} characters each.`);
  const link = (v: string, host?: RegExp) => {
    const s = v.trim();
    return !s ? null : s.length <= 200 && /^https:\/\/[^\s"<>]+$/.test(s) && (!host || host.test(s)) ? s : undefined;
  };
  const links = {
    website: link(website),
    x: normalizeXLink(projectX),
    telegram: link(telegram, /^https:\/\/t\.me\//i),
    discord: link(discord, /^https:\/\/(discord\.gg|discord\.com\/invite)\//i),
  };
  if (links.website === undefined) errors.push('Website must be an https URL.');
  if (links.x === undefined) errors.push('X must be an x.com link or a handle.');
  if (links.telegram === undefined) errors.push('Telegram must be an https://t.me/ link.');
  if (links.discord === undefined) errors.push('Discord must be an https://discord.gg/ invite.');
  if (fuelUnits == null || Number(fuel) < minFuel) errors.push(`Fuel must be at least ${minFuel} USDC.`);
  if (devBuyWei == null) errors.push('Dev buy must be a valid ETH amount.');
  if (gasWei == null) errors.push(`Gas must be 0 or at least ${GAS_TOPUP_MIN_ETH} ETH.`);
  if (!xHandle && !silentOk) errors.push('Connect an X account, or confirm launching without one.');
  const blocked = platform.data?.launchesPaused
    ? 'Launches are paused by the platform.'
    : !env.useMock && !launcher
      ? launchThrough === 'clanker'
        ? 'The Clanker launcher is not configured (NEXT_PUBLIC_CLANKER_LAUNCHER_ADDRESS).'
        : 'The launcher contract is not configured (NEXT_PUBLIC_LAUNCHER_ADDRESS).'
      : pausedRead.data
        ? 'Launches are paused by the platform.'
        : !models.isPending && modelList.length === 0
          ? 'No model is available for new agents right now.'
          : null;

  const thoughts = selectedModel?.pricePerThoughtUsd ? Math.floor(Number(fuel || 0) / selectedModel.pricePerThoughtUsd) : null;

  async function approve() {
    if (!launcher || fuelUnits == null) return;
    const r = await run('Approve USDC', () =>
      write.mutateAsync({ address: contracts.usdc, abi: erc20Abi, functionName: 'approve', args: [launcher, fuelUnits], chainId: appChain.id }),
    );
    if (r) void allowance.refetch();
  }

  /**
   * Saves the Instructions text, the coin metadata and the worker choice under the draft id before the launch tx,
   * so the hosted agent card (`agentURI`) can publish the text (the supervisor gives the agent that persona) and,
   * for a custom worker, the preset behind the on-chain hash (`bootr.worker`), and the hosted contract URI
   * (`metadata`) can describe the coin. False when it could not be saved: launching anyway would hand the agent
   * the generic default persona and the coin an empty contract URI.
   */
  type DraftLinks = { website: string | null; x: string | null; telegram: string | null; discord: string | null };
  async function saveDraft(id: string, coin: { name: string; symbol: string; image: string; imageIpfs: string | null; xHandle: string | null; links: DraftLinks }): Promise<boolean> {
    const worker = kind === CUSTOM_WORKER_ID ? { kind, preset: customPreset } : { kind };
    try {
      const res = await fetch('/api/launch/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId: id, identity: identity.trim(), coin, worker, launchThrough }),
      });
      if (res.ok) return true;
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      toast.error(body.message ?? `Could not save the agent instructions (${res.status}).`);
    } catch {
      toast.error('Could not save the agent instructions. Check your connection and try again.');
    }
    return false;
  }

  async function launch() {
    if (errors.length || blocked || fuelUnits == null || devBuyWei == null || gasWei == null || !draftId || !pinned || upload.status !== 'done' || !workerHash) return;
    if (links.website === undefined || links.x === undefined || links.telegram === undefined || links.discord === undefined) return;
    const modelId = selectedModel?.id ?? '';
    const coin = { name: name.trim(), symbol: symbol.toUpperCase(), image: pinned.url, imageIpfs: pinned.ipfsUri || null, xHandle, links: links as DraftLinks };
    if (!(await saveDraft(draftId, coin))) return;
    if (env.useMock) {
      // The mock CID resolves nowhere, so the mock token keeps the local preview (same document after client navigation).
      const id = mockLaunch({ name: name.trim(), symbol: symbol.toUpperCase(), image: pinned.mock ? upload.preview : pinned.url, model: modelId, buyback, xHandle, source: launchThrough, links: coin.links });
      toast.success(`Mock: $${symbol.toUpperCase()} launched${gasWei > 0n ? ` with ${gas} ETH of gas` : ''}`);
      sessionStorage.removeItem(DRAFT_KEY);
      router.push(`/token/${id}`);
      return;
    }
    const params = {
      name: name.trim(),
      symbol: symbol.toUpperCase(),
      image: pinned.url,
      // Hosted ERC-7572 contract URI (app/tokens/[id]/route.ts, from the draft saved above); BootrLauncher sets it
      // as the B20 token's `contractURI`.
      metadata: contractUriUrl(draftId),
      context: JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id: draftId }),
      salt: keccak256(toHex(draftId)),
      buybackBurn: buyback,
      fuelUsdc: fuelUnits,
      devBuyWei,
      workerHash,
      model: modelId,
      // Hosted ERC-8004 registration file, keyed by the launch id; see app/agents/[id]/route.ts.
      agentURI: agentCardUrl(draftId),
      supervisorSessionKey: env.supervisorSessionKey ?? zeroAddress, // TODO(supervisor): fetch per-launch key
    } as const;
    // The chosen launcher; both take the same `LaunchParams`. On the Clanker path the token address is not predictable
    // up front, so (as on the Bootr path) it is read from the receipt's `AgentLaunched` log below.
    if (!launcher) return;
    const receipt = await run('Launch', () =>
      write.mutateAsync({
        address: launcher,
        abi,
        functionName: 'launch',
        args: [params],
        value: devBuyWei + launchFeeWei,
        chainId: appChain.id,
        dataSuffix: builderDataSuffix,
      }),
    );
    if (!receipt) return;
    const [ev] = parseEventLogs({ abi, eventName: 'AgentLaunched', logs: receipt.logs });
    const { token, kernel } = (ev?.args as { token?: Address; kernel?: Address } | undefined) ?? {};
    sessionStorage.removeItem(DRAFT_KEY);
    if (gasWei > 0n && kernel) {
      // The agent's first gas, from the creator's wallet. Skipping or failing this leaves a launched coin whose
      // agent waits for gas; the token page's "Add gas" covers it later.
      const deposited = await run('Add gas', () =>
        write.mutateAsync({ address: entryPoint, abi: entryPointAbi, functionName: 'depositTo', args: [kernel], value: gasWei, chainId: appChain.id, dataSuffix: builderDataSuffix }),
      );
      if (!deposited) toast('Launched without gas. Add gas from the token page so the agent can start.');
    }
    if (token) router.push(`/token/${token}`);
    else toast('Launched. The token page appears once the indexer catches up.');
  }

  const costLine = [`${launchFeeWei > 0n ? formatEther(launchFeeWei) : '0'} ETH`, `${gasWei && gasWei > 0n ? gas : '0'} ETH`, `${fuel || 0} USDC`].join(' + ');

  return (
    <div className="grid gap-8 pb-16 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-12">
      <div className="min-w-0">
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
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-caption font-medium text-ink">Links</span>
              <span className="text-caption text-mute">Optional</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="website">Website</Label>
                <Input id="website" inputMode="url" placeholder="https://" maxLength={200} value={website} onChange={(e) => setWebsite(e.target.value)} aria-invalid={links.website === undefined} />
              </div>
              <div>
                <Label htmlFor="project-x">X</Label>
                <Input id="project-x" placeholder="@handle or https://x.com/handle" maxLength={200} value={projectX} onChange={(e) => setProjectX(e.target.value)} aria-invalid={links.x === undefined} />
                <p className="mt-1 text-caption text-mute">The project&rsquo;s account (the agent gets its own).</p>
              </div>
              <div>
                <Label htmlFor="telegram">Telegram</Label>
                <Input id="telegram" inputMode="url" placeholder="https://t.me/" maxLength={200} value={telegram} onChange={(e) => setTelegram(e.target.value)} aria-invalid={links.telegram === undefined} />
              </div>
              <div>
                <Label htmlFor="discord">Discord</Label>
                <Input id="discord" inputMode="url" placeholder="https://discord.gg/" maxLength={200} value={discord} onChange={(e) => setDiscord(e.target.value)} aria-invalid={links.discord === undefined} />
              </div>
            </div>
            <p className="mt-1.5 text-caption text-mute">
              Shown on the coin page and written into the coin&rsquo;s contract metadata, with your wallet as the creator. The agent&rsquo;s X account is connected
              below.
            </p>
          </div>
        </Section>

        <Section n={2} title="Mind" description="The model that thinks for the agent. Each thought is paid from its fuel.">
          <div>
            <Label htmlFor="model" hint={models.data?.source === 'fallback' ? 'Estimated prices' : 'Price per thought'}>
              Model
            </Label>
            <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
              <Input id="model-search" type="search" aria-label="Search models" placeholder="Search models" value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} disabled={models.isPending || modelList.length === 0} />
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
            </div>
            {modelQuery.trim() && modelGroups.every((g) => g.models.every((m) => m.id === selectedModel?.id)) ? (
              <p className="mt-1.5 text-caption text-mute">No other model matches &ldquo;{modelQuery.trim()}&rdquo;.</p>
            ) : null}
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
        </Section>

        <Section n={3} title="Kind" description="What the agent is for. The preset's hash is written on-chain at launch.">
          <fieldset>
            <legend className="sr-only">Kind</legend>
            <div className="grid gap-2 sm:grid-cols-2" data-testid="kind-cards">
              {KIND_CARDS.map((k) => {
                const tpl = WORKER_TEMPLATES.find((w) => w.id === k.id);
                const hash = tpl ? tpl.hash : custom?.hash;
                return (
                  <label
                    key={k.id}
                    className={cn(
                      'flex cursor-pointer flex-col gap-1.5 rounded-sm border p-3 transition-colors duration-150',
                      kind === k.id ? 'border-ink' : 'border-hairline hover:border-hairline-strong',
                    )}
                  >
                    <input type="radio" name="kind" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} className="sr-only" />
                    <span className="text-sm font-medium text-ink">{k.label}</span>
                    <span className="text-caption text-mute">{k.description}</span>
                    <ul className="mt-1 flex flex-col gap-0.5 text-micro text-body">
                      {k.does.map((d) => (
                        <li key={d}>· {d}</li>
                      ))}
                    </ul>
                    <span
                      className="mt-auto truncate font-mono text-micro text-mute"
                      title={hash ? `${hash} (keccak256 of the ${tpl ? 'template' : 'custom worker'} definition, written on-chain at launch)` : undefined}
                    >
                      v{tpl ? tpl.version : 1} · {hash ? `${hash.slice(0, 10)}…` : '—'}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-caption font-medium text-ink">Powers</span>
              <span className="text-caption text-mute">{template ? `Set by the ${template.label} preset` : 'Switch what it may do'}</span>
            </div>
            <div className="grid gap-px overflow-hidden rounded-sm border border-hairline bg-hairline sm:grid-cols-2" data-testid="powers">
              {POWER_KEYS.map((key) => (
                <div key={key} className="flex items-start justify-between gap-4 bg-canvas px-3 py-2.5">
                  <div className="min-w-0">
                    <label htmlFor={`power-${key}`} className="text-sm font-medium text-ink">
                      {CAPABILITIES[key].label}
                    </label>
                    <p className="mt-0.5 text-caption text-mute">{CAPABILITIES[key].description}</p>
                  </div>
                  <Switch
                    id={`power-${key}`}
                    checked={shownPowers[key]}
                    disabled={!!template}
                    label={CAPABILITIES[key].label}
                    onChange={(v) => setCustomPowers((p) => ({ ...p, [key]: v }))}
                  />
                </div>
              ))}
              <div className="flex flex-col gap-1.5 bg-canvas px-3 py-2.5 sm:col-span-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {ALWAYS_ON.map((key) => (
                    <span key={key} title={CAPABILITIES[key].description}>
                      <Badge>{CAPABILITIES[key].label} · always on</Badge>
                    </span>
                  ))}
                </div>
                <p className="text-caption text-mute">Every agent keeps notes between cycles and runs its own treasury: fees become fuel.</p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-[240px_minmax(0,1fr)]">
            <div>
              <Label htmlFor="cadence" hint={template ? 'Set by the preset' : undefined}>
                Cadence
              </Label>
              <Select id="cadence" value={String(shownCadenceMs)} disabled={!!template || !shownPowers.xPublish} onChange={(e) => setCustomCadenceMs(Number(e.target.value))}>
                {cadenceChoices.map((o) => (
                  <option key={o.ms} value={String(o.ms)}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <p className="mt-1.5 text-caption text-mute">
                {shownPowers.xPublish ? 'Minimum spacing between its own posts. Replies are not spaced.' : 'Without Post on X the agent only replies; the cadence does not apply.'}
              </p>
            </div>
          </div>
        </Section>

        <Section n={4} title="Character" description="Who the agent is and what it is told to do. Published in its agent card.">
          <div>
            <Label htmlFor="identity" hint={`${identity.length}/600`}>
              Instructions
            </Label>
            <Textarea
              id="identity"
              rows={4}
              maxLength={600}
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              placeholder={'Who it is: a patient onchain analyst for small Base coins.\nHow it talks: short, plain, no hype, no emoji.\nWhat it never does: give price targets or financial advice.'}
            />
            <p className="mt-1.5 text-caption text-mute">Personality, goals, strategy, what it should and should not do. 20 to 600 characters; the agent reads this before every turn.</p>
          </div>
          <div data-testid="job-lines">
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="text-caption font-medium text-ink">Job lines</span>
              <span className="text-caption text-mute">{template ? `Set by the ${template.label} preset` : `Up to ${WORKER_BOUNDS.maxJobLines}, optional`}</span>
            </div>
            {template ? (
              <ol className="flex flex-col gap-1.5 rounded-sm border border-hairline p-3 text-sm text-body">
                {shownJobLines.map((line, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-mono text-caption text-mute">{i + 1}.</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="flex flex-col gap-2">
                {jobLines.map((line, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      aria-label={`Job line ${i + 1}`}
                      maxLength={WORKER_BOUNDS.maxJobLineChars}
                      placeholder={i === 0 ? 'Your job is …' : 'And …'}
                      value={line}
                      onChange={(e) => setJobLines((ls) => ls.map((l, j) => (j === i ? e.target.value : l)))}
                    />
                    <span className="w-14 shrink-0 text-right font-mono text-micro text-mute">{line.length}/{WORKER_BOUNDS.maxJobLineChars}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove job line ${i + 1}`}
                      disabled={jobLines.length === 1}
                      onClick={() => setJobLines((ls) => ls.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                {jobLines.length < WORKER_BOUNDS.maxJobLines ? (
                  <div>
                    <Button type="button" variant="secondary" size="sm" onClick={() => setJobLines((ls) => [...ls, ''])}>
                      Add a line
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
            <p className="mt-1.5 text-caption text-mute">
              {template
                ? 'The preset puts these lines at the top of the agent’s identity, after your instructions.'
                : 'Short sentences that say what the job is. They sit at the top of the agent’s identity, after your instructions, and are part of the hash written on-chain.'}
            </p>
          </div>
        </Section>

        <Section n={5} title="X account" description="The agent posts from its own account. Connect it here.">
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
          {!xHandle ? (
            <div className="rounded-sm border border-warning bg-canvas-soft p-4" data-testid="no-x-notice">
              <p className="text-sm font-medium text-ink">No X account yet: the agent launches silent.</p>
              <p className="mt-1 text-caption text-body">
                The agent only speaks through its own X account. Without one it will not post, and the coin page shows it as sleeping, until you connect an
                account from the coin page with this wallet. Trading, fees and the treasury work either way.
              </p>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-ink">
                <input type="checkbox" className="mt-0.5" checked={silentOk} onChange={(e) => setSilentOk(e.target.checked)} />
                <span>Launch without an X account; I will connect one later from the coin page.</span>
              </label>
            </div>
          ) : null}
        </Section>

        <Section n={6} title="Fuel & options" description="Where the coin launches, its starting treasury, an optional dev buy, and the fee preset.">
          {clankerAvailable ? (
            <fieldset>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <legend className="text-caption font-medium text-ink">Launch through</legend>
                <span className="text-caption text-mute">Permanent. The agent is the same either way.</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2" data-testid="launch-through">
                {LAUNCH_THROUGH.map((o) => (
                  <label
                    key={o.id}
                    className={cn(
                      'flex cursor-pointer flex-col gap-1.5 rounded-sm border p-3 transition-colors duration-150',
                      launchThrough === o.id ? 'border-ink' : 'border-hairline hover:border-hairline-strong',
                    )}
                  >
                    <input type="radio" name="launch-through" value={o.id} checked={launchThrough === o.id} onChange={() => setLaunchThrough(o.id)} className="sr-only" />
                    <span className="text-sm font-medium text-ink">{o.label}</span>
                    <ul className="flex flex-col gap-0.5 text-caption text-body">
                      {o.lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-3">
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
            <div>
              <Label htmlFor="gas" hint="Optional">
                Gas
              </Label>
              <Input id="gas" inputSize="lg" inputMode="decimal" mono suffix="ETH" placeholder="0" value={gas} onChange={(e) => setGas(e.target.value.trim())} aria-invalid={gasWei == null} />
              <p className="mt-1.5 text-caption text-mute">
                {gasWei === 0n ? 'Without gas the agent waits; anyone can add gas on the token page.' : 'The agent’s first gas, a second transaction after the launch. It refills from its own fees.'}
              </p>
            </div>
          </div>
          <div className="flex items-start justify-between gap-6 rounded-sm border border-hairline p-4">
            <div>
              <label htmlFor="buyback" className="text-sm font-medium text-ink">
                Buyback & burn
              </label>
              <p className="mt-0.5 text-caption text-mute">
                Sends {pctLabel(burnPct)} of trading volume to buy this coin back and burn it, taken from the creator share.{' '}
                {launchThrough === 'clanker'
                  ? 'Clanker\u2019s locker turns that share into the coin and sends it to the dead address.'
                  : 'The coin\u2019s burner claims it in WETH, swaps it for the coin and burns it.'}
              </p>
            </div>
            <Switch id="buyback" checked={buyback} onChange={setBuyback} label="Buyback and burn" />
          </div>
        </Section>
      </div>

      {/* Summary card: sticky beside the form from lg up, after it below. The Launch button lives here. */}
      <aside className="self-start lg:sticky lg:top-24" data-testid="launch-summary" aria-label="Launch summary">
        <div className="flex flex-col gap-4 rounded-md border border-hairline bg-canvas p-5">
          <div className="flex items-center gap-3">
            <div className="flex shrink-0 items-center gap-1.5">
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- local blob: preview
                <img src={preview} alt="" className="size-14 shrink-0 rounded-xs border border-hairline object-cover" />
              ) : (
                <div className="size-14 shrink-0 rounded-xs border border-dashed border-hairline-strong bg-canvas-soft" aria-hidden="true" />
              )}
              {/* The agent's face is derived from its kernel address, which only exists after the launch; until then the draft id stands in. */}
              <AgentPortrait address={draftId ?? 'draft'} size={56} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink">{name.trim() || 'Your coin'}</div>
              <div className="font-mono text-caption text-mute">{symbol ? `$${symbol}` : '$TICKER'}</div>
              <div className="mt-0.5 text-caption text-mute">its face is fixed at launch</div>
            </div>
          </div>

          <dl className="grid gap-px overflow-hidden rounded-sm border border-hairline bg-hairline text-sm">
            {[
              ['Kind', kindLabel],
              ['Model', selectedModel?.label ?? '—'],
              ['Launch through', launchThrough === 'clanker' ? 'Clanker' : 'RWAGMI'],
              ['X account', xHandle ? `@${xHandle}` : 'Not connected'],
              ...(links.x ? [['Project X', `@${xHandleOfUrl(links.x) ?? ''}`]] : []),
              ['Fuel', `${fuel || 0} USDC`],
              ...(devBuyWei && devBuyWei > 0n ? [['Dev buy', `${devBuy} ETH`]] : []),
              ['Your share', `${pctLabel(ofVolume(split, 'creator', fee))} of volume`],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 bg-canvas px-3 py-1.5">
                <dt className="text-mute">{k}</dt>
                <dd className="truncate font-mono text-ink">{v}</dd>
              </div>
            ))}
          </dl>

          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-caption font-medium text-ink">Fee split</span>
              <span className="font-mono text-caption text-mute">
                {[split.agent, split.creator, split.burn, split.platform].filter((v) => v > 0).map((v) => v / 100).join('/')}
                {launchThrough === 'clanker' ? ` of the fee, 20% on top for Clanker (${pctLabel(traderPaysPct(fee))} in total)` : ' of the 90% share'}
              </span>
            </div>
            <SplitBar split={split} fee={fee} />
          </div>

          <div className="flex flex-col gap-1 border-t border-hairline pt-4">
            <p className="text-sm text-ink" data-testid="cost-line">
              Your wallet pays: <span className="font-mono tabular">{costLine}</span>
            </p>
            <p className="text-caption text-mute">Launch fee + gas + fuel{devBuyWei && devBuyWei > 0n ? `, plus the ${devBuy} ETH dev buy` : ''}. Fuel and gas are the agent&rsquo;s once deposited.</p>
            <p className="text-caption text-mute">The agent can make bad decisions and lose money.</p>
          </div>

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
              <div className="flex flex-col gap-2">
                <ConnectButton />
                <span className="text-caption text-mute">Connect a wallet on {appChain.name} to launch.</span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {needsApproval ? (
                  <Button variant="secondary" size="lg" onClick={approve} loading={pending === 'Approve USDC'} disabled={!!blocked || fuelUnits == null}>
                    1. Approve {fuel} USDC
                  </Button>
                ) : null}
                <Button variant="primary" size="lg" onClick={launch} disabled={errors.length > 0 || !!blocked || needsApproval || !draftId} loading={pending === 'Launch'}>
                  {needsApproval ? '2. Launch' : 'Launch'}
                </Button>
                {env.useMock ? (
                  <span className="text-caption text-mute">Mock mode: no transaction is sent.</span>
                ) : gasWei && gasWei > 0n ? (
                  <span className="text-caption text-mute">Two wallet prompts: the launch, then {gas} ETH of gas for the agent.</span>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
