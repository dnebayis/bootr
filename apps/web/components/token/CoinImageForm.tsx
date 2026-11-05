'use client';

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { coinImageStatement } from '@/lib/coin-image';
import { env } from '@/lib/env';
import { forgetCoinImages } from '@/lib/indexer';
import { UPLOAD_IMAGE_TYPES } from '@/lib/ipfs';
import { imageFileProblem } from '@/lib/launch';
import { mock } from '@/lib/mock';
import type { Token } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { TokenImage } from '@/components/ui/TokenImage';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { useCreatorSignature } from './creator-signature';

/**
 * The creator's "Image" block in the creator console: changes the picture this site shows, with one wallet signature through
 * `PUT /api/coin/:id/image`. The image set at launch stays on chain, and the block says so.
 */
export function CoinImageForm({ token }: { token: Token }) {
  const queryClient = useQueryClient();
  const { canSign, sign } = useCreatorSignature();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const changed = !!token.imageOnChain;

  useEffect(() => (preview ? () => URL.revokeObjectURL(preview) : undefined), [preview]);

  const choose = (next: File | null) => {
    setFile(next);
    setPreview(next ? URL.createObjectURL(next) : null);
  };

  const refresh = () => {
    forgetCoinImages();
    for (const key of ['token', 'tokens', 'profile', 'search', 'agents', 'leaderboard', 'creator']) void queryClient.invalidateQueries({ queryKey: [key] });
  };

  const save = async () => {
    if (!file) return;
    setBusy('save');
    try {
      const signed = await sign(coinImageStatement(token.symbol, token.id));
      if (!signed) return;
      const body = new FormData();
      body.set('file', file);
      body.set('message', signed.message);
      body.set('signature', signed.signature);
      const res = await fetch(`/api/coin/${token.id.toLowerCase()}/image`, { method: 'PUT', body });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        toast.error(err.message ?? `Could not save (${res.status}).`);
        return;
      }
      const saved = (await res.json()) as { image: string };
      // The page's own copy of the mock store (the route changed the server's).
      if (env.useMock) mock.setCoinImage(token.id, saved.image);
      choose(null);
      if (input.current) input.current.value = '';
      refresh();
      toast.success('Image updated on Bootr.');
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy('reset');
    try {
      const signed = await sign(coinImageStatement(token.symbol, token.id));
      if (!signed) return;
      const res = await fetch(`/api/coin/${token.id.toLowerCase()}/image`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        toast.error(err.message ?? `Could not save (${res.status}).`);
        return;
      }
      if (env.useMock) mock.setCoinImage(token.id, null);
      refresh();
      toast.success('Bootr shows the original image again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      data-testid="coin-image-form"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <h3 className="text-caption font-medium text-ink">Image</h3>
        <p className="mt-0.5 text-caption text-mute">Changes the image shown on Bootr. The image set at launch stays on chain, so wallets and other sites may still show the original.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {preview ? (
          <img src={preview} alt="The new image" width={56} height={56} className="size-14 shrink-0 rounded-sm border border-hairline object-cover" />
        ) : (
          <TokenImage src={token.image} symbol={token.symbol} size={56} className="rounded-sm" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <input
            ref={input}
            id="coin-image-file"
            type="file"
            accept={UPLOAD_IMAGE_TYPES.join(',')}
            className="sr-only"
            onChange={(e) => {
              const next = e.target.files?.[0] ?? null;
              const off = next ? imageFileProblem(next) : null;
              setProblem(off);
              choose(off ? null : next);
            }}
          />
          <Button type="button" variant="secondary" size="sm" onClick={() => input.current?.click()}>
            Choose a file
          </Button>
          <span className="text-micro text-mute">PNG, JPG, WebP or SVG, at most 2 MB</span>
        </div>
      </div>
      {problem ? <p className="text-micro text-danger">{problem}</p> : null}
      {canSign ? (
        <div className="flex flex-col gap-2">
          <Button type="submit" variant="secondary" size="md" className="w-full" disabled={!file || busy === 'reset'} loading={busy === 'save'} loadingLabel="Saving…">
            Save image
          </Button>
          {changed ? (
            <Button type="button" variant="ghost" size="sm" className="w-full" disabled={busy === 'save'} loading={busy === 'reset'} loadingLabel="Saving…" onClick={() => void reset()}>
              Use the original image
            </Button>
          ) : null}
        </div>
      ) : (
        <ConnectButton className="w-full" block />
      )}
    </form>
  );
}
