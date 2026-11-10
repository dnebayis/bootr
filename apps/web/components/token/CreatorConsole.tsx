'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { ALWAYS_ON_CAPABILITIES, CAPABILITIES, CAPABILITY_KEYS, type CapabilityKey, POSTS_PER_DAY, WORKER_BOUNDS } from '@bootr/shared/workers';
import { qk } from '@/lib/indexer';
import { fetchImageModels, fetchModels } from '@/lib/launch';
import { cheapestModel, DEFAULT_IMAGE_MODEL, FALLBACK_MODELS, formatMicroUsdc, formatThoughtPrice, groupByProvider, modelKey, modelLabel, type ModelOption } from '@/lib/models';
import { BOUNTIES_BOUNDS, SERVICES_DAILY_MAX_MICRO_USDC, SERVICES_PER_CALL_MAX_MICRO_USDC, type Agent, type AgentBountiesPolicy, type AgentConfig, type AgentConfigChanges, type Token } from '@/lib/types';
import { formatGas, gasStatus } from '@/lib/gas';
import { cadenceLabel, measuredThoughtCost, postBudgetNote, shownInterval } from '@/lib/post-budget';
import { changedSections, CONSOLE_SECTIONS, sectionLabel, SETTINGS_SECTIONS, type ConsoleSection } from '@/lib/console-sections';
import { SECTION_HINTS } from '@/lib/onboarding';
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
import { V5MetadataForm } from './V5MetadataForm';
import { v5SettingsOf } from '@/lib/token-settings';
import { useConsoleStatus } from './console-status';
import { useCreatorSignature } from './creator-signature';
import { FuelForm } from './FuelForm';
import { GasForm } from './GasForm';
import { NotificationInbox } from './NotificationInbox';

const INSTRUCTIONS_MIN = 20;
const INSTRUCTIONS_MAX = 600;
/** `MAX_IMAGE_STYLE_NOTES_CHARS` in packages/agent-core. */
const IMAGE_NOTES_MAX = 200;
const POWERS = CAPABILITY_KEYS.filter((k) => !ALWAYS_ON_CAPABILITIES.includes(k));
/** The one settings form: each settings section mounts it under this id, so the sticky Save button submits whichever is open. */
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
  /** Bounties bounds as typed: the daily cap in USDC (two decimals), whole open jobs, the cooldown in days, the window in hours. */
  bountiesDailyUsdc: string;
  bountiesMaxOpen: string;
  bountiesCooldownDays: string;
  bountiesHoursOpen: string;
  bountiesReview: boolean;
};

const DAY_S = 86_400;

/** "5" or "2.50" -> micro-USDC; null when the text is not a USDC amount with at most two decimals. */
export function parseUsdcCents(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 1_000_000 + Number((frac + '00').slice(0, 2)) * 10_000;
}

/** A whole number typed in a field, inside [min, max]; null otherwise. */
function wholeIn(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** The bounties bounds the draft asks for; null fields are invalid as typed. */
export function bountiesDraft(d: Pick<Draft, 'bountiesDailyUsdc' | 'bountiesMaxOpen' | 'bountiesCooldownDays' | 'bountiesHoursOpen' | 'bountiesReview'>): { [K in Exclude<keyof AgentBountiesPolicy, 'review'>]: number | null } & { review: boolean } {
  const daily = parseUsdcCents(d.bountiesDailyUsdc);
  const cooldownDays = wholeIn(d.bountiesCooldownDays, 0, BOUNTIES_BOUNDS.cooldownMaxSeconds / DAY_S);
  return {
    dailyCapMicroUsdc: daily !== null && daily <= BOUNTIES_BOUNDS.dailyCapMaxMicroUsdc ? daily : null,
    maxOpen: wholeIn(d.bountiesMaxOpen, 0, BOUNTIES_BOUNDS.maxOpenMax),
    cooldownSeconds: cooldownDays !== null ? cooldownDays * DAY_S : null,
    defaultHoursOpen: wholeIn(d.bountiesHoursOpen, BOUNTIES_BOUNDS.hoursOpenMin, BOUNTIES_BOUNDS.hoursOpenMax),
    review: d.bountiesReview,
  };
}

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
    bountiesDailyUsdc: (c.bounties.dailyCapMicroUsdc / 1_000_000).toFixed(2),
    bountiesMaxOpen: String(c.bounties.maxOpen),
    bountiesCooldownDays: String(Math.round(c.bounties.cooldownSeconds / DAY_S)),
    bountiesHoursOpen: String(c.bounties.defaultHoursOpen),
    bountiesReview: c.bounties.review,
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
  const bd = bountiesDraft(d);
  const bounties: NonNullable<AgentConfigChanges['bounties']> = {};
  for (const key of ['dailyCapMicroUsdc', 'maxOpen', 'cooldownSeconds', 'defaultHoursOpen'] as const) {
    const v = bd[key];
    if (v !== null && v !== config.bounties[key]) bounties[key] = v;
  }
  if (bd.review !== config.bounties.review) bounties.review = bd.review;
  if (Object.keys(bounties).length) changes.bounties = bounties;
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

/** A caption heading inside a section, for the blocks that are not a single labelled field. */
function BlockTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <h3 className="text-caption font-medium text-ink">{children}</h3>
      {hint ? <span className="text-caption text-mute">{hint}</span> : null}
    </div>
  );
}

