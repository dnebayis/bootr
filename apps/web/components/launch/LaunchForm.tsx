'use client';

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useConnection, usePublicClient, useReadContract, useReadContracts, useWriteContract } from 'wagmi';
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
import { addresses } from '@bootr/shared/addresses';
import { OWN_AGENT_MODEL_ID, type Runner } from '@bootr/shared/own-agent';
import { clankerLauncherAbi, clankerLauncherV5Abi, defaultsFromTuple, fallbackDefaults, launcherAbi, type LaunchDefaults } from '@/lib/abi/launcher';
import { clankerV5FactoryAbi, FALLBACK_V5_START_TICK, mineLaunchSalt, openingCapEth, SaltMiningError } from '@/lib/clanker-v5';
import {
  devBuyLine,
  launchValue,
  mockDevBuyQuote,
  pinsOf,
  quoteDevBuy,
  readLaunchTerms,
  termsChanged,
  v5LaunchProblem,
  V5LaunchRefused,
  type DevBuyQuote,
  type V5LaunchTerms,
} from '@/lib/v5-launch';
import { erc20Abi } from '@/lib/abi/erc20';
import { feeModelOf, launcherPct, ofVolume, pctLabel, traderPaysPct, type FeeModel } from '@/lib/fee-split';
import {
  coinsLabel,
  DEFAULT_DEV_BUY_SLIPPAGE_PCT,
  DEFAULT_TAX_PCT,
  FALLBACK_V5_BOUNDS,
  launchStringProblems,
  LAUNCH_KIND_ID,
  MAX_DEV_BUY_SLIPPAGE_PCT,
  minDevBuyOutFrom,
  parseSlippagePct,
  pairedAssetBySymbol,
  pairedAssetsFor,
  poolSharesOf,
  toContractSettings,
  tokenSettingsProblems,
  tradeSplit,
  v5BoundsFromTuple,
  type V5Bounds,
} from '@/lib/token-settings';
import type { LaunchSource } from '@/lib/types';
import { CLANKER_PATHS, clankerPath, contracts, USDC_DECIMALS, type ClankerPath } from '@/lib/contracts';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { fetchModels, fetchPlatformFlags, WORKER_TEMPLATES } from '@/lib/launch';
import { formatThoughtPrice, groupByProvider, RECOMMENDED_MODEL, THOUGHT } from '@/lib/models';
import { Badge } from '@/components/ui/Badge';
import { agentCardUrl, contractUriUrl } from '@/lib/agent-card';
import { clankerTokenMetadata } from '@/lib/contract-metadata';
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
import { ConnectClientStep, forgetLaunchDraft } from './ConnectClientStep';
import { OwnSteps, RunnerChoice } from './RunnerChoice';
import { DEFAULT_SETTINGS_DRAFT, settingsFromDraft, TokenSettingsPanel, type TokenSettingsDraft } from './TokenSettingsPanel';
import { V5SplitBar } from '@/components/token/V5SplitBar';
import { LINK_ERRORS, LINK_KINDS, normalizeLink } from '@/lib/coin-link-rules';
import { xHandleOfUrl } from '@/lib/x-link';
import { shortAddr } from '@/lib/format';

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

/** One step of the own-agent path (wallet, connect your AI client, launch): a heading above what the step holds. */
function OwnStep({ n, title, description, children, testId }: { n: number; title: string; description: string; children?: ReactNode; testId: string }) {
  return (
    <section className="flex flex-col gap-4 border-t border-hairline py-8" data-testid={testId}>
      <div>
        <div className="font-mono text-caption text-mute">STEP {n} OF 3</div>
        <h2 className="mt-1 text-display-sm font-semibold text-ink">{title}</h2>
        <p className="mt-1 text-sm text-mute">{description}</p>
      </div>
      {children ? <div className="min-w-0">{children}</div> : null}
    </section>
  );
}

const DRAFT_KEY = 'bootr.launch.draftId';

/** The fuel a Bootr-agent launch is prefilled with: a suggestion, never a minimum. An own-agent launch starts at none. */
const HOSTED_FUEL = '20';
const OWN_FUEL = '0';

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

/** The card ids of "Launch through": RWAGMI, or Clanker (v4 or v5, whichever this deployment's Clanker path is). */
type LaunchCard = 'bootr' | 'clanker';

/**
 * The two launch cards (docs/design/clanker-launch.md, docs/design/clanker-v5-migration.md). Plain words: what the coin
 * opens at, who takes what from the fee, where it is listed. The Clanker card describes the path this deployment launches
 * through: Clanker v4 until the v5 launcher is configured, Clanker v5 after (`clankerPath`). Only the platform's own
 * coin uses another fee.
 */
function launchThroughCards(clanker: ClankerPath, v5: { startTick: number; bounds: V5Bounds }): { id: LaunchCard; label: string; lines: string[] }[] {
  const clankerLines =
    clanker.version === 5
      ? [
          `Opens at about ${openingCapEth(v5.startTick).toFixed(1)} ETH of market cap, the opening price Clanker sets for every new coin.`,
          `A tax on every buy and sell that you set, ${v5.bounds.minTaxBps / 10_000}% to ${v5.bounds.maxTaxBps / 10_000}% (${DEFAULT_TAX_PCT}% by default); Clanker keeps its share, the rest goes to the agent, the platform and you, and to holders or the burn when chosen.`,
          '1 billion coins, paired with ETH or USDC. Listed on bootr.fun and clanker.world.',
        ]
      : [
          'Opens at about 10 ETH of market cap (around $27k).',
          '1% fee on every trade, all of it to the agent, you and the platform; Clanker adds 20% on top, so a trader pays 1.2%.',
          'Listed on bootr.fun and clanker.world.',
        ];
  return [
    {
      id: 'bootr',
      label: 'RWAGMI',
      lines: [
        'Opens at about 2.7 ETH of market cap (around $6k).',
        '1% fee on every trade: 90% of it goes to the agent, you and the platform, 10% to RWAGMI, the launcher.',
        'Listed on bootr.fun.',
      ],
    },
    { id: 'clanker', label: 'Clanker', lines: clankerLines },
  ];
}

