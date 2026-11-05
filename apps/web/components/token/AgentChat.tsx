'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { fetchAgentChat, ReviewError, sendAgentChat } from '@/lib/indexer';
import { formatMicroUsdc } from '@/lib/models';
import type { AgentChat as AgentChatView, AgentChatMessage, Token } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { cn } from '@/components/ui/cn';
import { useConsoleSession } from './console-session';

const PENDING_POLL_MS = 5_000;

/** "About $0.02 per message, from the agent's fuel." or, while nothing can say, the ceiling. */
export function costLine(quote: AgentChatView['quote']): string {
  const cost = quote.approxMicroUsdc;
  if (cost === null) return `Each message is paid from the agent’s fuel, ${formatMicroUsdc(quote.maxMicroUsdc)} at most.`;
  return `About ${formatMicroUsdc(cost)} per message, from the agent’s fuel.`;
}

function Bubble({ message }: { message: AgentChatMessage }) {
  const mine = message.role === 'creator';
  if (!mine && message.status === 'open')
    return (
      <li className="text-caption text-mute" data-testid="chat-thinking">
        Thinking…
      </li>
    );
  if (!mine && message.status === 'failed')
    return (
      <li className="text-caption text-mute" data-testid="chat-failed">
        No answer this time.
      </li>
    );
  return (
    <li data-testid={`chat-message-${message.role}`} className={cn('flex flex-col gap-1', mine ? 'items-end' : 'items-start')}>
      <p className={cn('max-w-[85%] whitespace-pre-line break-words rounded-sm px-3 py-2 text-sm', mine ? 'bg-canvas-soft text-ink' : 'border border-hairline text-ink')}>{message.text}</p>
      {!mine && (message.remembered || message.chargedMicroUsdc) ? (
        <span className="font-mono text-micro text-mute tabular">
          {message.remembered ? 'Saved to its memory' : ''}
          {message.remembered && message.chargedMicroUsdc ? ' · ' : ''}
          {message.chargedMicroUsdc ? formatMicroUsdc(message.chargedMicroUsdc) : ''}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The creator's private chat with their own agent, inside the console. Nothing here is published and the agent can only
 * talk or take a note: that limit is in the supervisor's code, not in this panel. The console's one signature opens it.
 * It shows the cost before anything is sent and says why when chat is off.
 */
export function AgentChat({ token }: { token: Token }) {
  const session = useConsoleSession(token);
  const [view, setView] = useState<AgentChatView | null>(null);
  const [draft, setDraft] = useState('');
  const [opening, setOpening] = useState(false);
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLUListElement>(null);

  const handleError = (err: unknown, fallback: string) => {
    if (err instanceof ReviewError && err.status === 401) {
      session.forget();
      setView(null);
      toast.error('The console session expired. Open the chat again.');
    } else {
      toast.error(err instanceof Error ? err.message : fallback);
    }
  };

  const open = async () => {
    setOpening(true);
    try {
      const auth = await session.auth();
      if (!auth) return;
      const next = await fetchAgentChat(token.kernel, auth);
      session.keep(next.token);
      setView(next);
    } catch (err) {
      handleError(err, 'Could not open the chat.');
    } finally {
      setOpening(false);
    }
  };

  const reload = async () => {
    const held = session.held();
    if (!held) return;
    const next = await fetchAgentChat(token.kernel, { token: held }).catch(() => null);
    if (next) setView(next);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !view) return;
    setSending(true);
    const now = new Date().toISOString();
    setView({ ...view, messages: [...view.messages, { id: `draft-${now}`, role: 'creator', text, status: 'done', chargedMicroUsdc: null, remembered: false, at: now }, { id: `open-${now}`, role: 'agent', text: '', status: 'open', chargedMicroUsdc: null, remembered: false, at: now }] });
    setDraft('');
    try {
      const auth = await session.auth();
      if (!auth) {
        setDraft(text);
        await reload();
        return;
      }
      const res = await sendAgentChat(token.kernel, auth, text);
      session.keep(res.token);
    } catch (err) {
      // A refusal stored nothing, so the text comes back to the box. A failed answer, or a service that went quiet mid-answer, already has the message on record.
      if (!(err instanceof ReviewError && (err.status === 503 || err.code === 'chat_failed'))) setDraft(text);
      handleError(err, 'Could not send that.');
    } finally {
      setSending(false);
      await reload();
    }
  };

  const open_ = view?.messages.some((m) => m.status === 'open') ?? false;
  useEffect(() => {
    if (!open_ || sending) return;
    const timer = setInterval(() => void reload(), PENDING_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reload` only reads the session; the open answer decides
  }, [open_, sending, token.kernel]);

  const count = view?.messages.length ?? 0;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [count]);

  const quote = view?.quote;
  const left = quote ? Math.max(0, Math.min(quote.limits.perHour - quote.limits.usedHour, quote.limits.perDay - quote.limits.usedDay)) : 0;
  const disabled = sending || !!quote?.refusal;

  return (
    <div data-testid="agent-chat" className="border-t border-hairline pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-caption font-medium text-ink">Chat with your agent</h3>
        {!view ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => void open()} loading={opening} loadingLabel="Opening…" disabled={!session.canSign}>
            Open chat
          </Button>
        ) : null}
      </div>
      {!view ? (
        <p className="mt-1 text-micro text-mute">Ask it what it has been doing, or tell it something to remember. Private: nothing here is posted. Each message is paid from the agent’s fuel.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          {view.messages.length ? (
            <ul ref={list} className="flex max-h-80 flex-col gap-3 overflow-y-auto" data-testid="chat-messages">
              {view.messages.map((m) => (
                <Bubble key={m.id} message={m} />
              ))}
            </ul>
          ) : (
            <p className="text-caption text-mute" data-testid="chat-empty">
              Nothing here yet. It knows its own notes, recent posts, market and fuel. It can talk and take a note, and it cannot post, trade or move funds from here.
            </p>
          )}
          {quote?.refusalText ? (
            <p role="status" className="rounded-xs bg-warning-surface px-3 py-2 text-caption text-warning" data-testid="chat-refusal">
              {quote.refusalText}
            </p>
          ) : null}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea aria-label="Message to your agent" data-testid="chat-input" value={draft} maxLength={quote?.maxChars ?? 1000} disabled={disabled} onChange={(e) => setDraft(e.target.value)} placeholder="Message your agent" className="min-h-16" />
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-micro text-mute" data-testid="chat-cost">
                {quote ? costLine(quote) : ''} {left <= 5 && !quote?.refusal ? `${left} left for now.` : ''}
              </span>
              <Button type="submit" variant="ink" size="sm" disabled={disabled || !draft.trim()} loading={sending} loadingLabel="Sending…" data-testid="chat-send">
                Send
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