/** A bordered block of the page: one group of fields. */
function Box({ children, className, ...rest }: { children: ReactNode; className?: string; 'data-testid'?: string }) {
  return (
    <div className={cn('rounded-md border border-hairline p-4', className)} {...rest}>
      {children}
    </div>
  );
}

/** The fuel runway line and warnings, above the sections so they are seen whichever is open. */
export function FuelOutlookStrip({ outlook }: { outlook: ReturnType<typeof useConsoleStatus>['outlook'] }) {
  if (!outlook || (!outlook.runway && outlook.warnings.length === 0)) return null;
  return (
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
  );
}

/**
 * The creator console, on its own page (`/token/:address/console`, ConsolePage.tsx) so it has the whole content
 * width: a sticky rail of sections on the left from `lg` (the dense tab strip on a phone) and the open section on the
 * right. Mind (instructions; model and economy mode side by side), Posting (posts per day and post review side by
 * side; job lines), Powers (the switches in a three-column grid, the paid-services caps and the bounties bounds as
 * full-width rows under them while those powers are on), Look (the agent's pictures; the coin's image and links side by side), Inbox
 * (notifications and the review queue on the left, the chat on the right) and Fuel (fuel and gas side by side). The
 * four settings sections edit one draft, saved together from the sticky bar at the bottom with one wallet signature
 * (`POST /api/agent/:kernel/config`); the inbox, queue and chat share the console session's one signature
 * (console-session.ts). Fuel warnings sit above the sections. Until the config's first edit each section opens with
 * one line saying what it is for. The caller (the page) checks that the wallet is the creator; in mock mode everyone is.
 */
