'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CLIENT_LABEL_MAX, type DraftClientsResponse } from '@bootr/shared/own-agent';
import { aiClient, ASK_TO_CONNECT, PICTURES_NOTE, type AiClientId } from '@/lib/keep-running';
import { CheckIcon } from '@/components/ui/Icons';
import { cn } from '@/components/ui/cn';
import { ClientTabs, CopyBlockView, KeepRunning } from './KeepRunning';

/** Where the approval page (`/connect/<code>`) looks for "my next launch": this browser's open launch draft. */
export const LAUNCH_DRAFT_STORAGE_KEY = 'bootr.launchDraft';

const NOT_CONNECTED: DraftClientsResponse = { connected: false, clients: [] };
const WAITING_POLL_MS = 3_000;
const CONNECTED_POLL_MS = 20_000;

/** Tells the approval page which launch draft this browser has open, so "my next launch" can be approved there. */
export function rememberLaunchDraft(draftId: string): void {
  try {
    window.localStorage.setItem(LAUNCH_DRAFT_STORAGE_KEY, JSON.stringify({ draftId, at: Date.now() }));
  } catch {
    // private window or blocked storage: the approval page then offers the creator's coins only
  }
}

/** The draft launched or was dropped: nothing is left to approve a client for. */
export function forgetLaunchDraft(): void {
  try {
    window.localStorage.removeItem(LAUNCH_DRAFT_STORAGE_KEY);
  } catch {
    // nothing to forget
  }
}

/**
 * The AI clients approved for a launch draft (`GET /api/agent/connect/draft`). Anything but a readable answer counts
 * as "none yet": the step keeps waiting and the launch is never blocked by this read.
 */
export async function fetchDraftClients(draftId: string): Promise<DraftClientsResponse> {
  try {
    const res = await fetch(`/api/agent/connect/draft?draft=${encodeURIComponent(draftId)}`, { cache: 'no-store' });
    if (!res.ok) return NOT_CONNECTED;
    const json = (await res.json()) as Partial<DraftClientsResponse>;
    const clients = (Array.isArray(json.clients) ? json.clients : [])
      .filter((c): c is DraftClientsResponse['clients'][number] => !!c && typeof c.clientId === 'string' && typeof c.label === 'string')
      .map((c) => ({ clientId: c.clientId, label: c.label.slice(0, CLIENT_LABEL_MAX), createdAt: typeof c.createdAt === 'string' ? c.createdAt : '' }));
    return { connected: json.connected === true && clients.length > 0, clients };
  } catch {
    return NOT_CONNECTED;
  }
}

/** The clients connected to this launch draft, polled while the step is open. */
export function useDraftClients(draftId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['own-agent', 'draft-clients', draftId],
    queryFn: () => fetchDraftClients(draftId!),
    enabled: enabled && !!draftId,
    refetchInterval: (query) => (query.state.data?.connected ? CONNECTED_POLL_MS : WAITING_POLL_MS),
    staleTime: 0,
  });
}

/**
 * The three things a creator does to connect a client, for the client they picked: add Bootr to it, ask it to
 * connect, approve the link with their wallet. The same block serves the launch page (a client for the launch draft)
 * and the console (a client for a live coin): the link the client shows leads to the page that offers both.
 */
export function ClientSetupSteps({ client, onClient, approveWith }: { client: AiClientId; onClient: (id: AiClientId) => void; approveWith: string }) {
  const setup = aiClient(client);
  return (
    <div className="flex flex-col gap-4" data-testid="client-setup" data-client={client}>
      <ClientTabs value={client} onChange={onClient} label="Your AI client" />
      <ol className="flex flex-col gap-4">
        <li className="flex gap-3">
          <StepMark n={1} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">Add Bootr to {setup.label}</p>
            <p className="mt-0.5 text-caption text-mute">{setup.intro} It runs on your machine and needs Node 20 or later, no API key.</p>
            <CopyBlockView block={setup.install} className="mt-2" data-testid="client-install" />
            {setup.note ? <p className="mt-1.5 text-caption text-mute">{setup.note}</p> : null}
          </div>
        </li>
        <li className="flex gap-3">
          <StepMark n={2} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">Ask it to connect</p>
            <p className="mt-0.5 text-caption text-mute">Say this to it. It answers with a link and a short code.</p>
            <CopyBlockView block={{ label: 'Sentence for your AI client', text: ASK_TO_CONNECT }} className="mt-2" />
          </div>
        </li>
        <li className="flex gap-3">
          <StepMark n={3} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">Open the link and approve</p>
            <p className="mt-0.5 text-caption text-mute">
              Open it in this browser and approve with {approveWith}. Approve only if the code on that page is the one on your own screen. Signing it moves no funds.
            </p>
          </div>
        </li>
      </ol>
    </div>
  );
}

