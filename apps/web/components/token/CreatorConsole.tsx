'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { ALWAYS_ON_CAPABILITIES, CAPABILITIES, CAPABILITY_KEYS, type CapabilityKey, POSTS_PER_DAY, WORKER_BOUNDS } from '@bootr/shared/workers';
import { qk, useAgent, useAgentConfig, useNotificationCount } from '@/lib/indexer';
import { fetchImageModels, fetchModels } from '@/lib/launch';
import { cheapestModel, DEFAULT_IMAGE_MODEL, FALLBACK_MODELS, formatMicroUsdc, formatThoughtPrice, groupByProvider, modelKey, modelLabel, type ModelOption } from '@/lib/models';
import { SERVICES_DAILY_MAX_MICRO_USDC, SERVICES_PER_CALL_MAX_MICRO_USDC, type Agent, type AgentConfig, type AgentConfigChanges, type Token } from '@/lib/types';
import { formatGas, gasStatus, gasTotal } from '@/lib/gas';
import { useKernelGas } from '@/lib/use-gas';
import { fuelOutlook } from '@/lib/fuel-outlook';
import { cadenceLabel, measuredThoughtCost, postBudgetNote, shownInterval } from '@/lib/post-budget';
import { useAgentActivity, useAgentFuel, useApprovalCount } from '@/lib/indexer';
import { changedSections, CONSOLE_SECTIONS, sectionLabel, SETTINGS_SECTIONS, type ConsoleSection } from '@/lib/console-sections';
import { fuelFromAgent, onboardingItems, SECTION_HINTS } from '@/lib/onboarding';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select, Switch, Textarea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/Tabs';
import { TokenImage } from '@/components/ui/TokenImage';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { cn } from '@/components/ui/cn';
import { AgentChat } from './AgentChat';
import { ApprovalQueue } from './ApprovalQueue';
import { CoinImageForm } from './CoinImageForm';
import { CoinLinksForm } from './CoinLinksForm';
import { useCreatorSignature } from './creator-signature';
import { FuelForm } from './FuelForm';
import { GasForm } from './GasForm';
import { NotificationInbox } from './NotificationInbox';
import { OnboardingCard } from './OnboardingCard';

const INSTRUCTIONS_MIN = 20;
const INSTRUCTIONS_MAX = 600;
/** `MAX_IMAGE_STYLE_NOTES_CHARS` in packages/agent-core. */
const IMAGE_NOTES_MAX = 200;
const POWERS = CAPABILITY_KEYS.filter((k) => !ALWAYS_ON_CAPABILITIES.includes(k));
/** The one settings form: each settings tab mounts it under this id, so the sticky Save button submits whichever tab is open. */
const FORM_ID = 'console-settings';

type Draft = {
  instructions: string;
  capabilities: Record<CapabilityKey, boolean>;
  /** The daily budget of posts and replies; the cadence is derived from it by the supervisor. */
  postsPerDay: number;
  model: string;
  requireApproval: boolean;
  imageModel: string;
  /** The reference picture URL as typed ('' = none) and the style notes. */
  imageReference: string;
  imageNotes: string;
  /** Economy mode: the deciding model, null when off. */
  decideModel: string | null;
  /** The worker's job lines (up to WORKER_BOUNDS.maxJobLines, each up to maxJobLineChars). */
  jobLines: string[];
  /** Paid services caps as typed, in USDC, and the host lists as comma- or newline-separated text. */
  servicesPerCallUsdc: string;
  servicesDailyUsdc: string;
  servicesAllow: string;
  servicesDeny: string;
};

/** "0.05" -> 50000; null when the text is not a USDC amount with at most 6 decimals. */
export function parseUsdcMicro(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 1_000_000 + Number((frac + '000000').slice(0, 6));
}

