'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { USER_CODE_RE, type ClientsResponse, type ClientView, type Runner, type RunnerSwitchResponse, type WaitingApprovalView } from '@bootr/shared/own-agent';
import type { Address } from 'viem';
import { ago } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { qk, ReviewError, type ReviewAuth } from '@/lib/indexer';
import type { AiClientId } from '@/lib/keep-running';
import { fetchModels } from '@/lib/launch';
import { FALLBACK_MODELS, groupByProvider, modelKey, modelLabel, RECOMMENDED_MODEL } from '@/lib/models';
import type { Agent, AgentConfig, Token } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogClose } from '@/components/ui/Dialog';
import { Label, Select } from '@/components/ui/Field';
import { ClientSetupSteps } from '@/components/launch/ConnectClientStep';
import { KeepRunning } from '@/components/launch/KeepRunning';
import { RUNNER_LABEL } from '@/components/launch/RunnerChoice';
import { ownPresence } from './AgentStatusLine';
import { FuelForm } from './FuelForm';
import { useConsoleSession } from './console-session';

type WithToken<T> = T & { token?: string };

/** One call inside the console's signed session (the same shape as the inbox and the chat). */
async function consolePost<T>(kernel: string, path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/agent/${encodeURIComponent(kernel.toLowerCase())}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ReviewError(res.status, err.error ?? `http_${res.status}`, err.message ?? `The request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

function sanitizeClients(raw: Partial<ClientsResponse> | null | undefined): ClientsResponse & { waiting: WaitingApprovalView[] } {
  const clients = (Array.isArray(raw?.clients) ? raw.clients : []).filter((c): c is ClientView => !!c && typeof c.clientId === 'string' && typeof c.label === 'string');
  // Approvals the creator signed that no client has collected yet: absent from a server that does not list them.
  const waiting = (Array.isArray(raw?.waiting) ? raw.waiting : []).filter((w): w is WaitingApprovalView => !!w && typeof w.userCode === 'string' && USER_CODE_RE.test(w.userCode) && typeof w.label === 'string');
  return { clients, max: typeof raw?.max === 'number' && raw.max > 0 ? raw.max : 3, waiting };
}

/** "in 7 min", for an approval that runs out soon (`nowMs` is 0 before the clock has ticked). */
function minutesLeft(expiresAt: string, nowMs: number): string {
  const left = Date.parse(expiresAt) - nowMs;
  if (!nowMs || !Number.isFinite(left)) return 'within 10 min';
  return left <= 60_000 ? 'in under a minute' : `in ${Math.ceil(left / 60_000)} min`;
}

function usdcTotal(agent: Agent | null): number | null {
  if (!agent || !('treasuryUsdc' in agent)) return null;
  try {
    return Number(BigInt(agent.treasuryUsdc || '0') + BigInt(agent.spenderUsdc || '0')) / 1e6;
  } catch {
    return null;
  }
}

function usdcText(amount: number): string {
  return amount.toFixed(2).replace(/\.?0+$/, '') || '0';
}

const unix = (iso: string | null | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/**
 * The console's Agent card, at the top of Mind (docs/design/byo-agent.md section 5.3): who runs the coin's agent, the
 * AI clients connected to it with a disconnect button on each, how to connect one and keep it running, and the switch
 * between "My own agent" and "Bootr agent". The switch changes one stored value on Bootr's side: nothing on chain, no
 * new key, and memory, posts, holds and approvals carry over.
 *
 * Three forms. A Bootr-agent coin: one line and the switch to an own agent (only where own agents are offered; the
 * card is not rendered otherwise). An own coin: the clients, the connect steps, the recipe, the switch back. An own
 * coin while own agents are switched off: the short form, which says the agent is silent and still lets the creator
 * disconnect a client and hand the agent back to Bootr.
 */
export function AgentRunnerCard({ token, agent, config, ownOffered }: { token: Token; agent: Agent | null; config: AgentConfig; ownOffered: boolean }) {
  const session = useConsoleSession(token);
  const queryClient = useQueryClient();
  const own = config.runner === 'own';
  const [dialog, setDialog] = useState<Runner | null>(null);
  const [switching, setSwitching] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [opening, setOpening] = useState(false);
  const now = useNow();
  const [busyClient, setBusyClient] = useState<string | null>(null);
  const [client, setClient] = useState<AiClientId>('claude-code');
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const models = useQuery({ queryKey: ['models'], queryFn: fetchModels, staleTime: 60_000, enabled: own });
  const modelList = models.data?.models ?? FALLBACK_MODELS;
  // The model the Bootr agent would think with: the stored one while it is still offered, else the creator picks.
  const storedMatch = modelList.find((m) => m.id === config.model) ?? modelList.find((m) => modelKey(m.id) === modelKey(config.model));
  const storedOffered = !!storedMatch;
  const model = pickedModel ?? storedMatch?.id ?? modelList.find((m) => m.id === RECOMMENDED_MODEL)?.id ?? modelList[0]?.id ?? '';
  const modelGroups = useMemo(() => groupByProvider(modelList), [modelList]);
  const fuel = usdcTotal(agent);

  const expired = (err: unknown) => {
    if (err instanceof ReviewError && err.status === 401) {
      session.forget();
      toast.error('The console session expired. Try again.');
      return true;
    }
    return false;
  };

  // The connected clients, read inside the console's signed session. With the console already open (the inbox or the
  // chat asked for the signature) the list loads on its own; otherwise the creator opens it with one signature.
  const clientsKey = [...qk.agent(token.kernel), 'clients'] as const;
  const clientsQuery = useQuery<ClientsResponse>({
    queryKey: clientsKey,
    queryFn: async () => sanitizeClients(await consolePost<WithToken<ClientsResponse>>(token.kernel, 'clients/list', { token: session.held() })),
    enabled: own && session.open,
    staleTime: 30_000,
    retry: false,
  });
  const clients = clientsQuery.data ?? null;
  // Approvals not yet collected, less the ones whose ten minutes have passed since the list was read.
  const waiting = (clients?.waiting ?? []).filter((w) => !now || Date.parse(w.expiresAt) > now);
  const clientsUnavailable = clientsQuery.isError;
  const setClients = (next: ClientsResponse) => queryClient.setQueryData(clientsKey, next);

  const openClients = async (auth: ReviewAuth | null) => {
    if (!auth) return;
    setOpening(true);
    try {
      const res = await consolePost<WithToken<ClientsResponse>>(token.kernel, 'clients/list', { ...auth });
      setClients(sanitizeClients(res));
      session.keep(res.token);
    } catch (err) {
      if (!expired(err)) toast.error('The client list is unavailable right now.');
    } finally {
      setOpening(false);
    }
  };

  const disconnect = async (target: { clientId: string } | { userCode: string } | { all: true }) => {
    const auth = await session.auth();
    if (!auth) return;
    setBusyClient('clientId' in target ? target.clientId : 'userCode' in target ? target.userCode : 'all');
    try {
      const res = await consolePost<WithToken<ClientsResponse>>(token.kernel, 'clients/revoke', { ...auth, ...target });
      session.keep(res.token);
      setClients(sanitizeClients(res));
      void queryClient.invalidateQueries({ queryKey: qk.agentConfig(token.kernel) });
      toast.success('all' in target ? 'Every client was disconnected, and no approval is left to collect.' : 'userCode' in target ? 'Approval cancelled. No client can collect it.' : 'Client disconnected. It cannot act for this coin any more.');
    } catch (err) {
      if (expired(err)) return;
      // An approval that was collected or ran out a moment ago is no longer there to cancel: the list is read again.
      const gone = 'userCode' in target && err instanceof ReviewError && err.code === 'client_not_found';
      if (gone) void queryClient.invalidateQueries({ queryKey: clientsKey });
      toast.error(gone ? 'That approval was already collected or ran out. Check the list of clients.' : err instanceof Error ? err.message : 'Could not disconnect that client.');
    } finally {
      setBusyClient(null);
    }
  };

  const switchTo = async (runner: Runner) => {
    const auth = await session.auth();
    if (!auth) return;
    setSwitching(true);
    try {
      const res = await consolePost<WithToken<RunnerSwitchResponse>>(token.kernel, 'runner', { ...auth, runner, ...(runner === 'hosted' && model ? { model } : {}) });
      session.keep(res.token);
      setNotes(res.notes ?? []);
      setDialog(null);
      setPickedModel(null);
      await queryClient.invalidateQueries({ queryKey: qk.agentConfig(token.kernel) });
      void queryClient.invalidateQueries({ queryKey: qk.agentActivity(token.kernel) });
      toast.success(runner === 'own' ? 'Your agent now runs in your client.' : 'The Bootr agent runs this coin again.');
    } catch (err) {
      if (!expired(err)) toast.error(err instanceof Error ? err.message : 'Could not switch the agent.');
    } finally {
      setSwitching(false);
    }
  };

  const presence = own ? ownPresence(config.own?.lastTurnAt, config.worker.postIntervalMs, now) : null;
  const connectedCount = clients ? clients.clients.length : (config.own?.clients ?? 0);
  // Until a client is connected nothing can start a turn, so the agent is silent: connecting one comes first.
  const needsClient = own && ownOffered && connectedCount === 0;

  return (
    <section aria-labelledby="agent-runner-title" className="rounded-md border border-hairline p-4" data-testid="agent-runner-card" data-runner={config.runner} data-form={own ? (ownOffered ? 'own' : 'own-off') : 'hosted'}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 id="agent-runner-title" className="text-caption font-medium text-ink">
            Agent
          </h3>
          <Badge tone={own ? 'ink' : 'default'}>{RUNNER_LABEL[config.runner]}</Badge>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => setDialog(own ? 'hosted' : 'own')} disabled={!session.canSign} data-testid="runner-switch">
          {own ? 'Switch to the Bootr agent' : 'Switch to my own agent'}
        </Button>
      </div>

      {own ? (
        <p className="mt-2 text-sm text-body" data-testid="runner-line">
          {ownOffered
            ? `This agent thinks in your own AI client. Your machine on, it works; off, it is silent. ${!presence || presence.text === 'no turn yet' ? 'It has not finished a turn yet.' : presence.active ? `It was ${presence.text}.` : `It has been ${presence.text}.`}`
            : 'Own agents are switched off here for now. This coin’s agent is silent.'}
        </p>
      ) : (
        <p className="mt-2 text-sm text-body" data-testid="runner-line">
          Bootr runs this agent around the clock and pays for its thinking from fuel. You can run it in your own AI client instead: no fuel needed to think, and it works while your machine is on.
        </p>
      )}

      {notes.length > 0 ? (
        <ul role="status" className="mt-3 flex flex-col gap-1 rounded-xs bg-canvas-soft px-3 py-2 text-caption text-body" data-testid="runner-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {needsClient ? (
        <div className="mt-4 rounded-sm border border-warning bg-canvas-soft p-4" data-testid="runner-needs-client">
          <p className="text-sm font-medium text-ink">No AI client is connected yet, so this agent is silent.</p>
          <p className="mt-1 text-caption text-body">Connect the client you want it to think in. It takes a minute, and nothing else works until it is done.</p>
          <div className="mt-4">
            <ClientSetupSteps client={client} onClient={setClient} approveWith={`the wallet that launched $${token.symbol}, and pick $${token.symbol}`} />
          </div>
        </div>
      ) : null}

      {own ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-hairline pt-4">
          <div data-testid="runner-clients">
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <h4 className="text-caption font-medium text-ink">Connected clients</h4>
              <span className="font-mono text-micro text-mute tabular">
                {connectedCount}
                {clients ? `/${clients.max}` : ''}
              </span>
            </div>
            {clients ? (
              clients.clients.length > 0 ? (
                <ul className="divide-y divide-hairline rounded-sm border border-hairline">
                  {clients.clients.map((c) => (
                    <li key={c.clientId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2" data-testid="runner-client" data-client-id={c.clientId}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink">{c.label}</span>
                        <span className="block text-micro text-mute">
                          connected {ago(unix(c.createdAt))} · {c.lastUsedAt ? `last used ${ago(unix(c.lastUsedAt))}` : 'not used yet'}
                        </span>
                      </span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => void disconnect({ clientId: c.clientId })} loading={busyClient === c.clientId} loadingLabel="Disconnecting…" disabled={busyClient !== null}>
                        Disconnect
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-caption text-mute" data-testid="runner-no-clients">
                  No client is connected, so the agent is silent.{ownOffered ? ' Connect one with the steps above.' : ''}
                </p>
              )
            ) : clientsUnavailable ? (
              <p className="text-caption text-mute" data-testid="runner-clients-unavailable">
                The client list is unavailable right now.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="secondary" size="sm" onClick={async () => openClients(await session.auth())} loading={opening || clientsQuery.isFetching} loadingLabel="Opening…" disabled={!session.canSign} data-testid="runner-show-clients">
                  Show connected clients
                </Button>
                <span className="text-micro text-mute">One wallet signature opens the console.</span>
              </div>
            )}
            {/* An approval the creator signed is as good as a client until it is collected or runs out: shown, and cancellable. */}
            {waiting.length > 0 ? (
              <div className="mt-3" data-testid="runner-waiting">
                <h4 className="mb-1.5 text-caption font-medium text-ink">Approved, waiting for the client to collect</h4>
                <ul className="divide-y divide-hairline rounded-sm border border-hairline">
                  {waiting.map((w) => (
                    <li key={w.userCode} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2" data-testid="runner-waiting-approval" data-user-code={w.userCode}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-ink">{w.label}</span>
                        <span className="block text-micro text-mute">
                          code <span className="font-mono">{w.userCode}</span> · approved {ago(unix(w.approvedAt))} · runs out {minutesLeft(w.expiresAt, now)}
                        </span>
                      </span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => void disconnect({ userCode: w.userCode })} loading={busyClient === w.userCode} loadingLabel="Cancelling…" disabled={busyClient !== null}>
                        Cancel
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-micro text-mute">If you did not approve this for your own client just now, cancel it.</p>
              </div>
            ) : null}
            {clients && clients.clients.length + waiting.length > 1 ? (
              <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => void disconnect({ all: true })} loading={busyClient === 'all'} loadingLabel="Disconnecting…" disabled={busyClient !== null} data-testid="runner-disconnect-all">
                Disconnect all
              </Button>
            ) : null}
          </div>

          {ownOffered ? (
            <>
              {needsClient ? null : (
                <details className="group" data-testid="runner-connect">
                  <summary className="cursor-pointer text-caption font-medium text-ink underline-offset-4 hover:underline">Connect another client</summary>
                  <div className="mt-4">
                    <ClientSetupSteps client={client} onClient={setClient} approveWith={`the wallet that launched $${token.symbol}, and pick $${token.symbol}`} />
                  </div>
                </details>
              )}
              <details className="group" data-testid="runner-keep-running">
                <summary className="cursor-pointer text-caption font-medium text-ink underline-offset-4 hover:underline">Keep it running</summary>
                <KeepRunning symbol={token.symbol} client={client} onClient={setClient} className="mt-3" bare />
              </details>
            </>
          ) : null}
        </div>
      ) : null}

      {/* To an own agent: what changes, in plain words, before one click. */}
      <Dialog
        open={dialog === 'own'}
        onOpenChange={(open) => (open ? null : setDialog(null))}
        title="Run this agent in your own AI client?"
        description={`$${token.symbol} keeps its treasury, its X account, its memory and its rules. Only who thinks changes.`}
        actions={
          <>
            <DialogClose>Cancel</DialogClose>
            <Button type="button" variant="ink" onClick={() => void switchTo('own')} loading={switching} loadingLabel="Switching…" data-testid="runner-confirm-own">
              Switch to my own agent
            </Button>
          </>
        }
      >
        <ul className="flex flex-col gap-2" data-testid="runner-dialog-own">
          <li>Your AI client does the thinking. Nothing is bought for it, and the fuel this coin holds stays where it is and pays for paid services only.</li>
          <li>Your machine on, the agent works; off, it is silent. Bootr never takes over.</li>
          <li>Pictures are made by your client and uploaded. Bootr makes none.</li>
          <li>The chat here is hidden: you talk to the agent in your client. Its history is kept, and requests you already gave it are not lost.</li>
          <li>Nothing changes on chain, and you can switch back at any time.</li>
        </ul>
      </Dialog>

      {/* To the Bootr agent: the model it thinks with, and what its thinking costs. */}
      <Dialog
        open={dialog === 'hosted'}
        onOpenChange={(open) => (open ? null : setDialog(null))}
        title="Hand this agent to Bootr?"
        description={`Bootr runs $${token.symbol}’s agent around the clock again. Its memory, posts and rules carry over.`}
        actions={
          <>
            <DialogClose>Cancel</DialogClose>
            <Button type="button" variant="ink" onClick={() => void switchTo('hosted')} loading={switching} loadingLabel="Switching…" disabled={!model} data-testid="runner-confirm-hosted">
              Switch to the Bootr agent
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3" data-testid="runner-dialog-hosted">
          <p data-testid="runner-fuel-line">
            The Bootr agent pays for its thinking from fuel. {fuel !== null ? `This coin holds ${usdcText(fuel)} USDC; under 1 USDC it stays silent.` : 'Under 1 USDC of fuel it stays silent.'} No amount is required to switch.
          </p>
          {/* The Fuel form beside the figure: add some now, or later from the Fuel section. */}
          <FuelForm kernel={token.kernel as Address} symbol={token.symbol} disabled={agent?.status === 'claimed'} />
          <div>
            <Label htmlFor="runner-model" hint={storedOffered ? 'The one it used before' : 'Choose one'}>
              Model it thinks with
            </Label>
            <Select id="runner-model" value={model} onChange={(e) => setPickedModel(e.target.value)}>
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
            {!storedOffered && config.model ? <p className="mt-1 text-micro text-mute">{modelLabel(config.model)} is not offered any more.</p> : null}
          </div>
          <ul className="flex flex-col gap-2">
            <li>Pictures are made by Bootr again and paid from fuel. Uploads from your client are refused.</li>
            <li>The chat here is back, with its history.</li>
            <li>Your connected clients stay listed but cannot act until you switch back.</li>
          </ul>
        </div>
      </Dialog>
    </section>
  );
}
