'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SiweMessage } from 'siwe';
import { useConnection, useSignMessage } from 'wagmi';
import { CLIENT_LABEL_MAX, connectCoinStatement, connectDraftStatement, OWN_ERRORS, USER_CODE_RE, type ConnectApproveResponse, type ConnectGrantView, type OwnErrorCode } from '@bootr/shared/own-agent';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { Button, LinkButton } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Field';
import { Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { shortAddr } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { approveConnection, cleanLabel, fetchConnectCoins, fetchGrant, fetchOwnAgentEnabled, normalizeUserCode, orderCoins, readLaunchDraft } from '@/lib/own-agent';

/**
 * `/connect/<code>`: where a coin's creator lets an AI client run the coin's agent (docs/design/byo-agent.md section
 * 3.2). The client showed a link and a code; this page shows the same code, the client's name and the exact sentence
 * the wallet signs, and sends the signature. No key is typed, pasted or shown here, and the page never sees the
 * client's credential.
 *
 * The weak point of every flow like this is a link someone else sent: their code, their client. So the code is the
 * largest thing on the page, the warning sits next to it, and the signed sentence names the coin and the code.
 */

const DRAFT_CHOICE = 'draft';

export function ConnectSkeleton() {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5" data-testid="connect-page">
      <header className="flex flex-col gap-1">
        <h1 className="text-display-md font-semibold text-ink">Connect an AI client</h1>
        <p className="text-sm text-mute">Let an AI client on your own machine run your coin’s agent.</p>
      </header>
      {children}
    </div>
  );
}

/** A code typed by hand: for a link that lost its code, or a code that was mistyped. */
function CodeEntry({ note }: { note: string }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [bad, setBad] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeUserCode(value);
    if (!code) return setBad(true);
    router.push(`/connect/${code}`);
  };
  return (
    <Panel title="Enter the code">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-body" data-testid="connect-state">
          {note}
        </p>
        <div>
          <Label htmlFor="connect-code" hint="8 letters">
            The code your AI client shows
          </Label>
          <Input
            id="connect-code"
            mono
            inputSize="lg"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="BCDF-GHJK"
            maxLength={12}
            value={value}
            aria-invalid={bad || undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setBad(false);
            }}
          />
          {bad ? (
            <p className="mt-1 text-caption text-danger" role="alert">
              That is not a code. It is two groups of four letters, like BCDF-GHJK.
            </p>
          ) : null}
        </div>
        <div>
          <Button type="submit" variant="ink" size="lg">
            Continue
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function Notice({ title, children, testid = 'connect-state' }: { title: string; children: React.ReactNode; testid?: string }) {
  return (
    <Panel title={title}>
      <div className="flex flex-col gap-3 text-sm text-body" data-testid={testid}>
        {children}
      </div>
    </Panel>
  );
}

/** The code, large, with the one warning that matters next to it. */
function CodeCard({ grant, now }: { grant: ConnectGrantView; now: number }) {
  const left = Math.max(0, Math.ceil((Date.parse(grant.expiresAt) - now) / 60_000));
  return (
    <section className="rounded-md border border-edge bg-canvas p-5" aria-labelledby="connect-code-title">
      <h2 id="connect-code-title" className="text-caption text-mute">
        Code
      </h2>
      <p className="mt-1 break-all font-mono text-display-lg font-semibold tracking-widest text-ink" data-testid="connect-code">
        {grant.userCode}
      </p>
      <p className="mt-3 rounded-xs border border-warning-surface bg-warning-surface px-3 py-2 text-sm text-warning" data-testid="connect-warning" role="note">
        <strong className="font-semibold">Approve only if this code is on your own screen</strong>, in an AI client you started yourself. If someone sent you this link, or the codes differ,
        close this page: approving would hand your coin’s agent to their client.
      </p>
      <dl className="mt-3 flex flex-col gap-1 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <dt className="text-caption text-mute">The client calls itself</dt>
          <dd className="break-all text-ink" data-testid="connect-client">
            {grant.clientName}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <dt className="text-caption text-mute">This code runs out in</dt>
          <dd className="font-mono tabular text-ink">{left <= 1 ? 'under a minute' : `${left} min`}</dd>
        </div>
      </dl>
    </section>
  );
}

