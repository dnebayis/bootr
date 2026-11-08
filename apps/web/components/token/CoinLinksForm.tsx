'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AGENT_OWN_X_ERROR, isAgentsOwnX, LINK_ERRORS, LINK_KINDS, normalizeLink, sameLinks, type CoinLinks, type LinkKind } from '@/lib/coin-link-rules';
import { coinLinksKey, NO_COIN_LINKS, ownContractUri, useCoinLinks } from '@/lib/coin-links';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import type { Token } from '@/lib/types';
import { xHandleOfUrl } from '@/lib/x-link';
import { Button } from '@/components/ui/Button';
import { Input, Label } from '@/components/ui/Field';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { useCreatorSignature } from './creator-signature';

type Draft = Record<LinkKind, string>;

const FIELDS: { kind: LinkKind; label: string; placeholder: string; url: boolean }[] = [
  { kind: 'website', label: 'Website', placeholder: 'https://', url: true },
  { kind: 'x', label: 'X', placeholder: '@handle or https://x.com/handle', url: false },
  { kind: 'telegram', label: 'Telegram', placeholder: 'https://t.me/', url: true },
  { kind: 'discord', label: 'Discord', placeholder: 'https://discord.gg/', url: true },
];

/** The stored links as the inputs show them: the X link as `@handle`, the rest as typed. */
export function draftOfLinks(links: CoinLinks): Draft {
  const handle = links.x ? xHandleOfUrl(links.x) : null;
  return { website: links.website ?? '', x: handle ? `@${handle}` : (links.x ?? ''), telegram: links.telegram ?? '', discord: links.discord ?? '' };
}

/** Per-field errors and the normalised links (null while any field is off), the launch form's rules plus the agent's own account. */
export function checkDraft(draft: Draft, agentXHandle: string | null | undefined): { errors: Partial<Record<LinkKind, string>>; links: CoinLinks | null } {
  const errors: Partial<Record<LinkKind, string>> = {};
  const links: CoinLinks = { ...NO_COIN_LINKS };
  for (const kind of LINK_KINDS) {
    const v = normalizeLink(kind, draft[kind]);
    if (v === undefined) errors[kind] = LINK_ERRORS[kind];
    else links[kind] = v;
  }
  if (!errors.x && isAgentsOwnX(links.x, agentXHandle)) errors.x = AGENT_OWN_X_ERROR;
  return { errors, links: Object.keys(errors).length ? null : links };
}

/**
 * The creator's "Links" block in the creator console: the coin's website, X account, Telegram and Discord, prefilled
 * from the hosted contract URI (`useCoinLinks`), saved with one wallet signature through `PUT /api/agent/:kernel/links`.
 * The answer replaces the links in the page's query at once (the document behind it changed with the same write).
 * Coins whose contract URI is not hosted here get one sentence instead of the form.
 */
export function CoinLinksForm({ token }: { token: Token }) {
  const queryClient = useQueryClient();
  const { canSign, sign } = useCreatorSignature();
  const links = useCoinLinks(token.metadata);
  const [edits, setEdits] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const stored = links.data ?? NO_COIN_LINKS;
  const editable = env.useMock || !!ownContractUri(token.metadata);
  const draft = edits ?? draftOfLinks(stored);
  const { errors, links: next } = checkDraft(draft, token.xHandle);
  const changed = !!next && !sameLinks(next, stored);
  const update = (kind: LinkKind, value: string) => setEdits({ ...draft, [kind]: value });

  const save = async () => {
    if (!next || !changed) return;
    setSaving(true);
    try {
      const signed = await sign(`Update the links of Bootr coin $${token.symbol} (#${token.agentId}, ${token.kernel}).`);
      if (!signed) return;
      const res = await fetch(`/api/agent/${token.kernel.toLowerCase()}/links`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...signed, links: next }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        toast.error(err.message ?? `Could not save (${res.status}).`);
        return;
      }
      const saved = (await res.json()) as CoinLinks;
      // The page's own copy of the mock store (the route changed the server's).
      if (env.useMock) mock.updateCoinLinks(token.kernel, saved);
      queryClient.setQueryData(coinLinksKey(token.metadata), saved);
      setEdits(null);
      toast.success('Links updated. The coin page and its contract metadata show them now.');
    } finally {
      setSaving(false);
    }
  };

  if (!editable) {
    return (
      <div data-testid="coin-links-form">
        <h3 className="mb-1.5 text-caption font-medium text-ink">Links</h3>
        <p className="text-caption text-mute">This coin’s contract metadata is not hosted on Bootr, so its links cannot be changed here.</p>
      </div>
    );
  }

  return (
    <form
      data-testid="coin-links-form"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <h3 className="text-caption font-medium text-ink">Links</h3>
        <p className="mt-0.5 text-caption text-mute">Shown on the coin page and written into the coin’s contract metadata. Clear a field to remove a link.{token.source === 'clanker' ? ' Clanker’s own page keeps the links set at launch.' : ''}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map(({ kind, label, placeholder, url }) => (
          <div key={kind}>
            <Label htmlFor={`coin-link-${kind}`}>{label}</Label>
            <Input
              id={`coin-link-${kind}`}
              value={draft[kind]}
              onChange={(e) => update(kind, e.target.value)}
              maxLength={200}
              placeholder={placeholder}
              inputMode={url ? 'url' : undefined}
              aria-invalid={!!errors[kind]}
              aria-describedby={errors[kind] ? `coin-link-${kind}-error` : undefined}
            />
            {errors[kind] ? (
              <p id={`coin-link-${kind}-error`} className="mt-1 text-micro text-danger">
                {errors[kind]}
              </p>
            ) : kind === 'x' ? (
              <p className="mt-1 text-micro text-mute">The project’s account; the agent’s own is shown on its line.</p>
            ) : null}
          </div>
        ))}
      </div>
      {canSign ? (
        <Button type="submit" variant="secondary" size="md" className="w-full" disabled={!changed || links.isPlaceholderData} loading={saving} loadingLabel="Saving…">
          Save links
        </Button>
      ) : (
        <ConnectButton className="w-full" block />
      )}
    </form>
  );
}