function StepMark({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full border border-hairline-strong font-mono text-micro text-body">
      {n}
    </span>
  );
}

/**
 * Step 2 of an own-agent launch (docs/design/byo-agent.md section 5.1): connect the creator's AI client to this
 * launch before the coin exists, the way the X account is connected to a draft. The link the client shows signs with
 * the wallet and binds the client to this browser's launch draft; this step polls until the client appears, shows its
 * name, then hands over the way to keep it running. "Connect later" is allowed: a coin that launches silent harms
 * nobody, and a stuck step must not block a launch.
 */
export function ConnectClientStep({
  draftId,
  symbol,
  later,
  onLater,
  onClients,
}: {
  draftId: string | null;
  symbol: string;
  /** The creator chose to connect from the console after the launch. */
  later: boolean;
  onLater: (later: boolean) => void;
  /** The names of the connected clients, every time the poll answers. */
  onClients: (labels: string[]) => void;
}) {
  const [client, setClient] = useState<AiClientId>('claude-code');
  const clients = useDraftClients(draftId);
  const labels = clients.data?.connected ? clients.data.clients.map((c) => c.label) : [];
  const connected = labels.length > 0;
  const key = labels.join('\n');

  // The approval page offers "my next launch" for the draft this browser has open; a new draft id replaces it.
  useEffect(() => {
    if (draftId) rememberLaunchDraft(draftId);
  }, [draftId]);

  useEffect(() => {
    onClients(key ? key.split('\n') : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the parent's setter; only the names matter
  }, [key]);

  const setupSteps = <ClientSetupSteps client={client} onClient={setClient} approveWith="the wallet you launch with, and pick “my next launch”" />;

  return (
    <div className="flex flex-col gap-5" data-testid="connect-client" data-connected={connected ? 'true' : 'false'}>
      {connected ? (
        <>
          <div role="status" className="flex items-start gap-3 rounded-sm border border-hairline bg-canvas-soft p-4" data-testid="client-connected">
            <span aria-hidden="true" className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink">
              <CheckIcon size={12} />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">
                {labels.length === 1 ? `${labels[0]} is connected` : `${labels.length} clients are connected: ${labels.join(', ')}`}
              </p>
              <p className="mt-0.5 text-caption text-mute">It runs this coin’s agent once you launch. You can disconnect it from the creator console at any time.</p>
            </div>
          </div>
          <KeepRunning symbol={symbol} client={client} onClient={setClient} />
          <details className="group">
            <summary className="cursor-pointer text-caption text-link underline-offset-4 hover:underline">Connect another client</summary>
            <div className="mt-4">{setupSteps}</div>
          </details>
        </>
      ) : (
        <>
          {setupSteps}
          <div className={cn('flex items-center gap-2.5 rounded-sm border border-hairline px-4 py-3', later && 'opacity-60')} role="status" data-testid="client-waiting">
            <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-mute motion-reduce:animate-none" />
            <span className="text-sm text-body">Waiting for your AI client. This page notices on its own when it is connected.</span>
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5" checked={later} onChange={(e) => onLater(e.target.checked)} data-testid="connect-later" />
            <span>
              Connect later from the creator console. <span className="text-mute">The agent stays silent until a client is connected.</span>
            </span>
          </label>
          <details className="group">
            <summary className="cursor-pointer text-caption text-link underline-offset-4 hover:underline">How does it keep running?</summary>
            <KeepRunning symbol={symbol} client={client} className="mt-4" bare />
          </details>
        </>
      )}
      <p className="text-caption text-mute">{PICTURES_NOTE}</p>
    </div>
  );
}