export function formatUsdcMicro(micro: number): string {
  return (micro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

const HOST_PATTERN = /^(\*\.)?[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/;

/** Hosts typed one per line or comma-separated, lower-cased; null when one of them is not a hostname or *.example.com. */
export function parseHosts(text: string): string[] | null {
  const hosts = text
    .split(/[\n,]/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (hosts.length > 64 || hosts.some((h) => !HOST_PATTERN.test(h))) return null;
  return [...new Set(hosts)];
}

function draftOf(c: AgentConfig): Draft {
  return {
    instructions: c.instructions,
    capabilities: { ...c.worker.capabilities },
    postsPerDay: c.postsPerDay,
    model: c.model,
    requireApproval: c.requireApproval,
    imageModel: c.imageModel || DEFAULT_IMAGE_MODEL,
    imageReference: c.imageStyle.reference ?? '',
    imageNotes: c.imageStyle.notes,
    jobLines: [...c.worker.jobLines],
    decideModel: c.routing.decideModel,
    servicesPerCallUsdc: formatUsdcMicro(c.services.perCallMicroUsdc),
    servicesDailyUsdc: formatUsdcMicro(c.services.dailyMicroUsdc),
    servicesAllow: c.services.allow.join('\n'),
    servicesDeny: c.services.deny.join('\n'),
  };
}

/** The services caps the draft asks for; null fields are invalid as typed. */
export function servicesDraft(d: Pick<Draft, 'servicesPerCallUsdc' | 'servicesDailyUsdc' | 'servicesAllow' | 'servicesDeny'>) {
  const perCall = parseUsdcMicro(d.servicesPerCallUsdc);
  const daily = parseUsdcMicro(d.servicesDailyUsdc);
  return {
    perCallMicroUsdc: perCall !== null && perCall >= 1 && perCall <= SERVICES_PER_CALL_MAX_MICRO_USDC ? perCall : null,
    dailyMicroUsdc: daily !== null && daily >= 1 && daily <= SERVICES_DAILY_MAX_MICRO_USDC ? daily : null,
    allow: parseHosts(d.servicesAllow),
    deny: parseHosts(d.servicesDeny),
  };
}

/** A public https URL (what the supervisor accepts as a reference picture). */
export function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Only what differs from the stored config; null when nothing does. */
export function diffConfig(config: AgentConfig, d: Draft): AgentConfigChanges | null {
  const changes: AgentConfigChanges = {};
  if (d.instructions.trim() !== config.instructions) changes.instructions = d.instructions.trim();
  if (d.model !== config.model) changes.model = d.model;
  const caps: Partial<Record<CapabilityKey, boolean>> = {};
  for (const k of POWERS) if (d.capabilities[k] !== config.worker.capabilities[k]) caps[k] = d.capabilities[k];
  const worker: NonNullable<AgentConfigChanges['worker']> = {};
  if (Object.keys(caps).length) worker.capabilities = caps;
  const lines = d.jobLines.map((l) => l.trim()).filter(Boolean);
  if (JSON.stringify(lines) !== JSON.stringify(config.worker.jobLines)) worker.jobLines = lines;
  if (Object.keys(worker).length) changes.worker = worker;
  if (d.postsPerDay !== config.postsPerDay) changes.postsPerDay = d.postsPerDay;
  if (d.requireApproval !== config.requireApproval) changes.requireApproval = d.requireApproval;
  if (d.decideModel !== config.routing.decideModel) changes.routing = { decideModel: d.decideModel };
  if (d.imageModel !== (config.imageModel || DEFAULT_IMAGE_MODEL)) changes.imageModel = d.imageModel;
  const style: NonNullable<AgentConfigChanges['imageStyle']> = {};
  const reference = d.imageReference.trim() || null;
  if (reference !== config.imageStyle.reference) style.reference = reference;
  const notes = d.imageNotes.trim().replace(/\s+/g, ' ');
  if (notes !== config.imageStyle.notes) style.notes = notes;
  if (Object.keys(style).length) changes.imageStyle = style;
  const sd = servicesDraft(d);
  const services: NonNullable<AgentConfigChanges['services']> = {};
  if (sd.perCallMicroUsdc !== null && sd.perCallMicroUsdc !== config.services.perCallMicroUsdc) services.perCallMicroUsdc = sd.perCallMicroUsdc;
  if (sd.dailyMicroUsdc !== null && sd.dailyMicroUsdc !== config.services.dailyMicroUsdc) services.dailyMicroUsdc = sd.dailyMicroUsdc;
  if (sd.allow && JSON.stringify(sd.allow) !== JSON.stringify(config.services.allow)) services.allow = sd.allow;
  if (sd.deny && JSON.stringify(sd.deny) !== JSON.stringify(config.services.deny)) services.deny = sd.deny;
  if (Object.keys(services).length) changes.services = services;
  return Object.keys(changes).length ? changes : null;
}

/** The picker groups, with `current` appended under "Current" when the list does not carry it (an old or admin-only id). */
function pickerGroups(list: readonly ModelOption[], current: string | null | undefined) {
  const known = current && !list.some((m) => m.id === current) ? [...list, { id: current, label: modelLabel(current), provider: 'Current', pricePerThoughtUsd: null }] : [...list];
  return groupByProvider(known);
}

export function editedLabel(revision: number): string {
  return revision === 0 ? 'not edited yet' : revision === 1 ? 'edited once' : `edited ${revision} times`;
}

/** A labelled row with a switch on the right: the post review and economy mode controls. */
function SwitchRow({ title, children, control, className }: { title: string; children?: ReactNode; control: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <span className="min-w-0">
        <span className="block text-sm text-ink">{title}</span>
        {children ? <span className="block text-micro text-mute">{children}</span> : null}
      </span>
      {control}
    </div>
  );
}

/** A caption heading inside a tab, for the blocks that are not a single labelled field. */
function BlockTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <h3 className="text-caption font-medium text-ink">{children}</h3>
      {hint ? <span className="text-caption text-mute">{hint}</span> : null}
    </div>
  );
}

/**
 * The creator's panel on the coin page, in six tabs so it never becomes one long column: Mind (instructions, model,
 * economy mode), Posting (posts per day, post review, job lines), Powers (the switches, with the paid-services caps
 * under them while that power is on), Look (the agent's pictures, the coin's image and links), Inbox (notifications,
 * the review queue, the private chat) and Fuel (fuel and gas). The four settings tabs edit one draft, saved together
 * from the sticky bar at the bottom with one wallet signature (`POST /api/agent/:kernel/config`); the inbox, queue
 * and chat share the console session's one signature (console-session.ts). Fuel warnings sit above the tabs so they
 * are seen whichever tab is open. A new agent gets a first-steps card above the tabs (OnboardingCard: X account,
 * instructions, fuel, gas, from the token, the config, the indexer's agent row and the gas read) and, until its config
 * is first edited, one line of guidance per tab. Shown only to the creator's wallet (everyone in mock mode, where
 * saving skips the signature).
 */
export function CreatorConsole({ token, agent }: { token: Token; agent: Agent | null }) {
  const { canSign, sign } = useCreatorSignature();
  const queryClient = useQueryClient();
  const config = useAgentConfig(token.kernel);
  // The indexer's agent row (shared with AgentPanel): the fuel figures of the first-steps card.
  const agentRow = useAgent(token.kernel);
  const approvals = useApprovalCount(token.kernel);
  const notifications = useNotificationCount(token.kernel);
  const fuel = useAgentFuel(token.kernel);
  const activity = useAgentActivity(token.kernel);
  const pendingReviews = approvals.data?.pending ?? 0;
  const inboxCount = pendingReviews + (notifications.data?.active ?? 0);
  const models = useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 60_000 });
  const imageModels = useQuery({ queryKey: ['models', 'image'], queryFn: fetchImageModels, staleTime: 60_000 });
  const kernels = useMemo(() => [token.kernel as Address], [token.kernel]);
  const gas = useKernelGas(kernels);
  const kernelGas = gas.of(token.kernel as Address);
  const gasWei = kernelGas ? gasTotal(kernelGas) : null;
  const [edits, setEdits] = useState<{ revision: number; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<ConsoleSection>('mind');

  const cfg = config.data ?? null;
  // Edits belong to the revision they started from; a save (or someone else's) resets the form to the stored config.
  const draft = cfg ? (edits && edits.revision === cfg.revision ? edits.draft : draftOf(cfg)) : null;
  const update = (patch: Partial<Draft>) => {
    if (!cfg || !draft) return;
    setEdits({ revision: cfg.revision, draft: { ...draft, ...patch } });
  };
  const changes = cfg && draft ? diffConfig(cfg, draft) : null;
  const dirty = changedSections(changes);
  const instructionsLen = draft?.instructions.trim().length ?? 0;
  const instructionsOk = instructionsLen >= INSTRUCTIONS_MIN && instructionsLen <= INSTRUCTIONS_MAX;
  const reference = draft?.imageReference.trim() ?? '';
  const referenceOk = reference === '' || isHttpsUrl(reference);
  const notesLen = draft?.imageNotes.trim().replace(/\s+/g, ' ').length ?? 0;
  const notesOk = notesLen <= IMAGE_NOTES_MAX;
  const styleOk = referenceOk && notesOk;
  const sd = draft ? servicesDraft(draft) : null;
  const servicesOk = !sd || (sd.perCallMicroUsdc !== null && sd.dailyMicroUsdc !== null && sd.perCallMicroUsdc <= sd.dailyMicroUsdc && sd.allow !== null && sd.deny !== null);
  const valid = instructionsOk && styleOk && servicesOk;
  const inactive = agent?.status === 'paused' || agent?.status === 'dormant' || agent?.status === 'claimed';

  const modelList = models.data?.models ?? FALLBACK_MODELS;
  const modelGroups = useMemo(() => pickerGroups(modelList, draft?.model), [modelList, draft?.model]);
  const decideGroups = useMemo(() => pickerGroups(modelList, draft?.decideModel), [modelList, draft?.decideModel]);
  // The suggestion when the switch goes on: the cheapest allowed mind that is not the writer itself.
  const cheapest = useMemo(() => cheapestModel(modelList, draft?.model), [modelList, draft?.model]);
  const priceOf = (id: string | null) => (id ? (modelList.find((m) => m.id === id || modelKey(m.id) === modelKey(id))?.pricePerThoughtUsd ?? null) : null);
  const economyOn = draft?.decideModel != null;
  const fuelLine = useMemo(() => {
    const rows = fuel.data?.byModel ?? [];
    if (!rows.length) return null;
    const total = rows.reduce((n, r) => n + r.thoughts, 0);
    const spent = rows.reduce((n, r) => n + Number(r.chargedMicroUsdc), 0);
    const unanswered = rows.reduce((n, r) => n + (r.paidFailures ?? 0), 0);
    const parts = rows.slice(0, 3).map((r) => `${r.thoughts} on ${modelLabel(r.model)} (${formatMicroUsdc(r.chargedMicroUsdc)})`);
    // Who is paid: thoughts and pictures can take different routes (pictures go through Bootr while thoughts pay BlockRun).
    const { paidTo: thoughtsTo, picturesPaidTo: picturesTo = null } = fuel.data!;
    const paidTo =
      thoughtsTo === 'blockrun' && picturesTo === 'bootr'
        ? ' Thoughts paid to BlockRun from the agent’s own wallet; pictures paid through Bootr.'
        : thoughtsTo === 'blockrun'
          ? ' Paid to BlockRun from the agent’s own wallet.'
          : thoughtsTo === 'bootr'
            ? ' Paid through Bootr.'
            : '';
    return `Last ${fuel.data!.days} days: ${total} thoughts, ${formatMicroUsdc(spent)}${unanswered > 0 ? ` (${unanswered} charged with no answer)` : ''}: ${parts.join(', ')}.${paidTo}`;
  }, [fuel.data]);
  // Runway and warnings; an agent that is not running has no rate to speak of. The clock is when the numbers were read.
  const outlook = useMemo(
    () => (inactive ? null : fuelOutlook({ fuel: fuel.data, spenderUsdc: agent?.spenderUsdc, treasuryUsdc: agent?.treasuryUsdc, activity: activity.data?.pages[0]?.items ?? [], now: fuel.dataUpdatedAt || activity.dataUpdatedAt })),
    [inactive, fuel.data, fuel.dataUpdatedAt, agent?.spenderUsdc, agent?.treasuryUsdc, activity.data, activity.dataUpdatedAt],
  );
  const imageModelGroups = useMemo(() => {
    const list = imageModels.data?.models ?? [];
    const current = draft?.imageModel;
    const known = current && list.some((m) => m.id === current) ? list : current ? [...list, { id: current, label: modelLabel(current), provider: 'Current', pricePerImageUsd: null }] : list;
    return groupByProvider(known);
  }, [imageModels.data, draft?.imageModel]);
  const imagePrice = imageModels.data?.models.find((m) => m.id === draft?.imageModel)?.pricePerImageUsd ?? null;
  // Posts per day: the cadence it implies (the stored one while the budget is unchanged) and the rough daily fuel cost,
  // from what the agent's thoughts cost lately, else the model's listed price.
  const budgetInterval = cfg && draft ? shownInterval(draft.postsPerDay, { postsPerDay: cfg.postsPerDay, postIntervalMs: cfg.worker.postIntervalMs }) : null;
  const measuredCost = useMemo(() => measuredThoughtCost(fuel.data), [fuel.data]);
  const budgetNote = draft && budgetInterval != null ? postBudgetNote({ postsPerDay: draft.postsPerDay, intervalMs: budgetInterval, measuredMicroUsdc: measuredCost, listedUsd: priceOf(draft.model) }) : '';

  const save = async () => {
    if (!cfg || !changes || !valid) return;
    setSaving(true);
    try {
      const signed = await sign(`Update the agent of Bootr coin $${token.symbol} (#${token.agentId}, ${token.kernel}).`);
      if (!signed) return;
      const body: { message: string; signature: string; changes: AgentConfigChanges } = { ...signed, changes };
      const res = await fetch(`/api/agent/${token.kernel.toLowerCase()}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        toast.error(err.message ?? `Could not save (${res.status}).`);
        return;
      }
      const next = (await res.json()) as AgentConfig;
      queryClient.setQueryData(qk.agentConfig(token.kernel), next);
      void queryClient.invalidateQueries({ queryKey: qk.agentActivity(token.kernel) });
      if (changes.routing) void queryClient.invalidateQueries({ queryKey: qk.agentFuel(token.kernel) });
      setEdits(null);
      toast.success(`Agent updated. The next cycle uses it (${editedLabel(next.revision)}).`);
    } finally {
      setSaving(false);
    }
  };

  /** The settings form of the open tab; the sticky Save button submits it by id. */
  const settingsForm = (id: ConsoleSection, children: ReactNode) => (
    <form
      id={FORM_ID}
      className="flex flex-col gap-4"
      data-testid={`console-${id}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {children}
    </form>
  );

  const showSaveBar = !!cfg && !!draft && (SETTINGS_SECTIONS.includes(section) || dirty.length > 0);
  // Until the creator's first edit, each tab opens with one line saying what it is for.
  const hint = (id: ConsoleSection) =>
    cfg?.revision === 0 ? (
      <p className="text-caption text-mute" data-testid={`section-hint-${id}`}>
        {SECTION_HINTS[id]}
      </p>
    ) : null;
  // The first steps, from stored state (the saved instructions, not the draft): the card ticks a step when it is really done.
  const onboarding = cfg ? onboardingItems({ xHandle: token.xHandle, instructions: cfg.instructions, ...fuelFromAgent(agentRow.data ?? (agent && 'treasuryUsdc' in agent ? agent : null)), gasWei }) : null;
  const goTo = (target: ConsoleSection | 'x') => {
    if (target === 'x') {
      document.getElementById('connect-x')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setSection(target);
    if (target === 'mind') requestAnimationFrame(() => document.getElementById('console-instructions')?.focus());
  };

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          Creator console
          {pendingReviews > 0 ? (
            <span data-testid="approvals-pending">
              <Badge tone="ink">{pendingReviews} pending</Badge>
            </span>
          ) : null}
        </span>
      }
      action={cfg ? <span className="font-mono text-micro text-mute" data-testid="config-revision">{editedLabel(cfg.revision)}</span> : null}
    >
      <div data-testid="creator-console" className="@container flex flex-col gap-4">
        {onboarding ? <OnboardingCard kernel={token.kernel} items={onboarding} onGo={goTo} /> : null}
        {outlook && (outlook.runway || outlook.warnings.length > 0) ? (
          <div className="flex flex-col gap-2" data-testid="fuel-outlook">
            {outlook.runway ? (
              <p className="text-sm text-ink" data-testid="fuel-runway">
                {outlook.runway}
              </p>
            ) : null}
            {outlook.warnings.map((w) => (
              <p key={w.key} role="status" data-testid={`fuel-warning-${w.key}`} className={cn('rounded-xs px-3 py-2 text-caption', w.tone === 'danger' ? 'border border-danger text-danger' : 'bg-warning-surface text-warning')}>
                {w.text}
              </p>
            ))}
          </div>
        ) : null}
        {config.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-9" />
            <Skeleton className="h-24" />
            <Skeleton className="h-8" />
          </div>
        ) : !cfg || !draft ? (
          <div className="flex flex-col gap-4">
            <p className="text-caption text-mute" data-testid="console-unavailable">
              {config.isError ? 'The agent console is unavailable right now. Fuel and gas still work.' : 'The supervisor has not registered this agent yet. Fuel and gas still work.'}
            </p>
            <FuelAndGas token={token} agent={agent} inactive={inactive} gasWei={gasWei} kernelGas={kernelGas} onGas={() => void gas.refetch()} />
          </div>
        ) : (
          <Tabs<ConsoleSection> value={section} onValueChange={setSection}>
            <TabList variant="underline" dense aria-label="Console sections" className="-mx-5 overflow-x-auto px-5 [scrollbar-width:none]">
              {CONSOLE_SECTIONS.map((s) => (
                <Tab key={s.id} value={s.id} count={s.id === 'inbox' && inboxCount > 0 ? inboxCount : undefined}>
                  {s.label}
                  {dirty.includes(s.id) ? (
                    <span data-testid={`console-dirty-${s.id}`} className="inline-flex items-center">
                      <span className="size-1.5 rounded-full bg-ink" aria-hidden="true" />
                      <span className="sr-only">unsaved changes</span>
                    </span>
                  ) : null}
                </Tab>
              ))}
            </TabList>

            <TabPanel value="mind" className="pt-4">
              {settingsForm(
                'mind',
                <>
                  {hint('mind')}
                  <div>
                    <Label htmlFor="console-instructions" hint={<span className={cn('font-mono tabular', !instructionsOk && 'text-danger')}>{instructionsLen}/{INSTRUCTIONS_MAX}</span>}>
                      Instructions
                    </Label>
                    <Textarea
                      id="console-instructions"
                      value={draft.instructions}
                      onChange={(e) => update({ instructions: e.target.value })}
                      maxLength={INSTRUCTIONS_MAX + 50}
                      aria-invalid={!instructionsOk}
                      placeholder="Personality, goals, strategy, what it should and should not do."
                    />
                  </div>
                  <div>
                    <Label htmlFor="console-model" hint={priceOf(draft.model) != null ? <span className="font-mono tabular">{formatThoughtPrice(priceOf(draft.model))} per thought</span> : undefined}>
                      Model
                    </Label>
                    <Select id="console-model" value={draft.model} onChange={(e) => update({ model: e.target.value })}>
                      {modelGroups.map((g) => (
                        <optgroup key={g.provider} label={g.provider}>
                          {g.models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </Select>
                  </div>
                  <div className="rounded-sm border border-hairline px-3 py-2" data-testid="economy-mode">
                    <SwitchRow
                      title="Economy mode"
                      control={<Switch id="console-economy" label="Economy mode" checked={economyOn} onChange={(v) => update({ decideModel: v ? (cheapest?.id ?? cfg.routing.decideModel ?? null) : null })} disabled={!economyOn && !cheapest} />}
                    >
                      A cheaper model reads and decides; {modelLabel(draft.model)} writes only when there is something to publish.
                    </SwitchRow>
                    {economyOn ? (
                      <div className="mt-2">
                        <Label
                          htmlFor="console-decide-model"
                          hint={
                            <span className="font-mono tabular">
                              {formatThoughtPrice(priceOf(draft.decideModel))} vs {formatThoughtPrice(priceOf(draft.model))} per thought
                            </span>
                          }
                        >
                          Deciding model
                        </Label>
                        <Select id="console-decide-model" value={draft.decideModel ?? ''} onChange={(e) => update({ decideModel: e.target.value || null })}>
                          {decideGroups.map((g) => (
                            <optgroup key={g.provider} label={g.provider}>
                              {g.models.map((m) => (
                                <option key={m.id} value={m.id} disabled={m.id === draft.model}>
                                  {m.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </Select>
                        {draft.decideModel === draft.model ? <p className="mt-1 text-micro text-danger">Pick a model other than the writer, or the mode does nothing.</p> : null}
                      </div>
                    ) : null}
                    {fuelLine ? (
                      <p className="mt-2 text-micro text-mute" data-testid="fuel-by-model">
                        {fuelLine}
                      </p>
                    ) : null}
                  </div>
                </>,
              )}
            </TabPanel>

            <TabPanel value="posting" className="pt-4">
              {settingsForm(
                'posting',
                <>
                  {hint('posting')}
                  <div data-testid="posts-per-day">
                    <Label
                      htmlFor="console-posts-per-day"
                      hint={
                        <span className="font-mono tabular" data-testid="posts-per-day-value">
                          {draft.postsPerDay} a day · {cadenceLabel(budgetInterval ?? cfg.worker.postIntervalMs).toLowerCase()}
                        </span>
                      }
                    >
                      Posts per day
                    </Label>
                    <input
                      id="console-posts-per-day"
                      type="range"
                      min={POSTS_PER_DAY.min}
                      max={POSTS_PER_DAY.max}
                      step={1}
                      value={draft.postsPerDay}
                      onChange={(e) => update({ postsPerDay: Number(e.target.value) })}
                      aria-valuetext={`${draft.postsPerDay} posts and replies a day`}
                      className="block h-6 w-full cursor-pointer accent-ink"
                    />
                    <p className="mt-1.5 text-micro text-mute" data-testid="posts-per-day-note">
                      {budgetNote}
                    </p>
                  </div>
                  <SwitchRow
                    title="Review posts before they go out"
                    className="rounded-sm border border-hairline px-3 py-2"
                    control={<Switch id="console-review" label="Review posts before they go out" checked={draft.requireApproval} onChange={(v) => update({ requireApproval: v })} />}
                  >
                    Posts and replies wait in the Inbox’s review queue until you approve them; unreviewed items expire after 48 hours.
                  </SwitchRow>
                  <fieldset className="min-w-0">
                    <BlockTitle hint={<span className="font-mono tabular">{draft.jobLines.length}/{WORKER_BOUNDS.maxJobLines}</span>}>Job lines</BlockTitle>
                    <p className="mb-2 text-caption text-mute">What the agent is told to do, one job per line.</p>
                    <div className="space-y-2">
                      {draft.jobLines.map((line, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <Input
                            aria-label={`Job line ${i + 1}`}
                            value={line}
                            maxLength={WORKER_BOUNDS.maxJobLineChars}
                            placeholder={i === 0 ? 'Your job is …' : 'And …'}
                            onChange={(e) => update({ jobLines: draft.jobLines.map((l, j) => (j === i ? e.target.value : l)) })}
                            className="min-w-0 flex-1"
                          />
                          <Button type="button" variant="secondary" size="sm" className="h-8" aria-label={`Remove job line ${i + 1}`} onClick={() => update({ jobLines: draft.jobLines.filter((_, j) => j !== i) })}>
                            Remove
                          </Button>
                        </div>
                      ))}
                      {draft.jobLines.length < WORKER_BOUNDS.maxJobLines ? (
                        <Button type="button" variant="secondary" size="sm" onClick={() => update({ jobLines: [...draft.jobLines, ''] })}>
                          Add a job line
                        </Button>
                      ) : null}
                    </div>
                  </fieldset>
                </>,
              )}
            </TabPanel>

            <TabPanel value="powers" className="pt-4">
              {settingsForm(
                'powers',
                <fieldset className="flex min-w-0 flex-col gap-2">
                  <legend className="sr-only">Powers</legend>
                  {hint('powers')}
                  <div className="grid grid-cols-1 gap-px overflow-hidden rounded-sm border border-hairline bg-hairline @min-[18rem]:grid-cols-2" data-testid="powers-grid">
                    {POWERS.map((k) => (
                      <div key={k} className="flex flex-col gap-1 bg-canvas p-3" data-testid={`power-row-${k}`} data-on={draft.capabilities[k] ? 'true' : 'false'}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 text-sm leading-tight text-ink">{CAPABILITIES[k].label}</span>
                          <Switch id={`power-${k}`} label={CAPABILITIES[k].label} checked={draft.capabilities[k]} onChange={(v) => update({ capabilities: { ...draft.capabilities, [k]: v } })} />
                        </div>
                        <span className="text-micro text-mute">{CAPABILITIES[k].description}</span>
                      </div>
                    ))}
                  </div>
                  {draft.capabilities.services ? (
                    <div className="flex flex-col gap-3 rounded-sm border border-hairline bg-canvas-soft p-3" data-testid="services-caps">
                      <BlockTitle>Paid services caps</BlockTitle>
                      <div className="grid grid-cols-1 gap-3 @min-[18rem]:grid-cols-2">
                        <div>
                          <Label htmlFor="console-services-per-call" hint={<span className="font-mono tabular">USDC</span>}>
                            Most per call
                          </Label>
                          <Input id="console-services-per-call" value={draft.servicesPerCallUsdc} onChange={(e) => update({ servicesPerCallUsdc: e.target.value })} inputMode="decimal" aria-invalid={!sd || sd.perCallMicroUsdc === null} placeholder="0.05" />
                        </div>
                        <div>
                          <Label htmlFor="console-services-daily" hint={<span className="font-mono tabular">USDC</span>}>
                            Most per day
                          </Label>
                          <Input id="console-services-daily" value={draft.servicesDailyUsdc} onChange={(e) => update({ servicesDailyUsdc: e.target.value })} inputMode="decimal" aria-invalid={!sd || sd.dailyMicroUsdc === null || (sd.perCallMicroUsdc !== null && sd.perCallMicroUsdc > sd.dailyMicroUsdc)} placeholder="1" />
                        </div>
                      </div>
                      <p className={cn('text-micro', servicesOk ? 'text-mute' : 'text-danger')} data-testid="services-worst-case">
                        {servicesOk && sd?.dailyMicroUsdc != null
                          ? `Worst case: ${formatUsdcMicro(sd.dailyMicroUsdc)} USDC a day leaves the agent's fuel for services, whatever it is told. Each payment is public on the coin page with the agent's reason. Per call at most ${SERVICES_PER_CALL_MAX_MICRO_USDC / 1e6} USDC, per day at most ${SERVICES_DAILY_MAX_MICRO_USDC / 1e6}.`
                          : `Amounts are USDC with up to 6 decimals; per call at most ${SERVICES_PER_CALL_MAX_MICRO_USDC / 1e6} and never above the daily cap, per day at most ${SERVICES_DAILY_MAX_MICRO_USDC / 1e6}. Hosts are names like api.example.com or *.example.com.`}
                      </p>
                      <div className="grid grid-cols-1 gap-3 @min-[18rem]:grid-cols-2">
                        <div>
                          <Label htmlFor="console-services-allow">Only these hosts</Label>
                          <Textarea id="console-services-allow" value={draft.servicesAllow} onChange={(e) => update({ servicesAllow: e.target.value })} aria-invalid={!sd || sd.allow === null} rows={3} className="min-h-0" placeholder={'empty: any public host\napi.example.com\n*.data.example'} />
                        </div>
                        <div>
                          <Label htmlFor="console-services-deny">Never these hosts</Label>
                          <Textarea id="console-services-deny" value={draft.servicesDeny} onChange={(e) => update({ servicesDeny: e.target.value })} aria-invalid={!sd || sd.deny === null} rows={3} className="min-h-0" placeholder={'one per line'} />
                        </div>
                      </div>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {ALWAYS_ON_CAPABILITIES.map((k) => (
                      <Badge key={k}>{CAPABILITIES[k].label} · always on</Badge>
                    ))}
                  </div>
                </fieldset>,
              )}
            </TabPanel>

            <TabPanel value="look" className="flex flex-col gap-4 pt-4">
              {hint('look')}
              {settingsForm(
                'look',
                <div className="flex flex-col gap-3" data-testid="image-style">
                  <BlockTitle hint={!draft.capabilities.images ? <span>Images are off under Powers</span> : imagePrice != null ? <span className="font-mono tabular">{formatThoughtPrice(imagePrice)} per image</span> : undefined}>
                    Agent pictures
                  </BlockTitle>
                  <div className="grid grid-cols-1 gap-3 @min-[18rem]:grid-cols-2">
                    <div>
                      <Label htmlFor="console-image-model">Image model</Label>
                      <Select id="console-image-model" value={draft.imageModel} onChange={(e) => update({ imageModel: e.target.value })}>
                        {imageModelGroups.map((g) => (
                          <optgroup key={g.provider} label={g.provider}>
                            {g.models.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="console-image-notes" hint={<span className={cn('font-mono tabular', !notesOk && 'text-danger')}>{notesLen}/{IMAGE_NOTES_MAX}</span>}>
                        Style notes
                      </Label>
                      <Input id="console-image-notes" value={draft.imageNotes} onChange={(e) => update({ imageNotes: e.target.value })} maxLength={IMAGE_NOTES_MAX + 50} aria-invalid={!notesOk} placeholder="flat colours, no text" />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="console-image-reference">Reference image</Label>
                    <div className="flex items-center gap-3">
                      <TokenImage src={referenceOk && reference ? reference : null} symbol={token.symbol} size={40} className="rounded-xs" />
                      <Input
                        id="console-image-reference"
                        value={draft.imageReference}
                        onChange={(e) => update({ imageReference: e.target.value })}
                        aria-invalid={!referenceOk}
                        inputMode="url"
                        placeholder="https://… (empty: no reference)"
                        className="min-w-0 flex-1"
                      />
                    </div>
                    <p className={cn('mt-1.5 text-micro', referenceOk ? 'text-mute' : 'text-danger')}>
                      {referenceOk ? 'Pictures follow this image’s style and palette without copying it. The coin’s own image by default.' : 'The reference must be an https URL.'}
                    </p>
                  </div>
                </div>,
              )}
              <div className="border-t border-hairline pt-4">
                <CoinImageForm token={token} />
              </div>
              <div className="border-t border-hairline pt-4">
                <CoinLinksForm token={token} />
              </div>
            </TabPanel>

            <TabPanel value="inbox" className="pt-4" keepMounted>
              <div className="flex flex-col gap-4" data-testid="console-inbox">
                {hint('inbox')}
                <NotificationInbox token={token} />
                <ApprovalQueue token={token} reviewing={cfg.requireApproval} />
                <AgentChat token={token} />
              </div>
            </TabPanel>

            <TabPanel value="fuel" className="pt-4" keepMounted>
              <div className="flex flex-col gap-4" data-testid="console-fuel">
                {hint('fuel')}
                <FuelAndGas token={token} agent={agent} inactive={inactive} gasWei={gasWei} kernelGas={kernelGas} onGas={() => void gas.refetch()} />
              </div>
            </TabPanel>
          </Tabs>
        )}

        {showSaveBar && cfg ? (
          // The button sits left so the page's fixed mascot (bottom right) never covers it on a wide screen.
          <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex items-center justify-between gap-3 rounded-b-md border-t border-hairline bg-canvas px-5 py-3" data-testid="console-save-bar" data-dirty={dirty.length > 0 ? 'true' : 'false'}>
            {canSign ? (
              <Button type="submit" form={FORM_ID} variant="ink" size="md" className="shrink-0" disabled={!changes || !valid} loading={saving} loadingLabel="Saving…" onClick={SETTINGS_SECTIONS.includes(section) ? undefined : () => void save()}>
                Save changes
              </Button>
            ) : (
              <ConnectButton />
            )}
            <span className={cn('min-w-0 text-right text-micro lg:pr-10', dirty.length > 0 ? (valid ? 'text-ink' : 'text-danger') : 'text-mute')} data-testid="console-save-state">
              {dirty.length > 0 ? (valid ? `Unsaved changes in ${dirty.map(sectionLabel).join(', ')}` : 'Fix the marked fields to save') : 'One wallet signature; applies from the next cycle.'}
            </span>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/** Fuel and gas, with the gas notice: the Fuel tab, and the fallback while the supervisor has no config for the agent. */
function FuelAndGas({
  token,
  agent,
  inactive,
  gasWei,
  kernelGas,
  onGas,
}: {
  token: Token;
  agent: Agent | null;
  inactive: boolean;
  gasWei: bigint | null;
  kernelGas: { deposit: bigint; balance: bigint } | null | undefined;
  onGas: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <BlockTitle>Fuel</BlockTitle>
        <FuelForm kernel={token.kernel as Address} symbol={token.symbol} disabled={agent?.status === 'claimed'} />
        {inactive ? <p className="mt-2 text-caption text-mute">This agent is {agent?.status}. Fuel is held until it resumes.</p> : null}
      </div>
      <div id="gas">
        <BlockTitle hint={gasWei != null ? <span className="font-mono tabular">{formatGas(gasWei)} ETH</span> : undefined}>Gas</BlockTitle>
        {gasWei != null && gasStatus(gasWei) !== 'ok' && agent?.status !== 'claimed' ? (
          <p
            data-testid="gas-notice"
            className={cn('mb-2 rounded-xs px-3 py-2 text-caption', gasStatus(gasWei) === 'empty' ? 'border border-danger text-danger' : 'bg-warning-surface text-warning')}
            title={kernelGas ? `EntryPoint deposit ${formatGas(kernelGas.deposit)} ETH + kernel balance ${formatGas(kernelGas.balance)} ETH` : undefined}
          >
            {gasStatus(gasWei) === 'empty'
              ? 'Out of gas: the agent cannot claim fees, trade or refuel until someone adds gas. The creator funds the first gas; after that the agent refills from its own fees.'
              : 'Gas is low. The agent refills it from its own WETH fees on its next claim; add gas if it has none to claim yet.'}
          </p>
        ) : null}
        <GasForm kernel={token.kernel as Address} symbol={token.symbol} disabled={agent?.status === 'claimed'} onDone={onGas} />
      </div>
    </div>
  );
}