function Scope() {
  return (
    <details className="rounded-md border border-hairline bg-canvas-soft px-4 py-3 text-sm text-body">
      <summary className="cursor-pointer select-none font-medium text-ink">What the client can and cannot do</summary>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <p className="font-medium text-ink">It can</p>
          <ul className="mt-1 list-disc pl-5">
            <li>post and reply on X as the agent, inside the agent’s daily limits and your review setting;</li>
            <li>read mentions, pages and the market for the agent, and keep its notes;</li>
            <li>spend the agent’s fuel on paid services, inside the caps you set;</li>
            <li>run the treasury steps the agent is allowed, which keep the money in the agent’s own accounts.</li>
          </ul>
        </div>
        <div>
          <p className="font-medium text-ink">It cannot</p>
          <ul className="mt-1 list-disc pl-5">
            <li>send the agent’s money to any other address;</li>
            <li>change the agent’s instructions, powers or limits;</li>
            <li>approve a post or a payout for you, or act for another coin.</li>
          </ul>
        </div>
        <p>You can disconnect a client at any time in the creator console.</p>
      </div>
    </details>
  );
}

type Choice = { value: string; title: string; detail: string; statement: string };

function Approve({ grant, onDone }: { grant: ConnectGrantView; onDone: (r: ConnectApproveResponse) => void }) {
  const { address } = useConnection();
  const { signMessageAsync } = useSignMessage();
  const coins = useQuery({ queryKey: ['connect-coins', address?.toLowerCase()], queryFn: () => fetchConnectCoins(address!), enabled: !!address, staleTime: 30_000 });
  // Read once the wallet is there, on the client only: the draft lives in this browser's storage.
  const draftId = useMemo(() => (address ? readLaunchDraft() : null), [address]);
  const [picked, setPicked] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!address) {
    return (
      <Panel title="1. Connect the wallet that launched the coin">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-body">Only that wallet can connect a client to the coin’s agent. Connecting shows this page your address and nothing else.</p>
          <div>
            <ConnectButton />
          </div>
        </div>
      </Panel>
    );
  }
  if (coins.isPending) return <Skeleton className="h-48 w-full" />;
  if (!coins.data?.ok) {
    return (
      <Notice title="Could not read your coins">
        <p>{coins.data ? coins.data.error.message : OWN_ERRORS.supervisor_unavailable.message}</p>
        <div>
          <Button onClick={() => void coins.refetch()}>Try again</Button>
        </div>
      </Notice>
    );
  }

  // The client asked for one coin and the request is for that coin alone: it is shown fixed, with no other coin and no
  // launch draft to pick instead, and the server refuses an approval for anything else.
  const bound = grant.coin ?? null;
  const mine = bound ? coins.data.data.coins.filter((c) => c.kernel.toLowerCase() === bound.kernel.toLowerCase() && c.agentId === bound.agentId) : orderCoins(coins.data.data.coins, grant.coinHint);
  const choices: Choice[] = [
    ...mine.map((c) => ({
      value: c.kernel.toLowerCase(),
      title: `$${c.symbol}`,
      detail: `${c.name} · agent #${c.agentId}`,
      statement: connectCoinStatement(c.symbol, c.agentId, c.kernel, grant.userCode),
    })),
    ...(draftId && !bound ? [{ value: DRAFT_CHOICE, title: 'My next launch', detail: 'The coin you are setting up on the launch page in this browser', statement: connectDraftStatement(draftId, grant.userCode) }] : []),
  ];
  const chosen = choices.find((c) => c.value === picked) ?? (choices.length === 1 ? choices[0]! : null);

  if (bound && choices.length === 0) {
    return (
      <Notice title="This request is for another wallet’s coin" testid="connect-bound-other">
        <p>
          The AI client asked to run the agent of <span className="font-mono text-ink">${bound.symbol}</span> ({bound.name}), treasury address{' '}
          <span className="break-all font-mono text-ink">{bound.kernel}</span>. The wallet <span className="font-mono">{shortAddr(address, 6, 4)}</span> did not launch that coin, so
          it cannot approve this request, and the request cannot be approved for any other coin.
        </p>
        <p>Connect the wallet that launched ${bound.symbol}. To connect another coin, ask your AI client to connect again and name that coin.</p>
        <div>
          <ConnectButton />
        </div>
      </Notice>
    );
  }
  if (choices.length === 0) {
    return (
      <Notice title="No coin to connect" testid="connect-no-coins">
        <p>
          The wallet <span className="font-mono">{shortAddr(address, 6, 4)}</span> has launched no Bootr coin, so there is no agent it can connect a client to. Connect the wallet
          that launched the coin, or start a launch first.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <ConnectButton />
          <Link href="/launch" className="text-link hover:underline">
            Go to launch
          </Link>
        </div>
      </Notice>
    );
  }

  const approve = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      let nonce = crypto.randomUUID().replace(/-/g, '');
      if (!env.useMock) {
        const n = await fetch('/api/agent/nonce', { method: 'POST' });
        if (!n.ok) return setProblem('Could not start the signature. Try again in a moment.');
        nonce = ((await n.json()) as { nonce: string }).nonce;
      }
      const message = new SiweMessage({ domain: window.location.host, address, statement: chosen.statement, uri: window.location.origin, version: '1', chainId: appChain.id, nonce, issuedAt: new Date().toISOString() }).prepareMessage();
      let signature = '0x';
      // In mock mode nothing is signed: the route reads the message for what it says.
      if (!env.useMock) {
        try {
          signature = await signMessageAsync({ message });
        } catch {
          return setProblem('The signature was cancelled. Nothing was connected.');
        }
      }
      const result = await approveConnection({ userCode: grant.userCode, message, signature, label: cleanLabel(label) });
      if (result.ok) return onDone(result.data);
      setProblem(APPROVE_PROBLEMS[result.error.error] ?? result.error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={bound ? '2. Check the coin and approve' : '2. Choose the coin and approve'}>
      <div className="flex flex-col gap-4">
        {bound && chosen ? (
          <div data-testid="connect-bound-coin">
            <p className="mb-1 text-caption text-mute">The client asked to run the agent of this coin, and of no other</p>
            <div className="rounded-sm border border-ink bg-canvas-sub px-3 py-2">
              <span className="block font-mono text-sm font-medium text-ink">{chosen.title}</span>
              <span className="block break-words text-caption text-mute">{chosen.detail}</span>
              <span className="block break-all font-mono text-caption text-mute">treasury address {bound.kernel}</span>
            </div>
            <p className="mt-1 text-micro text-mute">To connect another coin, ask your AI client to connect again and name that coin.</p>
          </div>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-caption text-mute">The client will run the agent of</legend>
            {choices.map((c) => {
              const on = chosen?.value === c.value;
              return (
                <label key={c.value} className={cn('flex cursor-pointer items-start gap-3 rounded-sm border px-3 py-2 transition-colors', on ? 'border-ink bg-canvas-sub' : 'border-hairline hover:border-hairline-strong')}>
                  <input type="radio" name="connect-target" className="mt-1 accent-current" checked={on} onChange={() => setPicked(c.value)} data-testid={`connect-choice-${c.value === DRAFT_CHOICE ? 'draft' : c.title.slice(1)}`} />
                  <span className="min-w-0">
                    <span className="block font-mono text-sm font-medium text-ink">{c.title}</span>
                    <span className="block break-words text-caption text-mute">{c.detail}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        <div>
          <Label htmlFor="connect-label" hint="optional">
            Your name for this client
          </Label>
          <Input id="connect-label" maxLength={CLIENT_LABEL_MAX} placeholder={grant.clientName} value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" aria-describedby="connect-label-note" />
          {/* An empty field sends no name, so the one the client gave (its --label, or what it calls itself) is kept. */}
          <p id="connect-label-note" className="mt-1 text-micro text-mute" data-testid="connect-label-note">
            Leave this empty to keep the name the client gave: <span className="break-all text-body">{grant.clientName}</span>.
          </p>
        </div>
        {chosen ? (
          <div>
            <p className="text-caption text-mute">Your wallet will sign this sentence. Signing moves no funds.</p>
            <p className="mt-1 break-words rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-caption text-ink" data-testid="connect-statement">
              {chosen.statement}
            </p>
          </div>
        ) : (
          <p className="text-caption text-mute">Choose a coin to see the sentence your wallet will sign.</p>
        )}
        {problem ? (
          <p className="text-sm text-danger" role="alert" data-testid="connect-problem">
            {problem}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ink" size="lg" disabled={!chosen} loading={busy} loadingLabel="Waiting for your wallet…" onClick={() => void approve()} data-testid="connect-approve">
            Approve with wallet
          </Button>
          <span className="font-mono text-caption text-mute">{shortAddr(address, 6, 4)}</span>
        </div>
      </div>
    </Panel>
  );
}

/** Words for the refusals a creator can do something about; the rest read as the server's own fixed sentence. */
const APPROVE_PROBLEMS: Partial<Record<OwnErrorCode, string>> = {
  siwe_rejected: 'The wallet signature was not accepted. Approve again, and sign with the wallet shown here.',
  not_creator: 'This wallet did not launch that coin. Only the wallet that launched the coin can connect a client to its agent.',
  too_many_clients: 'This coin already has as many clients as it may have. Disconnect one in the creator console, then ask your AI client to connect again.',
  wrong_coin: 'This request is for another coin than the one you approved for. Nothing was connected. Reload this page: it shows the coin the request is for.',
  grant_expired: 'This request ran out while you were here. Ask your AI client to connect again: it will show a new code.',
  grant_used: 'This request was already approved. Ask your AI client to connect again if it is still waiting.',
  own_agent_disabled: 'Connecting AI clients is switched off on this site right now. Nothing was connected.',
  rate_limited: 'Too many tries from here. Wait a minute, then approve again.',
};

function Done({ result }: { result: ConnectApproveResponse }) {
  const coin = result.target.kind === 'coin' ? result.target.coin : null;
  return (
    <Notice title="Connected" testid="connect-done">
      <p>
        <span className="font-medium text-ink">{result.label}</span> {coin ? `can now run the agent of $${coin.symbol}.` : 'will run the agent of your next launch, once the coin is launched from this wallet.'}
      </p>
      <p>Go back to your AI client. It picks this up within a few seconds; nothing needs to be copied.</p>
      <p className="text-caption text-mute">Machine on, the agent works; off, it is silent. You can disconnect this client at any time in the creator console.</p>
      <div className="flex flex-wrap gap-3">{coin ? <LinkButton href={`/token/${coin.token}/console`}>Open the creator console</LinkButton> : <LinkButton href="/launch">Back to launch</LinkButton>}</div>
    </Notice>
  );
}

export function ConnectApproval({ code }: { code: string }) {
  const valid = USER_CODE_RE.test(code);
  const now = useNow();
  const [done, setDone] = useState<ConnectApproveResponse | null>(null);
  const enabled = useQuery({ queryKey: ['own-agent-enabled'], queryFn: fetchOwnAgentEnabled, staleTime: 60_000 });
  const grant = useQuery({
    queryKey: ['connect-grant', code],
    queryFn: () => fetchGrant(code),
    enabled: valid && enabled.data === true && !done,
    // While it waits, look again now and then: it can run out, or be approved in another tab.
    refetchInterval: (q) => (q.state.data?.ok && q.state.data.data.status === 'pending' ? 15_000 : false),
  });

  if (enabled.isPending) return <ConnectSkeleton />;
  if (!enabled.data) {
    return (
      <Shell>
        <Notice title="Switched off here" testid="connect-disabled">
          <p>Running a coin’s agent in your own AI client is switched off on this site for now. Nothing was connected.</p>
          <div>
            <LinkButton href="/">Back to Bootr</LinkButton>
          </div>
        </Notice>
      </Shell>
    );
  }
  if (done) {
    return (
      <Shell>
        <Done result={done} />
      </Shell>
    );
  }
  if (!valid) {
    return (
      <Shell>
        <CodeEntry note="This link carries no valid code. Type the code your AI client shows." />
      </Shell>
    );
  }
  if (grant.isPending) return <ConnectSkeleton />;
  if (!grant.data?.ok) {
    const missing = grant.data?.error.error === 'grant_not_found';
    return (
      <Shell>
        {missing ? (
          <CodeEntry note="No connection request has that code. Check it against your AI client, or ask the client to connect again." />
        ) : (
          <Notice title="Could not read the request">
            <p>{grant.data ? grant.data.error.message : OWN_ERRORS.supervisor_unavailable.message}</p>
            <div>
              <Button onClick={() => void grant.refetch()}>Try again</Button>
            </div>
          </Notice>
        )}
      </Shell>
    );
  }

  const view = grant.data.data;
  const expired = view.status === 'expired' || (view.status === 'pending' && Date.parse(view.expiresAt) <= now);
  if (expired) {
    return (
      <Shell>
        <Notice title="This request ran out">
          <p>
            A connection request lasts 10 minutes, and the one with code <span className="font-mono text-ink">{view.userCode}</span> is over. Ask your AI client to connect again: it
            will show a new link and a new code.
          </p>
        </Notice>
      </Shell>
    );
  }
  if (view.status !== 'pending') {
    return (
      <Shell>
        <Notice title="Already approved">
          <p>
            The request with code <span className="font-mono text-ink">{view.userCode}</span> was approved already. If that was you, go back to your AI client. If it was not, open
            your coin’s creator console and disconnect the client.
          </p>
        </Notice>
      </Shell>
    );
  }

  return (
    <Shell>
      <CodeCard grant={view} now={now} />
      <Approve grant={view} onDone={setDone} />
      <Scope />
    </Shell>
  );
}