/** Mock mode's creator while no wallet is connected: fills the creator's own reward row. */
const MOCK_CREATOR = '0x000000000000000000000000000000000000c0de' as Address;

/** Mock mode only: `/launch?clanker=v5` shows the form as a deployment with the v5 launcher configured does. */
const noopSubscribe = () => () => {};
const readSearch = () => window.location.search;
const noSearch = () => '';

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
  const publicClient = usePublicClient({ chainId: appChain.id });
  const { run, pending } = useTxRunner();
  // Clanker v5: the salt is mined before the wallet is asked (the token address must end in cccc).
  const [mining, setMining] = useState(false);

  // Who runs the agent (docs/design/byo-agent.md section 5.1): the Bootr agent, which is this form as it always was,
  // or the creator's own AI client, which adds the connect step and drops the Mind section. The choice is offered only
  // where own agents are switched on (`/api/platform`); everywhere else every launch is a Bootr-agent launch.
  const [runnerPick, setRunnerPick] = useState<Runner>('hosted');
  // The AI clients connected to this launch draft, by name, and the creator's "I will connect later".
  const [clientLabels, setClientLabels] = useState<string[]>([]);
  const [connectLater, setConnectLater] = useState(false);

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

  // 06 Fuel & options. The field follows the runner (20 suggested for the Bootr agent, none for an own agent) until
  // the creator types an amount of their own.
  const [fuel, setFuelText] = useState(HOSTED_FUEL);
  const [fuelTouched, setFuelTouched] = useState(false);
  const setFuel = (v: string) => {
    setFuelTouched(true);
    setFuelText(v);
  };
  // The agent's first gas: ETH the creator deposits into the EntryPoint for the new kernel right after the launch
  // (a second transaction). The platform pays no gas; the agent refills from its own WETH fees afterwards.
  const [gas, setGas] = useState(GAS_TOPUP_DEFAULT_ETH);
  const [devBuy, setDevBuy] = useState('');
  // Clanker v5: the dev buy's slippage tolerance; the creator signs the quote less this (`minDevBuyOut`).
  const [slippage, setSlippage] = useState(String(DEFAULT_DEV_BUY_SLIPPAGE_PCT));
  // The last dev buy quote, taken when the launch is prepared, so the summary shows what was signed.
  const [devBuyQuote, setDevBuyQuote] = useState<DevBuyQuote | null>(null);
  const [buyback, setBuyback] = useState(false);
  // Launch through RWAGMI (the default; source id 'bootr') or Clanker. The Clanker launcher is optional per deployment; while it
  // is not configured the choice is hidden and every launch goes through RWAGMI. Mock mode always offers both. Which
  // Clanker: v5 once NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS is set (v4 is then not offered), else v4 (`clankerPath`).
  const mockSearch = useSyncExternalStore(noopSubscribe, readSearch, noSearch);
  const path: ClankerPath = env.useMock && new URLSearchParams(mockSearch).get('clanker') === 'v5' ? CLANKER_PATHS[5] : clankerPath;
  const clankerAvailable = env.useMock || !!path.launcher;
  const [launchThroughPick, setLaunchThrough] = useState<LaunchCard>('bootr');
  const launchThrough: LaunchSource = clankerAvailable && launchThroughPick === 'clanker' ? path.source : 'bootr';
  const isV5 = launchThrough === 'clanker-v5';
  const launcher = launchThrough === 'bootr' ? contracts.launcher : path.launcher;
  const abi = isV5 ? clankerLauncherV5Abi : launchThrough === 'clanker' ? clankerLauncherAbi : launcherAbi;
  // Clanker v5's own reads: the tax of the v5 preset for the card, the opening tick and Clanker's native launch fee (0 today).
  const v5Live = path.version === 5 && !env.useMock && !!path.launcher;
  // The launcher's bounds for creator-set settings (tax range, the locked agent and platform shares, reward rows).
  const v5DefaultsRead = useReadContract({ address: path.launcher, abi: clankerLauncherV5Abi, functionName: 'agentDefaults', chainId: appChain.id, query: { enabled: v5Live } });
  const v5Factory = contracts.clankerV5?.factory;
  const quoteRead = useReadContract({ address: v5Factory, abi: clankerV5FactoryAbi, functionName: 'quoteConfig', args: [zeroAddress], chainId: appChain.id, query: { enabled: v5Live && !!v5Factory } });
  const clankerFeeRead = useReadContract({ address: v5Factory, abi: clankerV5FactoryAbi, functionName: 'nativeLaunchFee', chainId: appChain.id, query: { enabled: v5Live && !!v5Factory } });
  const v5Bounds: V5Bounds = v5DefaultsRead.data ? v5BoundsFromTuple(v5DefaultsRead.data) : FALLBACK_V5_BOUNDS;
  const v5StartTick = quoteRead.data?.[0] ? quoteRead.data[2] : FALLBACK_V5_START_TICK;
  const clankerFeeWei = isV5 ? (clankerFeeRead.data ?? 0n) : 0n;
  const launchCards = launchThroughCards(path, { startTick: v5StartTick, bounds: v5Bounds });
  // 07 Token settings (Clanker v5): typed as text, checked as `TokenSettingsInput` against the launcher's bounds.
  const [settingsDraft, setSettingsDraft] = useState<TokenSettingsDraft>(DEFAULT_SETTINGS_DRAFT);
  // The creator's own row defaults to the connected wallet (mock mode: a stand-in while none is connected).
  const settings = settingsFromDraft(settingsDraft, address ?? (env.useMock ? MOCK_CREATOR : undefined), v5Bounds);
  // Before a wallet is connected the creator's row has no address yet; that is the Connect button's job, not a problem.
  const waitingForWallet = (field: string) =>
    !address && (field === 'rewards.0.recipient' || field === 'rewards.0.admin') && settingsDraft.rewards[0]?.[field === 'rewards.0.admin' ? 'admin' : 'recipient'] === '';
  const settingsProblems = isV5 ? tokenSettingsProblems(settings, v5Bounds).filter((p) => !waitingForWallet(p.field)) : [];
  const pairedAsset = pairedAssetBySymbol(settings.pairedAsset);
  // The launcher's own word on the settings, before the wallet is asked: the paired assets it allows for agent coins
  // (`allowedQuote(0, asset)`), `previewSlotWeights(s)`, which reverts exactly as `launch` would, and the dev-buy route
  // a non-ETH pair needs (`devBuyRoute(asset)`, the zero pool while the owner has set none).
  const agentAssets = pairedAssetsFor('agent');
  const allowedRead = useReadContracts({
    allowFailure: true,
    contracts: agentAssets.map((a) => ({ address: path.launcher, abi: clankerLauncherV5Abi, functionName: 'allowedQuote', args: [LAUNCH_KIND_ID.agent, a.address], chainId: appChain.id }) as const),
    query: { enabled: v5Live },
  });
  const allowedAssets = allowedRead.data ? new Set(agentAssets.filter((_, i) => allowedRead.data![i]?.status !== 'success' || allowedRead.data![i]?.result === true).map((a) => a.symbol)) : null;
  const previewArg = isV5 && settingsProblems.length === 0 ? toContractSettings(settings, contractUriUrl(draftId ?? 'draft'), v5Bounds) : null;
  const previewRead = useReadContract({
    address: path.launcher,
    abi: clankerLauncherV5Abi,
    functionName: 'previewSlotWeights',
    args: previewArg ? [previewArg] : undefined,
    chainId: appChain.id,
    query: { enabled: v5Live && !!previewArg, retry: 0 },
  });
  const routeRead = useReadContract({
    address: path.launcher,
    abi: clankerLauncherV5Abi,
    functionName: 'devBuyRoute',
    args: pairedAsset ? [pairedAsset.address] : undefined,
    chainId: appChain.id,
    query: { enabled: v5Live && !!pairedAsset && pairedAsset.symbol !== 'ETH' },
  });
  const launcherRefusal = previewRead.isError
    ? `The launcher refuses these settings: ${(previewRead.error as { shortMessage?: string } | null)?.shortMessage ?? 'check the fields'}.`
    : allowedAssets && pairedAsset && !allowedAssets.has(pairedAsset.symbol)
      ? `The launcher does not take ${pairedAsset.symbol} as a paired asset right now.`
      : null;
  const noDevBuyRoute = !!routeRead.data && BigInt(routeRead.data[0]) === 0n;

  // Priced, admin-filtered list from /api/models (the relay itself is internal).
  const models = useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 60_000 });
  // Admin console switches (M-7): paused launches. The model allowlist is applied by /api/models.
  const platform = useQuery({ queryKey: ['platform'], queryFn: fetchPlatformFlags, staleTime: 30_000 });
  const ownOffered = platform.data?.ownAgent === true;
  const runner: Runner = ownOffered ? runnerPick : 'hosted';
  const own = runner === 'own';
  const chooseRunner = (next: Runner) => {
    setRunnerPick(next);
    if (!fuelTouched) setFuelText(next === 'own' ? OWN_FUEL : HOSTED_FUEL);
  };
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
  // The v5 launcher has no presets: its configuration is `agentDefaults()` above, and the creator sets the rest.
  const standardRead = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'standardDefaults', chainId: appChain.id, query: { enabled: onChain && !isV5 } });
  const buybackRead = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'buybackDefaults', chainId: appChain.id, query: { enabled: onChain && !isV5 } });
  const pausedRead = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'paused', chainId: appChain.id, query: { enabled: onChain } });
  // Flat ETH launch fee (0 when unset). Added to msg.value next to the dev buy; the contract forwards it to the platform.
  const launchFeeRead = useReadContract({ address: launcher, abi: launcherAbi, functionName: 'launchFeeWei', chainId: appChain.id, query: { enabled: onChain } });
  const launchFeeWei = launchFeeRead.data ?? 0n;
  /** Reads the v5 numbers the pins are made of again (after a stale pin), so the form shows the new ones. */
  const rereadV5 = () => {
    void launchFeeRead.refetch();
    void v5DefaultsRead.refetch();
    void clankerFeeRead.refetch();
  };
  const presetDefaults: LaunchDefaults = buyback
    ? buybackRead.data
      ? defaultsFromTuple(buybackRead.data)
      : fallbackDefaults(launchThrough, true)
    : standardRead.data
      ? defaultsFromTuple(standardRead.data)
      : fallbackDefaults(launchThrough, false);
  // On v5 the split is the creator's: the locked agent and platform shares, then creator funds, dividends and burn.
  const v5Shares = poolSharesOf({ burnPct: Number.isFinite(settings.burnPct) ? settings.burnPct : 0, dividendsPct: Number.isFinite(settings.dividendsPct) ? settings.dividendsPct : 0 }, v5Bounds);
  const defaults: LaunchDefaults = isV5
    ? {
        ...presetDefaults,
        lpFeeBps: Number.isFinite(settings.buyTaxPct) ? Math.round(settings.buyTaxPct * 10_000) : DEFAULT_TAX_PCT * 10_000,
        agentBps: v5Shares.agentBps,
        platformBps: v5Shares.platformBps,
        burnBps: v5Shares.burnBps,
        creatorBps: Math.max(0, 10_000 - v5Shares.agentBps - v5Shares.platformBps - v5Shares.burnBps),
        minFuelUsdc: v5DefaultsRead.data ? v5DefaultsRead.data[3] : presetDefaults.minFuelUsdc,
      }
    : presetDefaults;
  // The fee of the chosen path: 1% on RWAGMI and Clanker v4, the creator's buy tax on Clanker v5.
  const fee: FeeModel = isV5 ? feeModelOf({ source: 'clanker-v5', lpFeeBps: defaults.lpFeeBps }) : { source: launchThrough, lpFeeBps: 10_000 };
  // One trade's split on each side, for the v5 summary.
  const v5Splits = isV5 && settingsProblems.length === 0 ? { buy: tradeSplit(settings.buyTaxPct, v5Shares), sell: tradeSplit(settings.sellTaxPct, v5Shares) } : null;
  // The creator's own row's share of volume (buy side): creator funds times row 0's percent.
  const ownRowPct = v5Splits ? (v5Splits.buy.creatorFunds * (settings.rewards[0]?.pct ?? 0)) / 100 : 0;
  const minFuel = Number(formatUnits(defaults.minFuelUsdc, USDC_DECIMALS));

  const fuelUnits = /^\d+(\.\d{0,6})?$/.test(fuel) ? parseUnits(fuel, USDC_DECIMALS) : null;
  const devBuyWei = devBuy === '' ? 0n : /^\d+(\.\d{0,18})?$/.test(devBuy) ? parseEther(devBuy) : null;
  // Empty or 0 = launch without gas (the agent waits until someone adds some); otherwise at least the form minimum.
  const gasWei = gas === '' || /^0(\.0*)?$/.test(gas) ? 0n : validTopUp(gas) ? parseEther(gas) : null;
  const slippagePct = parseSlippagePct(slippage);

  const allowance = useReadContract({
    address: contracts.usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && launcher ? [address, launcher] : undefined,
    chainId: appChain.id,
    query: { enabled: !!address && !!launcher && !env.useMock },
  });
  // A launch with no fuel pulls no USDC (both launchers skip the transfer for 0), so it needs no approval.
  const needsApproval = !env.useMock && fuelUnits != null && fuelUnits > 0n && (allowance.data ?? 0n) < fuelUnits;

  // Pinned image: the gateway URL goes on-chain (renders in wallets and explorers), the ipfs:// URI into metadata.
  const pinned = upload.status === 'done' ? upload.result : null;
  const preview = upload.status === 'idle' ? null : upload.preview;
  // The launcher's presets are out of 10000. Through Bootr the locker stores them as 9000-bps slots of the 1% swap fee
  // (RWAGMI takes the other 10%), so agent 500 -> slot 450 -> 0.045% of volume; through Clanker the slots share the
  // whole fee (agent 500 -> 0.05%) and Clanker charges 20% on top.
  const split = { agent: defaults.agentBps, creator: defaults.creatorBps, burn: defaults.burnBps, platform: defaults.platformBps };
  const buybackDefaults = buybackRead.data ? defaultsFromTuple(buybackRead.data) : fallbackDefaults(launchThrough, true);
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
  // The same rules as the draft store and the coin page's links form (lib/coin-link-rules.ts).
  const links = {
    website: normalizeLink('website', website),
    x: normalizeLink('x', projectX),
    telegram: normalizeLink('telegram', telegram),
    discord: normalizeLink('discord', discord),
  };
  for (const kind of LINK_KINDS) if (links[kind] === undefined) errors.push(LINK_ERRORS[kind]);
  // The v5 launcher's byte caps (`StringTooLong`), checked on the strings the launch will carry, before anything is
  // signed; the name's and the instructions' problems also show under their fields.
  const capProblems = isV5 && draftId
    ? launchStringProblems({
        name: name.trim(),
        symbol: symbol.toUpperCase(),
        image: pinned?.url ?? '',
        metadata: clankerTokenMetadata(
          { name: name.trim(), symbol: symbol.toUpperCase(), image: pinned?.url ?? '', imageIpfs: pinned?.ipfsUri || null, xHandle, links: { website: links.website ?? null, x: links.x ?? null, telegram: links.telegram ?? null, discord: links.discord ?? null } },
          contractUriUrl(draftId),
          identity,
        ),
        context: JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id: draftId }),
        model: own ? OWN_AGENT_MODEL_ID : (selectedModel?.id ?? ''),
        agentURI: agentCardUrl(draftId),
        contractURI: contractUriUrl(draftId),
      })
    : [];
  const capProblem = (field: string) => capProblems.find((p) => p.field === field)?.message ?? null;
  // No minimum of Bootr's own: any amount launches, none included. Both launchers read 0 today; should the owner set
  // a floor on chain, a launch below it would revert, so the launcher's own number is still checked.
  if (fuelUnits == null) errors.push('Fuel must be a USDC amount; 0 is allowed.');
  else if (Number(fuel) < minFuel) errors.push(`The launcher takes at least ${minFuel} USDC of fuel right now.`);
  if (devBuyWei == null) errors.push('Dev buy must be a valid ETH amount.');
  if (gasWei == null) errors.push(`Gas must be 0 or at least ${GAS_TOPUP_MIN_ETH} ETH.`);
  if (!xHandle && !silentOk) errors.push('Connect an X account, or confirm launching without one.');
  // An own agent with no client is silent: allowed, but never by accident (like launching without an X account).
  if (own && clientLabels.length === 0 && !connectLater) errors.push('Connect your AI client, or choose to connect it later.');
  if (settingsProblems.length > 0) errors.push('Fix the token settings.');
  if (isV5 && launcherRefusal) errors.push(launcherRefusal);
  if (isV5 && devBuyWei != null && devBuyWei > 0n && slippagePct == null) errors.push(`Dev buy slippage must be 0.1% to ${MAX_DEV_BUY_SLIPPAGE_PCT}%.`);
  for (const p of capProblems) errors.push(p.message);
  if (isV5 && noDevBuyRoute && devBuyWei != null && devBuyWei > 0n) errors.push(`A dev buy through ${pairedAsset?.symbol} is not available yet: launch without one, and buy from the coin page afterwards.`);
  const blocked = platform.data?.launchesPaused
    ? 'Launches are paused by the platform.'
    : !env.useMock && !launcher
      ? launchThrough !== 'bootr'
        ? isV5
          ? 'The Clanker v5 launcher is not configured (NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS).'
          : 'The Clanker launcher is not configured (NEXT_PUBLIC_CLANKER_LAUNCHER_ADDRESS).'
        : 'The launcher contract is not configured (NEXT_PUBLIC_LAUNCHER_ADDRESS).'
      : pausedRead.data
        ? 'Launches are paused by the platform.'
        : !own && !models.isPending && modelList.length === 0
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
        body: JSON.stringify({ draftId: id, identity: identity.trim(), coin, worker, launchThrough, ...(isV5 ? { tokenSettings: settings } : {}) }),
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
    // An own-agent launch names no hosted model: the reserved id says on chain that the creator's own client thinks.
    const modelId = own ? OWN_AGENT_MODEL_ID : (selectedModel?.id ?? '');
    const coin = { name: name.trim(), symbol: symbol.toUpperCase(), image: pinned.url, imageIpfs: pinned.ipfsUri || null, xHandle, links: links as DraftLinks };
    // Clanker v5: the numbers the creator's pins are made of, read again now. When one of them moved since the form
    // showed it, nothing is signed: the form shows the new numbers and the creator presses Launch again.
    let terms: V5LaunchTerms | null = null;
    const v5 = isV5 ? (contracts.clankerV5 ?? addresses[8453].clankerV5) : null;
    if (isV5) {
      setDevBuyQuote(null);
      if (!v5 || (!env.useMock && (!launcher || !address || !publicClient))) return;
      if (env.useMock) {
        terms = { launchFeeWei, clankerFeeWei, configVersion: 0n, bounds: v5Bounds, minFuelUsdc: defaults.minFuelUsdc };
      } else {
        try {
          terms = await readLaunchTerms(publicClient!, launcher!, v5.factory as Address);
        } catch {
          toast.error('Could not read the launcher. Nothing was sent: check your connection and try again.');
          return;
        }
        const changed = termsChanged({ launchFeeWei, clankerFeeWei, bounds: v5Bounds }, terms);
        if (changed) {
          toast.error(changed);
          rereadV5();
          return;
        }
      }
    }
    if (!(await saveDraft(draftId, coin))) return;
    const params = {
      name: name.trim(),
      symbol: symbol.toUpperCase(),
      image: pinned.url,
      // Hosted ERC-7572 contract URI (app/tokens/[id]/route.ts, from the draft saved above); BootrLauncher sets it
      // as the B20 token's `contractURI`. Clanker's page reads JSON from this field instead, with the URI inside.
      metadata: launchThrough !== 'bootr' ? clankerTokenMetadata(coin, contractUriUrl(draftId), identity) : contractUriUrl(draftId),
      context: JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id: draftId }),
      salt: keccak256(toHex(draftId)),
      // Ignored by the v5 launcher: the burn is the creator's `burnBps` there.
      buybackBurn: isV5 ? false : buyback,
      fuelUsdc: fuelUnits,
      devBuyWei,
      workerHash,
      model: modelId,
      // Hosted ERC-8004 registration file, keyed by the launch id; see app/agents/[id]/route.ts.
      agentURI: agentCardUrl(draftId),
      supervisorSessionKey: env.supervisorSessionKey ?? zeroAddress, // TODO(supervisor): fetch per-launch key
    };
    // Clanker v5: the creator's token settings (the hosted contract URI moves into them), and a salt whose token address
    // ends in cccc, mined here, in slices, before the wallet is asked.
    const v5Settings = isV5 && terms ? toContractSettings(settings, contractUriUrl(draftId), terms.bounds, pinsOf(terms, devBuyWei > 0n ? 1n : 0n)) : null;
    let v5Token: Address | null = null;
    if (isV5 && v5Settings && v5 && terms) {
      setMining(true);
      try {
        const mined = await mineLaunchSalt({
          client: env.useMock ? null : publicClient!,
          launcher: launcher ?? zeroAddress,
          tokenDeployer: v5.tokenDeployer as Address,
          creator: address ?? zeroAddress,
          params,
          settings: v5Settings,
        });
        params.salt = mined.salt;
        v5Token = mined.token;
        // The dev buy's minimum: what this very launch delivers now (simulated), less the creator's slippage.
        if (devBuyWei > 0n) {
          const quotedOut = env.useMock
            ? mockDevBuyQuote(devBuyWei)
            : await quoteDevBuy({ client: publicClient!, launcher: launcher!, usdc: contracts.usdc, creator: address!, token: mined.token, params, settings: v5Settings, value: launchValue(devBuyWei, terms) });
          const quote = { quotedOut, minOut: minDevBuyOutFrom(quotedOut, slippagePct ?? DEFAULT_DEV_BUY_SLIPPAGE_PCT), slippagePct: slippagePct ?? DEFAULT_DEV_BUY_SLIPPAGE_PCT };
          v5Settings.minDevBuyOut = quote.minOut;
          setDevBuyQuote(quote);
          toast(`Dev buy: ${devBuyLine(quote, symbol.toUpperCase())}.`, { description: 'The launch reverts, and spends nothing but gas, if it would deliver less.' });
        }
      } catch (e) {
        if (e instanceof V5LaunchRefused) {
          toast.error(e.problem.message);
          if (e.problem.reread) rereadV5();
        } else {
          toast.error(e instanceof SaltMiningError ? e.message : 'Could not prepare the launch (the coin’s address or the dev buy quote). Nothing was sent: check your connection and try again.');
        }
        return;
      } finally {
        setMining(false);
      }
    }
    if (env.useMock) {
      // The mock CID resolves nowhere, so the mock token keeps the local preview (same document after client navigation).
      const id = mockLaunch({
        name: name.trim(),
        symbol: symbol.toUpperCase(),
        image: pinned.mock ? upload.preview : pinned.url,
        model: modelId,
        buyback: isV5 ? false : buyback,
        xHandle,
        source: launchThrough,
        links: coin.links,
        ...(v5Token ? { id: v5Token } : {}),
        ...(v5Settings ? { v5Settings: { settings: v5Settings, bounds: v5Bounds } } : {}),
      });
      toast.success(`Mock: $${symbol.toUpperCase()} launched${gasWei > 0n ? ` with ${gas} ETH of gas` : ''}`);
      sessionStorage.removeItem(DRAFT_KEY);
      forgetLaunchDraft();
      router.push(`/token/${id}`);
      return;
    }
    // The chosen launcher; all three take the same `LaunchParams`. The token address is read from the receipt's
    // `AgentLaunched` log below (on v5 it is also known up front: `v5Token`).
    if (!launcher) return;
    const value = terms ? launchValue(devBuyWei, terms) : devBuyWei + launchFeeWei + clankerFeeWei;
    const receipt = await run(
      'Launch',
      () =>
        v5Settings
          ? write.mutateAsync({ address: launcher, abi: clankerLauncherV5Abi, functionName: 'launch', args: [params, v5Settings], value, chainId: appChain.id, dataSuffix: builderDataSuffix })
          : write.mutateAsync({ address: launcher, abi: launchThrough === 'clanker' ? clankerLauncherAbi : launcherAbi, functionName: 'launch', args: [params], value, chainId: appChain.id, dataSuffix: builderDataSuffix }),
      // The v5 launcher's and Clanker's reverts in plain words; a stale pin reads the numbers again.
      v5Settings
        ? {
            describeError: (e) => v5LaunchProblem(e, { devBuy: devBuyWei > 0n })?.message ?? null,
            onError: (e) => {
              if (v5LaunchProblem(e, { devBuy: devBuyWei > 0n })?.reread) rereadV5();
            },
          }
        : {},
    );
    if (!receipt) return;
    const [ev] = parseEventLogs({ abi, eventName: 'AgentLaunched', logs: receipt.logs });
    const { token, kernel } = (ev?.args as { token?: Address; kernel?: Address } | undefined) ?? {};
    sessionStorage.removeItem(DRAFT_KEY);
    forgetLaunchDraft();
    if (gasWei > 0n && kernel) {
      // The agent's first gas, from the creator's wallet. Skipping or failing this leaves a launched coin whose
      // agent waits for gas; the token page's "Add gas" covers it later.
      const deposited = await run('Add gas', () =>
        write.mutateAsync({ address: entryPoint, abi: entryPointAbi, functionName: 'depositTo', args: [kernel], value: gasWei, chainId: appChain.id, dataSuffix: builderDataSuffix }),
      );
      if (!deposited) toast('Launched without gas. Add gas from the token page so the agent can start.');
    }
    if (token ?? v5Token) router.push(`/token/${token ?? v5Token}`);
    else toast('Launched. The token page appears once the indexer catches up.');
  }

  const costLine = [`${launchFeeWei + clankerFeeWei > 0n ? formatEther(launchFeeWei + clankerFeeWei) : '0'} ETH`, `${gasWei && gasWei > 0n ? gas : '0'} ETH`, `${fuel || 0} USDC`].join(' + ');

  // The section numbers: an own-agent launch has no Mind section (the creator's client is the mind).
  const sec = own ? { coin: 1, mind: 0, kind: 2, character: 3, x: 4, fuel: 5, settings: 6 } : { coin: 1, mind: 2, kind: 3, character: 4, x: 5, fuel: 6, settings: 7 };
  const walletReady = isConnected || env.useMock;
  const clientReady = clientLabels.length > 0 || connectLater;
  const fuelNote = own
    ? 'Only paid services use fuel. Add some now or later, or none.'
    : `${thoughts != null && thoughts > 0 ? `About ${thoughts.toLocaleString('en-US')} thoughts at the selected model. ` : ''}Suggested: ${HOSTED_FUEL} USDC. Fuel pays for the agent’s thinking; the Bootr agent stays silent until some arrives. Any amount, including none, launches the coin.`;

  return (
    <>
    {ownOffered ? <RunnerChoice value={runner} onChange={chooseRunner} /> : null}
    <div className="grid gap-8 pb-16 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-12">
      <div className="min-w-0">
        {own ? (
          <div data-testid="own-path">
            <OwnSteps
              steps={[
                { label: 'Wallet', state: walletReady ? 'done' : 'current', ...(address ? { note: shortAddr(address) } : {}) },
                {
                  label: 'Connect your AI client',
                  state: clientReady ? 'done' : walletReady ? 'current' : 'next',
                  ...(clientLabels.length > 0 ? { note: clientLabels.join(', ') } : connectLater ? { note: 'Later, from the console' } : {}),
                },
                { label: 'Launch', state: walletReady && clientReady ? 'current' : 'next' },
              ]}
            />
            <div className="mt-8">
              <OwnStep n={1} title="Wallet" description="The wallet that launches the coin is its creator. It approves your AI client and opens the creator console." testId="own-step-wallet">
                {isConnected && address ? (
                  <p className="text-sm text-ink">
                    Connected: <span className="font-mono">{shortAddr(address)}</span>
                  </p>
                ) : env.useMock ? (
                  <p className="text-sm text-mute">Mock mode: no wallet is needed.</p>
                ) : (
                  <div className="flex flex-col items-start gap-2">
                    <ConnectButton />
                    <span className="text-caption text-mute">Connect a wallet on {appChain.name}.</span>
                  </div>
                )}
              </OwnStep>
              <OwnStep
                n={2}
                title="Connect your AI client"
                description="The agent thinks in the client you already use. Bootr keeps every rule and limit on its side; your client is only the mind."
                testId="own-step-connect"
              >
                <ConnectClientStep draftId={draftId} symbol={symbol} later={connectLater} onLater={setConnectLater} onClients={setClientLabels} />
              </OwnStep>
              <OwnStep n={3} title="Launch" description="The coin and its agent, in one transaction. Everything below is the same for both kinds of agent, without a model to choose." testId="own-step-launch" />
            </div>
          </div>
        ) : null}
        {platform.data?.launchesPaused ? (
          <div role="status" className="mb-6 rounded-sm border border-hairline-strong bg-canvas-soft px-4 py-3 text-sm text-ink">
            Launches are paused by the platform. You can prepare a launch, but it cannot be sent until launches resume.
          </div>
        ) : null}
        <Section n={sec.coin} title="Coin" description="Name, ticker and image. These are permanent.">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" inputSize="lg" maxLength={48} placeholder="Quiet Engine" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!capProblem('name')} />
              {capProblem('name') ? (
                <p className="mt-1.5 text-caption text-danger" data-testid="name-cap">
                  {capProblem('name')}
                </p>
              ) : null}
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

        {own ? null : (
        <Section n={sec.mind} title="Mind" description="The model that thinks for the agent. Each thought is paid from its fuel.">
          <div>
            <Label htmlFor="model" hint="Price per thought at BlockRun">
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
              {THOUGHT.outputTokens.toLocaleString('en-US')} tokens). Each one is paid in USDC from the agent&rsquo;s fuel to BlockRun, the service that runs the models for it.
            </p>
          </div>
        </Section>
        )}

        <Section n={sec.kind} title="Kind" description="What the agent is for. The preset's hash is written on-chain at launch.">
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
                    <p className="mt-0.5 text-caption text-mute">{own && key === 'images' ? 'Posts pictures your AI client makes and uploads from your machine. Nothing is bought.' : CAPABILITIES[key].description}</p>
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
                <p className="text-caption text-mute">{own ? 'Every agent keeps notes between cycles and runs its own treasury: it claims its fees and keeps its gas.' : 'Every agent keeps notes between cycles and runs its own treasury: fees become fuel.'}</p>
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

        <Section n={sec.character} title="Character" description="Who the agent is and what it is told to do. Published in its agent card.">
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
            {capProblem('metadata') ? (
              <p className="mt-1 text-caption text-danger" data-testid="metadata-cap">
                {capProblem('metadata')}
              </p>
            ) : null}
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

        <Section n={sec.x} title="X account" description="The agent posts from its own account. Connect it here.">
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
                {own
                  ? 'The agent only speaks through its own X account. Without one it will not post until you connect an account from the coin page with this wallet. Trading, fees and the treasury work either way.'
                  : 'The agent only speaks through its own X account. Without one it will not post, and the coin page shows it as sleeping, until you connect an account from the coin page with this wallet. Trading, fees and the treasury work either way.'}
              </p>
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-ink">
                <input type="checkbox" className="mt-0.5" checked={silentOk} onChange={(e) => setSilentOk(e.target.checked)} />
                <span>Launch without an X account; I will connect one later from the coin page.</span>
              </label>
            </div>
          ) : null}
        </Section>

        <Section n={sec.fuel} title="Fuel & options" description="Where the coin launches, its starting treasury, an optional dev buy, and the fee preset.">
          {clankerAvailable ? (
            <fieldset>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <legend className="text-caption font-medium text-ink">Launch through</legend>
                <span className="text-caption text-mute">Permanent. The agent is the same either way.</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2" data-testid="launch-through">
                {launchCards.map((o) => (
                  <label
                    key={o.id}
                    className={cn(
                      'flex cursor-pointer flex-col gap-1.5 rounded-sm border p-3 transition-colors duration-150',
                      (launchThrough === 'bootr' ? 'bootr' : 'clanker') === o.id ? 'border-ink' : 'border-hairline hover:border-hairline-strong',
                    )}
                  >
                    <input type="radio" name="launch-through" value={o.id} checked={(launchThrough === 'bootr' ? 'bootr' : 'clanker') === o.id} onChange={() => setLaunchThrough(o.id)} className="sr-only" />
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
              <Label htmlFor="fuel" hint={own ? 'Optional' : `Suggested ${HOSTED_FUEL} USDC`}>
                Fuel
              </Label>
              <Input id="fuel" inputSize="lg" inputMode="decimal" mono suffix="USDC" value={fuel} onChange={(e) => setFuel(e.target.value.trim())} aria-invalid={fuelUnits == null || Number(fuel) < minFuel} />
              <p className="mt-1.5 text-caption text-mute" data-testid="fuel-note">
                {fuelNote}
              </p>
            </div>
            <div>
              <Label htmlFor="devbuy" hint="Optional">
                Dev buy
              </Label>
              <Input id="devbuy" inputSize="lg" inputMode="decimal" mono suffix="ETH" placeholder="0" value={devBuy} onChange={(e) => setDevBuy(e.target.value.trim())} aria-invalid={devBuyWei == null} />
              <p className="mt-1.5 text-caption text-mute">
                {isV5 && pairedAsset && pairedAsset.symbol !== 'ETH'
                  ? `Bought in the launch transaction with ETH, through ${pairedAsset.symbol} (two swaps), and sent to your wallet.`
                  : 'Bought in the launch transaction, sent to your wallet.'}
              </p>
              {isV5 && devBuyWei != null && devBuyWei > 0n ? (
                <div className="mt-3">
                  <Label htmlFor="slippage" hint={`Default ${DEFAULT_DEV_BUY_SLIPPAGE_PCT}%`}>
                    Dev buy slippage
                  </Label>
                  <Input id="slippage" inputMode="decimal" mono suffix="%" value={slippage} onChange={(e) => setSlippage(e.target.value.trim())} aria-invalid={slippagePct == null} />
                  <p className="mt-1.5 text-caption text-mute">The dev buy is quoted when you press Launch; you sign that quote less this as the least you get. If the launch would deliver less, it reverts and spends nothing but gas.</p>
                </div>
              ) : null}
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
          {/* On Clanker v5 the burn is part of the token settings below. */}
          {isV5 ? null : (
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
          )}
        </Section>

        {isV5 ? (
          <Section n={sec.settings} title="Token settings" description="Tax, rewards and the paired asset, the way Clanker’s own form sets them. Permanent, except the image and metadata while you keep them editable.">
            <TokenSettingsPanel draft={settingsDraft} onChange={setSettingsDraft} creator={address} bounds={v5Bounds} problems={settingsProblems} allowedAssets={allowedAssets} />
          </Section>
        ) : null}
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
              ...(own
                ? [
                    ['Agent', 'My own agent'],
                    ['AI client', clientLabels.length > 0 ? clientLabels.join(', ') : connectLater ? 'Connect later' : 'Not connected'],
                  ]
                : [['Model', selectedModel?.label ?? '—']]),
              ['Launch through', launchThrough === 'bootr' ? 'RWAGMI' : 'Clanker'],
              ...(isV5
                ? [
                    ['Trading tax', settings.buyTaxPct === settings.sellTaxPct ? pctLabel(settings.buyTaxPct) : `${pctLabel(settings.buyTaxPct)} buy · ${pctLabel(settings.sellTaxPct)} sell`],
                    ['Paired asset', pairedAsset?.symbol ?? '—'],
                    ['Sniper tax', settings.sniperTax ? 'On' : 'Off'],
                  ]
                : []),
              ['X account', xHandle ? `@${xHandle}` : 'Not connected'],
              ...(links.x ? [['Project X', `@${xHandleOfUrl(links.x) ?? ''}`]] : []),
              ['Fuel', `${fuel || 0} USDC`],
              ...(devBuyWei && devBuyWei > 0n ? [['Dev buy', `${devBuy} ETH`]] : []),
              ...(isV5 && devBuyWei && devBuyWei > 0n
                ? [['Dev buy minimum', devBuyQuote ? `${coinsLabel(devBuyQuote.minOut)} $${symbol || 'TICKER'}` : `quote − ${slippagePct ?? DEFAULT_DEV_BUY_SLIPPAGE_PCT}%`]]
                : []),
              ...(isV5 ? [['Launch fee', `${formatEther(launchFeeWei + clankerFeeWei)} ETH`]] : []),
              ['Your share', `${pctLabel(isV5 ? ownRowPct : ofVolume(split, 'creator', fee))} of volume`],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 bg-canvas px-3 py-1.5">
                <dt className="text-mute">{k}</dt>
                <dd className="truncate font-mono text-ink">{v}</dd>
              </div>
            ))}
          </dl>

          {isV5 ? (
            <div>
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-caption font-medium text-ink">Fee split</span>
                <span className="font-mono text-caption text-mute">of trading volume</span>
              </div>
              {v5Splits ? <V5SplitBar buy={v5Splits.buy} sell={v5Splits.sell} asset={pairedAsset?.symbol ?? 'ETH'} /> : <p className="text-caption text-mute">Fix the token settings to see the split.</p>}
            </div>
          ) : (
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-caption font-medium text-ink">Fee split</span>
              <span className="font-mono text-caption text-mute">
                {[split.agent, split.creator, split.burn, split.platform].filter((v) => v > 0).map((v) => v / 100).join('/')}
                {isV5
                  ? ` of the tax after Clanker\u2019s ${pctLabel(launcherPct(fee))} (${pctLabel(traderPaysPct(fee))} in total)`
                  : launchThrough === 'clanker'
                    ? ` of the fee, 20% on top for Clanker (${pctLabel(traderPaysPct(fee))} in total)`
                    : ' of the 90% share'}
              </span>
            </div>
            <SplitBar split={split} fee={fee} />
          </div>
          )}

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
                <Button
                  variant="primary"
                  size="lg"
                  onClick={launch}
                  disabled={errors.length > 0 || !!blocked || needsApproval || !draftId}
                  loading={pending === 'Launch' || mining}
                  loadingLabel={mining ? 'Finding the coin’s address…' : undefined}
                  data-testid="launch-submit"
                >
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
    </>
  );
}
