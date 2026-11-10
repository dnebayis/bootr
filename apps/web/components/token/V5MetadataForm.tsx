'use client';

/* eslint-disable @next/next/no-img-element */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConnection, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { clankerLauncherV5Abi } from '@/lib/abi/launcher';
import { builderDataSuffix } from '@/lib/attribution';
import { appChain } from '@/lib/chains';
import { contracts } from '@/lib/contracts';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { metadataStillEditable, v5SettingsOf } from '@/lib/token-settings';
import { useTxRunner } from '@/lib/tx';
import type { Token } from '@/lib/types';
import { useV5Metadata, withDescription } from '@/lib/v5-metadata';
import { Button } from '@/components/ui/Button';
import { Input, Label, Textarea } from '@/components/ui/Field';
import { TokenImage } from '@/components/ui/TokenImage';
import { ConnectButton } from '@/components/shell/ConnectButton';

const MAX_DESCRIPTION = 500;
const IMAGE_URL = /^https:\/\/[^\s"<>]{1,500}$/;

/**
 * "On-chain image and metadata" for a Clanker v5 coin launched with editable metadata (docs/design/clanker-v5-token-
 * settings.md section 2.5): the coin's creator wallet, and nobody else, changes the token's own image and the
 * description in its metadata JSON through the launcher (`updateImage`, `updateMetadata`), and can lock both for good
 * (`lockMetadata`, after a confirmation). Name, ticker and fee recipients never change. Wallets, explorers and
 * clanker.world read these, unlike the Bootr-only image above.
 */
export function V5MetadataForm({ token }: { token: Token }) {
  const settings = v5SettingsOf(token);
  const meta = useV5Metadata(token);
  const { address } = useConnection();
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const queryClient = useQueryClient();
  const [image, setImage] = useState('');
  const [description, setDescription] = useState<string | null>(null);
  const [confirmLock, setConfirmLock] = useState(false);
  if (!settings?.metadataEditable) return null;

  const editable = metadataStillEditable(settings);
  const isCreator = env.useMock || (!!address && address.toLowerCase() === token.creator.toLowerCase());
  const launcher = contracts.clankerLauncherV5;
  const shownDescription = description ?? meta?.description ?? '';
  const imageOk = image.trim() === '' || IMAGE_URL.test(image.trim());
  const imageChanged = image.trim() !== '' && image.trim() !== meta?.image;
  const descriptionChanged = description !== null && description.trim() !== (meta?.description ?? '');
  const descriptionOk = shownDescription.trim().length > 0 && shownDescription.length <= MAX_DESCRIPTION;
  const canSave = editable && isCreator && imageOk && (imageChanged || (descriptionChanged && descriptionOk));

  const refresh = () => {
    for (const key of ['token', 'tokens', 'profile', 'creator']) void queryClient.invalidateQueries({ queryKey: [key] });
    void queryClient.invalidateQueries({ queryKey: ['readContracts'] });
  };

  const save = async () => {
    if (!canSave) return;
    const nextJson = descriptionChanged ? withDescription(meta?.metadataJson, shownDescription.trim()) : null;
    if (env.useMock) {
      mock.updateV5Metadata(token.id, { ...(imageChanged ? { image: image.trim() } : {}), ...(nextJson ? { metadataJson: nextJson } : {}) });
      toast.success('Mock: the coin’s image and metadata were updated on chain.');
    } else {
      if (!launcher) return;
      // One transaction per key, as the launcher forwards them: the image, then the metadata JSON.
      if (imageChanged) {
        const r = await run('Update the coin image', () =>
          write.mutateAsync({ address: launcher, abi: clankerLauncherV5Abi, functionName: 'updateImage', args: [token.id as Address, image.trim()], chainId: appChain.id, dataSuffix: builderDataSuffix }),
        );
        if (!r) return;
      }
      if (nextJson) {
        const r = await run('Update the coin metadata', () =>
          write.mutateAsync({ address: launcher, abi: clankerLauncherV5Abi, functionName: 'updateMetadata', args: [token.id as Address, nextJson], chainId: appChain.id, dataSuffix: builderDataSuffix }),
        );
        if (!r) return;
      }
    }
    setImage('');
    setDescription(null);
    refresh();
  };

  const lock = async () => {
    if (env.useMock) {
      mock.updateV5Metadata(token.id, { lock: true });
      toast.success('Mock: the coin’s image and metadata are locked for good.');
    } else {
      if (!launcher) return;
      const r = await run('Lock the coin metadata', () =>
        write.mutateAsync({ address: launcher, abi: clankerLauncherV5Abi, functionName: 'lockMetadata', args: [token.id as Address], chainId: appChain.id, dataSuffix: builderDataSuffix }),
      );
      if (!r) return;
    }
    setConfirmLock(false);
    refresh();
  };

  return (
    <form
      data-testid="v5-metadata-form"
      data-locked={settings.metadataLocked ? 'true' : 'false'}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div>
        <h3 className="text-caption font-medium text-ink">On-chain image and metadata</h3>
        <p className="mt-0.5 text-caption text-mute">
          {editable
            ? 'Changes the image and description stored in the coin itself, which wallets, explorers and clanker.world read. Only your wallet can do this; the name, ticker and fee recipients never change.'
            : 'Locked for good: the coin’s on-chain image and metadata can no longer change.'}
        </p>
      </div>
      <div className="flex items-center gap-3">
        {imageChanged && imageOk ? (
          <img src={image.trim()} alt="The new image" width={56} height={56} className="size-14 shrink-0 rounded-sm border border-hairline object-cover" />
        ) : (
          <TokenImage src={meta?.image ?? token.image} symbol={token.symbol} size={56} className="rounded-sm" />
        )}
        <p className="min-w-0 text-caption text-body" data-testid="v5-metadata-current">
          {meta?.description ?? 'No description on chain yet.'}
        </p>
      </div>
      {editable ? (
        <>
          <div>
            <Label htmlFor="v5-image" hint="https">
              New image URL
            </Label>
            <Input id="v5-image" inputMode="url" placeholder="https://…" value={image} onChange={(e) => setImage(e.target.value)} aria-invalid={!imageOk} disabled={!isCreator} />
          </div>
          <div>
            <Label htmlFor="v5-description" hint={`${shownDescription.length}/${MAX_DESCRIPTION}`}>
              Description
            </Label>
            <Textarea id="v5-description" rows={3} maxLength={MAX_DESCRIPTION} value={shownDescription} onChange={(e) => setDescription(e.target.value)} disabled={!isCreator} />
          </div>
          {!isCreator ? (
            address ? (
              <p className="text-caption text-mute">Only the wallet that launched this coin can change it.</p>
            ) : (
              <ConnectButton className="w-full" block />
            )
          ) : (
            <div className="flex flex-col gap-2">
              <Button type="submit" variant="secondary" size="md" className="w-full" disabled={!canSave} loading={pending === 'Update the coin image' || pending === 'Update the coin metadata'} loadingLabel="Saving on chain…">
                Save on chain
              </Button>
              {confirmLock ? (
                <div role="alertdialog" aria-labelledby="v5-lock-title" className="flex flex-col gap-2 rounded-sm border border-warning p-3" data-testid="v5-lock-confirm">
                  <p id="v5-lock-title" className="text-caption text-ink">
                    Lock the image and metadata for good? Nobody, you included, can change them afterwards. This cannot be undone.
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" variant="ink" size="sm" onClick={() => void lock()} loading={pending === 'Lock the coin metadata'}>
                      Lock for good
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmLock(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="w-full" onClick={() => setConfirmLock(true)}>
                  Lock metadata
                </Button>
              )}
            </div>
          )}
        </>
      ) : null}
    </form>
  );
}