export function CreatorConsole({ token, agent, section, onSectionChange }: { token: Token; agent: Agent | null; section: ConsoleSection; onSectionChange: (s: ConsoleSection) => void }) {
  const { canSign, sign } = useCreatorSignature();
  const queryClient = useQueryClient();
  const { config, cfg, fuel, gas, kernelGas, gasWei, inboxCount, inactive, outlook } = useConsoleStatus(token, agent);
  const models = useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 60_000 });
  const imageModels = useQuery({ queryKey: ['models', 'image'], queryFn: fetchImageModels, staleTime: 60_000 });
  const [edits, setEdits] = useState<{ revision: number; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);

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
  const bd = draft ? bountiesDraft(draft) : null;
  const bountiesOk = !bd || (bd.dailyCapMicroUsdc !== null && bd.maxOpen !== null && bd.cooldownSeconds !== null && bd.defaultHoursOpen !== null);
  const valid = instructionsOk && styleOk && servicesOk && bountiesOk;

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

  /** The settings form of the open section; the sticky Save button submits it by id. */
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
  // Until the creator's first edit, each section opens with one line saying what it is for.
  const hint = (id: ConsoleSection) =>
    cfg?.revision === 0 ? (
      <p className="text-caption text-mute" data-testid={`section-hint-${id}`}>
        {SECTION_HINTS[id]}
      </p>
    ) : null;
  const showSaveBar = !!cfg && !!draft && (SETTINGS_SECTIONS.includes(section) || dirty.length > 0);
  const fuelAndGas = <FuelAndGas token={token} agent={agent} inactive={inactive} gasWei={gasWei} kernelGas={kernelGas} onGas={() => void gas.refetch()} />;

  if (config.isPending) {
    return (
      <div data-testid="creator-console" className="grid gap-6 lg:grid-cols-[11.25rem_minmax(0,1fr)]">
        <Skeleton className="h-9 lg:h-56" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-8" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  if (!cfg || !draft) {
    return (
      <div data-testid="creator-console" className="@container flex max-w-2xl flex-col gap-4">
        <p className="text-caption text-mute" data-testid="console-unavailable">
          {config.isError ? 'The agent console is unavailable right now. Fuel and gas still work.' : 'The supervisor has not registered this agent yet. Fuel and gas still work.'}
        </p>
        {fuelAndGas}
      </div>
    );
  }

  return (
    <Tabs<ConsoleSection> value={section} onValueChange={onSectionChange} className="grid gap-6 lg:grid-cols-[11.25rem_minmax(0,1fr)]">
      <TabList variant="rail" aria-label="Console sections" className="-mx-4 px-4 md:-mx-6 md:px-6 lg:sticky lg:top-24 lg:mx-0 lg:self-start lg:px-0">
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

      <div data-testid="creator-console" className="@container flex min-w-0 flex-col gap-4">
        <FuelOutlookStrip outlook={outlook} />

        <TabPanel value="mind">
          {settingsForm(
            'mind',
            <>
              {hint('mind')}
              <Box>
                <Label htmlFor="console-instructions" hint={<span className={cn('font-mono tabular', !instructionsOk && 'text-danger')}>{instructionsLen}/{INSTRUCTIONS_MAX}</span>}>
                  Instructions
                </Label>
                <Textarea
                  id="console-instructions"
                  value={draft.instructions}
                  onChange={(e) => update({ instructions: e.target.value })}
                  maxLength={INSTRUCTIONS_MAX + 50}
                  aria-invalid={!instructionsOk}
                  className="min-h-32"
                  placeholder="Personality, goals, strategy, what it should and should not do."
                />
              </Box>
              <div className={"grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-2"}>
                <Box>
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
                  {fuelLine ? (
                    <p className="mt-3 text-micro text-mute" data-testid="fuel-by-model">
                      {fuelLine}
                    </p>
                  ) : null}
                </Box>
                <Box data-testid="economy-mode">
                  <SwitchRow
                    title="Economy mode"
                    control={<Switch id="console-economy" label="Economy mode" checked={economyOn} onChange={(v) => update({ decideModel: v ? (cheapest?.id ?? cfg.routing.decideModel ?? null) : null })} disabled={!economyOn && !cheapest} />}
                  >
                    A cheaper model reads and decides; {modelLabel(draft.model)} writes only when there is something to publish.
                  </SwitchRow>
                  {economyOn ? (
                    <div className="mt-3">
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
                </Box>
              </div>
            </>,
          )}
        </TabPanel>

        <TabPanel value="posting">
          {settingsForm(
            'posting',
            <>
              {hint('posting')}
              <div className={"grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-2"}>
                <Box data-testid="posts-per-day">
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
                </Box>
                <Box>
                  <SwitchRow title="Review posts before they go out" control={<Switch id="console-review" label="Review posts before they go out" checked={draft.requireApproval} onChange={(v) => update({ requireApproval: v })} />}>
                    Posts and replies wait in the Inbox’s review queue until you approve them; unreviewed items expire after 48 hours.
                  </SwitchRow>
                </Box>
              </div>
              <Box>
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
              </Box>
            </>,
          )}
        </TabPanel>

        <TabPanel value="powers">
          {settingsForm(
            'powers',
            <fieldset className="flex min-w-0 flex-col gap-4">
              <legend className="sr-only">Powers</legend>
              {hint('powers')}
              <div className={"grid grid-cols-1 gap-px overflow-hidden rounded-md border border-hairline bg-hairline @min-[18rem]:grid-cols-2 @min-[40rem]:grid-cols-3"} data-testid="powers-grid">
                {POWERS.map((k) => (
                  <div key={k} className="flex flex-col gap-1 bg-canvas p-4" data-testid={`power-row-${k}`} data-on={draft.capabilities[k] ? 'true' : 'false'}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 text-sm leading-tight text-ink">{CAPABILITIES[k].label}</span>
                      <Switch id={`power-${k}`} label={CAPABILITIES[k].label} checked={draft.capabilities[k]} onChange={(v) => update({ capabilities: { ...draft.capabilities, [k]: v } })} />
                    </div>
                    <span className="text-micro text-mute">{CAPABILITIES[k].description}</span>
                  </div>
                ))}
              </div>
              {draft.capabilities.services ? (
                <Box className="flex flex-col gap-3 bg-canvas-soft" data-testid="services-caps">
                  <BlockTitle>Paid services caps</BlockTitle>
                  <div className={"grid grid-cols-1 gap-3 @min-[18rem]:grid-cols-2 @min-[40rem]:grid-cols-4"}>
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
                    <div>
                      <Label htmlFor="console-services-allow">Only these hosts</Label>
                      <Textarea id="console-services-allow" value={draft.servicesAllow} onChange={(e) => update({ servicesAllow: e.target.value })} aria-invalid={!sd || sd.allow === null} rows={3} className="min-h-0" placeholder={'empty: any public host\napi.example.com\n*.data.example'} />
                    </div>
                    <div>
                      <Label htmlFor="console-services-deny">Never these hosts</Label>
                      <Textarea id="console-services-deny" value={draft.servicesDeny} onChange={(e) => update({ servicesDeny: e.target.value })} aria-invalid={!sd || sd.deny === null} rows={3} className="min-h-0" placeholder={'one per line'} />
                    </div>
                  </div>
                  <p className={cn('text-micro', servicesOk ? 'text-mute' : 'text-danger')} data-testid="services-worst-case">
                    {servicesOk && sd?.dailyMicroUsdc != null
                      ? `Worst case: ${formatUsdcMicro(sd.dailyMicroUsdc)} USDC a day leaves the agent's fuel for services, whatever it is told. Each payment is public on the coin page with the agent's reason. Per call at most ${SERVICES_PER_CALL_MAX_MICRO_USDC / 1e6} USDC, per day at most ${SERVICES_DAILY_MAX_MICRO_USDC / 1e6}.`
                      : `Amounts are USDC with up to 6 decimals; per call at most ${SERVICES_PER_CALL_MAX_MICRO_USDC / 1e6} and never above the daily cap, per day at most ${SERVICES_DAILY_MAX_MICRO_USDC / 1e6}. Hosts are names like api.example.com or *.example.com.`}
                  </p>
                </Box>
              ) : null}
              {draft.capabilities.bounties ? (
                <Box className="flex flex-col gap-3 bg-canvas-soft" data-testid="bounties-caps">
                  <BlockTitle>Bounties</BlockTitle>
                  <p className="text-caption text-body" data-testid="bounties-copy">
                    The agent posts small jobs on X, work it can use itself, such as a picture for its next post or a page it will cite, and picks the best entry against the criteria it wrote. Each job pays 0.1 to 1 USDC; the agent chooses the amount inside the caps below. In this stage you pay each winner yourself: a proposed payment lands in your Inbox with the address and the amount, you send the USDC from your wallet and paste the transaction hash. Nothing is paid without your yes. Every job, verdict and payment is public on the coin page.
                  </p>
                  <p className="text-micro text-mute">The agent gets a separate hourly turn for its treasury while this is on.</p>
                  <div className={"grid grid-cols-1 gap-3 @min-[18rem]:grid-cols-2 @min-[40rem]:grid-cols-4"}>
                    <div>
                      <Label htmlFor="console-bounties-daily" hint={<span className="font-mono tabular">USDC</span>}>
                        Most per day
                      </Label>
                      <Input id="console-bounties-daily" value={draft.bountiesDailyUsdc} onChange={(e) => update({ bountiesDailyUsdc: e.target.value })} inputMode="decimal" aria-invalid={!bd || bd.dailyCapMicroUsdc === null} placeholder="5.00" />
                    </div>
                    <div>
                      <Label htmlFor="console-bounties-max-open" hint={<span className="font-mono tabular">jobs</span>}>
                        Open at a time
                      </Label>
                      <Input id="console-bounties-max-open" value={draft.bountiesMaxOpen} onChange={(e) => update({ bountiesMaxOpen: e.target.value })} inputMode="numeric" aria-invalid={!bd || bd.maxOpen === null} placeholder="2" />
                    </div>
                    <div>
                      <Label htmlFor="console-bounties-cooldown" hint={<span className="font-mono tabular">days</span>}>
                        Same winner again after
                      </Label>
                      <Input id="console-bounties-cooldown" value={draft.bountiesCooldownDays} onChange={(e) => update({ bountiesCooldownDays: e.target.value })} inputMode="numeric" aria-invalid={!bd || bd.cooldownSeconds === null} placeholder="7" />
                    </div>
                    <div>
                      <Label htmlFor="console-bounties-hours" hint={<span className="font-mono tabular">hours</span>}>
                        Entries taken for
                      </Label>
                      <Input id="console-bounties-hours" value={draft.bountiesHoursOpen} onChange={(e) => update({ bountiesHoursOpen: e.target.value })} inputMode="numeric" aria-invalid={!bd || bd.defaultHoursOpen === null} placeholder="6" />
                    </div>
                  </div>
                  <SwitchRow title="Review every job text first" control={<Switch id="console-bounties-review" label="Review every job text first" checked={draft.bountiesReview} onChange={(v) => update({ bountiesReview: v })} />}>
                    Each job waits in the Inbox’s review queue before it is posted, like a post.
                  </SwitchRow>
                  <p className={cn('text-micro', bountiesOk ? 'text-mute' : 'text-danger')} data-testid="bounties-bounds">
                    {bountiesOk
                      ? `Per day at most ${BOUNTIES_BOUNDS.dailyCapMaxMicroUsdc / 1e6} USDC, counted when a job opens; at most ${BOUNTIES_BOUNDS.maxOpenMax} jobs open at a time; the same winner again after 0 (any time) to ${BOUNTIES_BOUNDS.cooldownMaxSeconds / DAY_S} days; entries taken for ${BOUNTIES_BOUNDS.hoursOpenMin} to ${BOUNTIES_BOUNDS.hoursOpenMax} hours unless the agent names a window.`
                      : `Whole numbers: per day up to ${BOUNTIES_BOUNDS.dailyCapMaxMicroUsdc / 1e6} USDC with at most two decimals, open jobs 0 to ${BOUNTIES_BOUNDS.maxOpenMax}, cooldown 0 to ${BOUNTIES_BOUNDS.cooldownMaxSeconds / DAY_S} days, window ${BOUNTIES_BOUNDS.hoursOpenMin} to ${BOUNTIES_BOUNDS.hoursOpenMax} hours.`}
                  </p>
                </Box>
              ) : null}
              <div className="flex flex-wrap items-center gap-1.5">
                {ALWAYS_ON_CAPABILITIES.map((k) => (
                  <Badge key={k}>{CAPABILITIES[k].label} · always on</Badge>
                ))}
              </div>
            </fieldset>,
          )}
        </TabPanel>

        <TabPanel value="look" className="flex flex-col gap-4">
          {hint('look')}
          {settingsForm(
            'look',
            <Box className="flex flex-col gap-3" data-testid="image-style">
              <BlockTitle hint={!draft.capabilities.images ? <span>Images are off under Powers</span> : imagePrice != null ? <span className="font-mono tabular">{formatThoughtPrice(imagePrice)} per image</span> : undefined}>
                Agent pictures
              </BlockTitle>
              <div className={"grid grid-cols-1 gap-3 @min-[18rem]:grid-cols-2 @min-[40rem]:grid-cols-3"}>
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
                <div className="@min-[18rem]:col-span-2 @min-[40rem]:col-span-1">
                  <Label htmlFor="console-image-reference">Reference image</Label>
                  <div className="flex items-center gap-3">
                    <TokenImage src={referenceOk && reference ? reference : null} symbol={token.symbol} size={32} className="rounded-xs" />
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
              </div>
            </Box>,
          )}
          <div className={"grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-2"}>
            <Box>
              <CoinImageForm token={token} />
            </Box>
            <Box>
              <CoinLinksForm token={token} />
            </Box>
            {/* A Clanker v5 coin launched with editable metadata: the token's own image and description, creator only. */}
            {v5SettingsOf(token)?.metadataEditable ? (
              <Box>
                <V5MetadataForm token={token} />
              </Box>
            ) : null}
          </div>
        </TabPanel>

        <TabPanel value="inbox" keepMounted>
          <div className="flex flex-col gap-4" data-testid="console-inbox">
            {hint('inbox')}
            <div className={"grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-2"}>
              <div className="flex flex-col gap-4">
                <Box className="[&>[data-testid=notification-inbox]]:border-b-0 [&>[data-testid=notification-inbox]]:pb-0">
                  <NotificationInbox token={token} />
                </Box>
                <ApprovalQueueBox token={token} reviewing={cfg.requireApproval} />
              </div>
              <Box className="self-start [&>[data-testid=agent-chat]]:border-t-0 [&>[data-testid=agent-chat]]:pt-0">
                <AgentChat token={token} />
              </Box>
            </div>
          </div>
        </TabPanel>

        <TabPanel value="fuel" keepMounted>
          <div className="flex flex-col gap-4" data-testid="console-fuel">
            {hint('fuel')}
            {fuelAndGas}
          </div>
        </TabPanel>

        {showSaveBar ? (
          <div className="sticky bottom-0 z-10 mt-2 flex items-center justify-between gap-3 border-t border-hairline bg-canvas py-3" data-testid="console-save-bar" data-dirty={dirty.length > 0 ? 'true' : 'false'}>
            <span className={cn('min-w-0 text-micro', dirty.length > 0 ? (valid ? 'text-ink' : 'text-danger') : 'text-mute')} data-testid="console-save-state">
              {dirty.length > 0 ? (valid ? `Unsaved changes in ${dirty.map(sectionLabel).join(', ')}` : 'Fix the marked fields to save') : 'One wallet signature; applies from the next cycle.'}
            </span>
            {canSign ? (
              <Button type="submit" form={FORM_ID} variant="ink" size="md" className="shrink-0" disabled={!changes || !valid} loading={saving} loadingLabel="Saving…" onClick={SETTINGS_SECTIONS.includes(section) ? undefined : () => void save()}>
                Save changes
              </Button>
            ) : (
              <ConnectButton />
            )}
          </div>
        ) : null}
      </div>
    </Tabs>
  );
}

/** The review queue in its own box, or nothing when it has nothing to show (review off and no items). */
function ApprovalQueueBox({ token, reviewing }: { token: Token; reviewing: boolean }) {
  return (
    <div className="empty:hidden rounded-md border border-hairline p-4 [&>[data-testid=approval-queue]]:border-t-0 [&>[data-testid=approval-queue]]:pt-0">
      <ApprovalQueue token={token} reviewing={reviewing} />
    </div>
  );
}

/** Fuel and gas side by side, with the gas notice: the Fuel section, and the fallback while the supervisor has no config for the agent. */
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
    <div className={"grid grid-cols-1 gap-4 @min-[40rem]:grid-cols-2"}>
      <Box>
        <BlockTitle>Fuel</BlockTitle>
        <FuelForm kernel={token.kernel as Address} symbol={token.symbol} disabled={agent?.status === 'claimed'} />
        {inactive ? <p className="mt-2 text-caption text-mute">This agent is {agent?.status}. Fuel is held until it resumes.</p> : null}
      </Box>
      <Box>
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
      </Box>
    </div>
  );
}
