'use client';

import { Fragment, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { ALWAYS_ON_CAPABILITIES, CAPABILITIES, CAPABILITY_KEYS, type CapabilityKey, POSTS_PER_DAY, WORKER_BOUNDS } from '@bootr/shared/workers';
import { qk, useAgentConfig } from '@/lib/indexer';
import { fetchImageModels, fetchModels } from '@/lib/launch';
import { cheapestModel, DEFAULT_IMAGE_MODEL, FALLBACK_MODELS, formatMicroUsdc, formatThoughtPrice, groupByProvider, modelKey, modelLabel, type ModelOption } from '@/lib/models';
import { SERVICES_DAILY_MAX_MICRO_USDC, SERVICES_PER_CALL_MAX_MICRO_USDC, type Agent, type AgentConfig, type AgentConfigChanges, type Token } from '@/lib/types';
import { formatGas, gasStatus, gasTotal } from '@/lib/gas';
import { useKernelGas } from '@/lib/use-gas';
import { fuelOutlook } from '@/lib/fuel-outlook';
import { cadenceLabel, measuredThoughtCost, postBudgetNote, shownInterval } from '@/lib/post-budget';
import { useAgentActivity, useAgentFuel, useApprovalCount } from '@/lib/indexer';
import { Panel } from '@/components/ui/Panel';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select, Switch, Textarea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
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

const INSTRUCTIONS_MIN = 20;
const INSTRUCTIONS_MAX = 600;
/** `MAX_IMAGE_STYLE_NOTES_CHARS` in packages/agent-core. */
const IMAGE_NOTES_MAX = 200;
const POWERS = CAPABILITY_KEYS.filter((k) => !ALWAYS_ON_CAPABILITIES.includes(k));

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

/**
 * The creator's panel on the coin page: the inbox (NotificationInbox), the agent's instructions, powers (with the image model and image style under
 * Images), the post review switch, posts per day (the one pacing control; the cadence follows it) and model (from the supervisor via `/api/agent/:kernel/config`, saved with
 * a wallet signature through `POST` on the same route), the review queue (ApprovalQueue), the private chat (AgentChat), the coin's links
 * (CoinLinksForm), then the existing Fuel and Add gas actions. Shown only to the creator's wallet (everyone in mock
 * mode, where saving skips the signature).
 */
export function CreatorConsole({ token, agent }: { token: Token; agent: Agent | null }) {
  const { canSign, sign } = useCreatorSignature();
  const queryClient = useQueryClient();
  const config = useAgentConfig(token.kernel);
  const approvals = useApprovalCount(token.kernel);
  const fuel = useAgentFuel(token.kernel);
  const activity = useAgentActivity(token.kernel);
  const pendingReviews = approvals.data?.pending ?? 0;
  const models = useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 60_000 });
  const imageModels = useQuery({ queryKey: ['models', 'image'], queryFn: fetchImageModels, staleTime: 60_000 });
  const kernels = useMemo(() => [token.kernel as Address], [token.kernel]);
  const gas = useKernelGas(kernels);
  const kernelGas = gas.of(token.kernel as Address);
  const gasWei = kernelGas ? gasTotal(kernelGas) : null;
  const [edits, setEdits] = useState<{ revision: number; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);

  const cfg = config.data ?? null;
  // Edits belong to the revision they started from; a save (or someone else's) resets the form to the stored config.
  const draft = cfg ? (edits && edits.revision === cfg.revision ? edits.draft : draftOf(cfg)) : null;
  const update = (patch: Partial<Draft>) => {
    if (!cfg || !draft) return;
    setEdits({ revision: cfg.revision, draft: { ...draft, ...patch } });
  };
  const changes = cfg && draft ? diffConfig(cfg, draft) : null;
  const instructionsLen = draft?.instructions.trim().length ?? 0;
  const instructionsOk = instructionsLen >= INSTRUCTIONS_MIN && instructionsLen <= INSTRUCTIONS_MAX;
  const reference = draft?.imageReference.trim() ?? '';
  const referenceOk = reference === '' || isHttpsUrl(reference);
  const notesLen = draft?.imageNotes.trim().replace(/\s+/g, ' ').length ?? 0;
  const notesOk = notesLen <= IMAGE_NOTES_MAX;
  const styleOk = referenceOk && notesOk;
  const sd = draft ? servicesDraft(draft) : null;
  const servicesOk = !sd || (sd.perCallMicroUsdc !== null && sd.dailyMicroUsdc !== null && sd.perCallMicroUsdc <= sd.dailyMicroUsdc && sd.allow !== null && sd.deny !== null);
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
    return `Last ${fuel.data!.days} days: ${total} thoughts, ${formatMicroUsdc(spent)}${unanswered > 0 ? ` (${unanswered} charged with no answer)` : ''}: ${parts.join(', ')}.`;
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
    if (!cfg || !changes || !instructionsOk || !styleOk || !servicesOk) return;
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
      <div data-testid="creator-console" className="flex flex-col gap-4">
        <NotificationInbox token={token} />
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
            <Skeleton className="h-24" />
            <Skeleton className="h-5" />
            <Skeleton className="h-8" />
          </div>
        ) : !cfg || !draft ? (
          <p className="text-caption text-mute" data-testid="console-unavailable">
            {config.isError ? 'The agent console is unavailable right now. Fuel and gas still work.' : 'The supervisor has not registered this agent yet. Fuel and gas still work.'}
          </p>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
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
            <fieldset>
              <legend className="mb-1.5 text-caption font-medium text-ink">Powers</legend>
              <ul className="divide-y divide-hairline rounded-sm border border-hairline">
                {POWERS.map((k) => (
                  <Fragment key={k}>
                    <li className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0">
                        <span className="block text-sm text-ink">{CAPABILITIES[k].label}</span>
                        <span className="block text-micro text-mute">{CAPABILITIES[k].description}</span>
                      </span>
                      <Switch id={`power-${k}`} label={CAPABILITIES[k].label} checked={draft.capabilities[k]} onChange={(v) => update({ capabilities: { ...draft.capabilities, [k]: v } })} />
                    </li>
                    {k === 'services' && draft.capabilities.services ? (
                      <li className="flex flex-col gap-3 bg-canvas-soft px-3 py-3" data-testid="services-caps">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <Label htmlFor="console-services-allow">Only these hosts</Label>
                            <Textarea id="console-services-allow" value={draft.servicesAllow} onChange={(e) => update({ servicesAllow: e.target.value })} aria-invalid={!sd || sd.allow === null} rows={3} placeholder={'empty: any public host\napi.example.com\n*.data.example'} />
                          </div>
                          <div>
                            <Label htmlFor="console-services-deny">Never these hosts</Label>
                            <Textarea id="console-services-deny" value={draft.servicesDeny} onChange={(e) => update({ servicesDeny: e.target.value })} aria-invalid={!sd || sd.deny === null} rows={3} placeholder={'one per line'} />
                          </div>
                        </div>
                      </li>
                    ) : null}
                    {k === 'images' && draft.capabilities.images ? (
                      <li className="flex flex-col gap-3 bg-canvas-soft px-3 py-3" data-testid="image-style">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <Label htmlFor="console-image-model" hint={imagePrice != null ? <span className="font-mono tabular">{formatThoughtPrice(imagePrice)} per image</span> : undefined}>
                              Image model
                            </Label>
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
                            <Input
                              id="console-image-notes"
                              value={draft.imageNotes}
                              onChange={(e) => update({ imageNotes: e.target.value })}
                              maxLength={IMAGE_NOTES_MAX + 50}
                              aria-invalid={!notesOk}
                              placeholder="flat colours, no text"
                            />
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
                            {referenceOk
                              ? 'Every picture matches this image’s style and palette without copying it. The coin’s own image by default; clear it for none.'
                              : 'The reference must be an https URL.'}
                          </p>
                        </div>
                      </li>
                    ) : null}
                  </Fragment>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {ALWAYS_ON_CAPABILITIES.map((k) => (
                  <Badge key={k}>{CAPABILITIES[k].label} · always on</Badge>
                ))}
              </div>
            </fieldset>
            <div className="flex items-center justify-between gap-3 rounded-sm border border-hairline px-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm text-ink">Review posts before they go out</span>
                <span className="block text-micro text-mute">Posts and replies wait in the review queue below until you approve them; unreviewed items expire after 48 hours.</span>
              </span>
              <Switch id="console-review" label="Review posts before they go out" checked={draft.requireApproval} onChange={(v) => update({ requireApproval: v })} />
            </div>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-caption font-medium text-ink">Job lines</legend>
              <p className="mb-2 text-caption text-mute">What the agent is told to do, one job per line; up to {WORKER_BOUNDS.maxJobLines}. The platform&rsquo;s own agent follows them too.</p>
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
                    <Button type="button" variant="secondary" size="sm" aria-label={`Remove job line ${i + 1}`} onClick={() => update({ jobLines: draft.jobLines.filter((_, j) => j !== i) })}>
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="console-model">Model</Label>
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
            </div>
            <div className="rounded-sm border border-hairline px-3 py-2" data-testid="economy-mode">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm text-ink">Economy mode</span>
                  <span className="block text-micro text-mute">
                    A cheaper model does the reading and deciding; {modelLabel(draft.model)} writes only when there is something to publish. Most of a turn is reading, so most thoughts get cheaper.
                  </span>
                </span>
                <Switch id="console-economy" label="Economy mode" checked={economyOn} onChange={(v) => update({ decideModel: v ? (cheapest?.id ?? cfg.routing.decideModel ?? null) : null })} disabled={!economyOn && !cheapest} />
              </div>
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
            <div className="flex flex-col gap-2">
              {canSign ? (
                <Button type="submit" variant="ink" size="md" className="w-full" disabled={!changes || !instructionsOk || !styleOk || !servicesOk} loading={saving} loadingLabel="Saving…">
                  Save changes
                </Button>
              ) : (
                <ConnectButton className="w-full" block />
              )}
              <span className="text-micro text-mute">
                {cfg.worker.kind === 'custom' ? 'Custom worker' : `${cfg.worker.kind[0]!.toUpperCase()}${cfg.worker.kind.slice(1)} preset`} · saved with your wallet signature, applied from the next cycle.
              </span>
            </div>
          </form>
        )}

        {cfg ? <ApprovalQueue token={token} reviewing={cfg.requireApproval} /> : null}

        {cfg ? <AgentChat token={token} /> : null}

        <div className="border-t border-hairline pt-4">
          <CoinImageForm token={token} />
        </div>

        <div className="border-t border-hairline pt-4">
          <CoinLinksForm token={token} />
        </div>

        <div className="border-t border-hairline pt-4">
          <FuelForm kernel={token.kernel as Address} symbol={token.symbol} disabled={agent?.status === 'claimed'} />
          {inactive ? <p className="mt-2 text-caption text-mute">This agent is {agent?.status}. Fuel is held until it resumes.</p> : null}
          <div className="mt-2" id="gas">
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
            <GasForm kernel={token.kernel as Address} symbol={token.symbol} disabled={agent?.status === 'claimed'} onDone={() => void gas.refetch()} />
          </div>
        </div>
      </div>
    </Panel>
  );
}
