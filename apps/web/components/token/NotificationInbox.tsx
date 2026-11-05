'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ago } from '@/lib/format';
import { fetchNotifications, qk, ReviewError, saveNotificationSettings, telegramAction, useNotificationCount } from '@/lib/indexer';
import type { AgentNotification, AgentNotifications, Token } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Field';
import { cn } from '@/components/ui/cn';
import { ConnectAgentX } from './ConnectAgentX';
import { useConsoleSession } from './console-session';

const LINK_POLL_MS = 5_000;

function toneClass(item: AgentNotification): string {
  if (item.state === 'resolved') return 'text-mute';
  return item.tone === 'danger' ? 'text-danger' : item.tone === 'warning' ? 'text-warning' : 'text-ink';
}

function Item({ item, token }: { item: AgentNotification; token: Token }) {
  const at = Math.floor(Date.parse(item.state === 'resolved' && item.resolvedAt ? item.resolvedAt : item.firstAt) / 1000);
  return (
    <li data-testid="notification-item" data-event={item.event} data-state={item.state} className="flex flex-col gap-1 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn('text-sm font-medium', toneClass(item))}>{item.title}</span>
        <span className="shrink-0 font-mono text-micro text-mute tabular" title={new Date(at * 1000).toLocaleString()}>
          {item.state === 'resolved' ? `cleared ${ago(at)}` : ago(at)}
        </span>
      </div>
      <p className={cn('text-caption', item.state === 'resolved' ? 'text-mute' : 'text-body')}>{item.body}</p>
      {item.event === 'x_revoked' && item.state === 'active' ? (
        <div className="mt-1">
          <ConnectAgentX token={token} again />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The creator's inbox inside the console: what needs them now (reviews, fuel, gas, a stopped agent, the X connection, a
 * renewal), what cleared lately, a switch per kind of event and the link to a Telegram chat. The badge is public; the
 * items need the console's one signature. Without a bot on the deployment the inbox works and Telegram says so.
 */
export function NotificationInbox({ token }: { token: Token }) {
  const queryClient = useQueryClient();
  const count = useNotificationCount(token.kernel);
  const session = useConsoleSession(token);
  const [view, setView] = useState<AgentNotifications | null>(null);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);

  const active = view ? view.active : (count.data?.active ?? 0);

  const apply = (next: AgentNotifications) => {
    session.keep(next.token);
    setView(next);
    queryClient.setQueryData(qk.notificationCount(token.kernel), { active: next.active });
  };

  /** Runs one signed call; a session that ran out closes the inbox instead of asking for a signature out of nowhere. */
  const signed = async (run: (auth: NonNullable<Awaited<ReturnType<typeof session.auth>>>) => Promise<void>, fallback: string) => {
    try {
      const auth = await session.auth();
      if (!auth) return;
      await run(auth);
    } catch (err) {
      if (err instanceof ReviewError && err.status === 401) {
        session.forget();
        setView(null);
        toast.error('The console session expired. Open the inbox again.');
      } else {
        toast.error(err instanceof Error ? err.message : fallback);
      }
    }
  };

  const open = async () => {
    setOpening(true);
    await signed(async (auth) => apply(await fetchNotifications(token.kernel, auth)), 'Could not open the inbox.');
    setOpening(false);
  };

  const toggle = async (key: string, enabled: boolean) => {
    if (!view) return;
    const optOut = view.events.filter((e) => (e.key === key ? !enabled : !e.enabled)).map((e) => e.key);
    setSaving(true);
    await signed(async (auth) => apply(await saveNotificationSettings(token.kernel, auth, optOut)), 'Could not save that.');
    setSaving(false);
  };

  const link = async () => {
    setSaving(true);
    await signed(async (auth) => {
      const res = await telegramAction(token.kernel, auth, 'link');
      session.keep(res.token);
      setDeepLink(res.url);
    }, 'Could not make a Telegram link.');
    setSaving(false);
  };

  const unlink = async () => {
    setSaving(true);
    await signed(async (auth) => {
      const res = await telegramAction(token.kernel, auth, 'unlink');
      session.keep(res.token);
      setDeepLink(null);
      setView((v) => (v ? { ...v, telegram: { ...v.telegram, linked: false, linkedAt: null } } : v));
      toast.success('Telegram disconnected.');
    }, 'Could not disconnect Telegram.');
    setSaving(false);
  };

  // While a deep link is out, look for the chat it binds; pressing Start happens in another app.
  useEffect(() => {
    if (!deepLink || view?.telegram.linked) return;
    const timer = setInterval(() => {
      void (async () => {
        const held = session.held();
        if (!held) return;
        const next = await fetchNotifications(token.kernel, { token: held }).catch(() => null);
        if (next) setView(next);
      })();
    }, LINK_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `session` changes every render; the link and the state decide
  }, [deepLink, view?.telegram.linked, token.kernel]);

  const items = view?.items ?? [];
  const live = items.filter((i) => i.state === 'active');
  const cleared = items.filter((i) => i.state === 'resolved');

  return (
    <div data-testid="notification-inbox" className="border-b border-hairline pb-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-caption font-medium text-ink">
          Inbox{' '}
          <span className={cn('font-mono text-micro', active > 0 ? 'text-ink' : 'text-mute')} data-testid="notification-count">
            {active} open
          </span>
        </h3>
        <div className="flex items-center gap-2">
          {view ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings} data-testid="notification-settings-toggle">
              Settings
            </Button>
          ) : null}
          <Button type="button" variant={view ? 'ghost' : 'secondary'} size="sm" onClick={() => void open()} loading={opening} loadingLabel={view ? 'Refreshing…' : 'Opening…'} disabled={!session.canSign}>
            {view ? 'Refresh' : 'Open inbox'}
          </Button>
        </div>
      </div>

      {!view ? (
        <p className="mt-1 text-micro text-mute">Reviews, fuel, gas and anything else that needs you. Opening it takes one wallet signature; Telegram alerts are set up inside.</p>
      ) : (
        <>
          {items.length === 0 ? (
            <p className="mt-2 text-caption text-mute" data-testid="notification-empty">
              Nothing needs you right now.
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-hairline">
              {[...live, ...cleared].map((item) => (
                <Item key={item.id} item={item} token={token} />
              ))}
            </ul>
          )}

          {showSettings ? (
            <div className="mt-3 flex flex-col gap-3" data-testid="notification-settings">
              <div className="rounded-sm border border-hairline px-3 py-2" data-testid="telegram-link">
                <span className="block text-sm text-ink">Telegram alerts</span>
                {!view.telegram.available ? (
                  <span className="block text-micro text-mute" data-testid="telegram-unavailable">
                    Telegram is not set up here yet. Everything still shows in this inbox.
                  </span>
                ) : view.telegram.linked ? (
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <span className="text-micro text-mute" data-testid="telegram-linked">
                      A chat is connected for every coin of this wallet.
                    </span>
                    <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => void unlink()}>
                      Disconnect
                    </Button>
                  </div>
                ) : deepLink ? (
                  <div className="mt-1 flex flex-col gap-1">
                    <a href={deepLink} target="_blank" rel="noreferrer" className="text-sm text-link underline" data-testid="telegram-deep-link">
                      Open the bot in Telegram and press Start
                    </a>
                    <span className="text-micro text-mute">This link works once and for 15 minutes. This box updates when the chat is connected.</span>
                  </div>
                ) : (
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <span className="text-micro text-mute">Get the same alerts in a Telegram chat, for every coin of this wallet.</span>
                    <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => void link()} data-testid="telegram-connect">
                      Connect Telegram
                    </Button>
                  </div>
                )}
              </div>
              <ul className="divide-y divide-hairline rounded-sm border border-hairline">
                {view.events.map((e) => (
                  <li key={e.key} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-sm text-ink">{e.label}</span>
                    <Switch id={`notify-${e.key}`} label={e.label} checked={e.enabled} disabled={saving} onChange={(v) => void toggle(e.key, v)} />
                  </li>
                ))}
              </ul>
              <p className="text-micro text-mute">An event you turn off stays out of this inbox and out of Telegram.</p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
