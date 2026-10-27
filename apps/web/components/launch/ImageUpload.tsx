'use client';

import { useRef, useState } from 'react';
import { imageFileProblem, uploadImage } from '@/lib/launch';
import type { UploadResult } from '@/lib/ipfs';
import { cn } from '@/components/ui/cn';
import { UploadIcon } from '@/components/ui/Icons';
import { Label } from '@/components/ui/Field';

/* eslint-disable @next/next/no-img-element */

export type ImageUploadState =
  | { status: 'idle' }
  | { status: 'uploading'; preview: string; progress: number }
  | { status: 'done'; preview: string; result: UploadResult }
  | { status: 'error'; preview: string | null; message: string };

/**
 * Coin image picker: drag-and-drop or file picker, local preview, then pinned to IPFS through
 * `/api/upload`. The launch only accepts a finished upload (`status: 'done'`), never a data: URI.
 */
export function ImageUpload({ draftId, state, onState }: { draftId: string | null; state: ImageUploadState; onState: (s: ImageUploadState) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const preview = state.status === 'idle' ? null : state.preview;

  /** Cancels an upload in flight and frees the preview (unless it is kept for a retry). */
  function reset(keepPreview = false) {
    abortRef.current?.abort();
    abortRef.current = null;
    if (preview && !keepPreview) URL.revokeObjectURL(preview);
  }

  async function start(file: File | undefined | null) {
    if (!file || !draftId) return;
    const problem = imageFileProblem(file);
    if (problem) {
      reset();
      setLastFile(null);
      onState({ status: 'error', preview: null, message: problem });
      return;
    }
    const retry = file === lastFile && !!preview;
    reset(retry);
    const url = retry ? preview! : URL.createObjectURL(file);
    setLastFile(file);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    onState({ status: 'uploading', preview: url, progress: 0 });
    try {
      const result = await uploadImage(
        file,
        draftId,
        (p) => {
          if (!ctrl.signal.aborted) onState({ status: 'uploading', preview: url, progress: p });
        },
        ctrl.signal,
      );
      if (!ctrl.signal.aborted) onState({ status: 'done', preview: url, result });
    } catch (e) {
      if (!ctrl.signal.aborted) onState({ status: 'error', preview: url, message: (e as Error).message || 'Upload failed.' });
    }
  }

  function remove() {
    reset();
    setLastFile(null);
    if (inputRef.current) inputRef.current.value = '';
    onState({ status: 'idle' });
  }

  return (
    <div className="flex items-start gap-4">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={cn(
          'relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-dashed bg-canvas-soft text-mute transition-colors duration-150 hover:text-ink',
          dragging ? 'border-ink text-ink' : state.status === 'error' ? 'border-danger' : state.status === 'done' ? 'border-solid border-hairline' : 'border-hairline-strong',
        )}
        aria-label={preview ? 'Replace image' : 'Upload image'}
        aria-describedby="image-status"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void start(e.dataTransfer.files[0]);
        }}
      >
        {preview ? <img src={preview} alt="Coin image preview" className={cn('size-full object-cover', state.status === 'uploading' && 'opacity-60')} /> : <UploadIcon size={20} />}
        {state.status === 'uploading' ? (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-hairline" aria-hidden="true">
            <span className="block h-full bg-ink transition-[width] duration-150" style={{ width: `${Math.round(state.progress * 100)}%` }} />
          </span>
        ) : null}
      </button>
      <input
        ref={inputRef}
        id="image-file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="sr-only"
        onChange={(e) => {
          void start(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label htmlFor="image-file" hint="PNG, JPG, WebP or SVG · max 2 MB">
          Image
        </Label>
        <div id="image-status" role="status" aria-live="polite" className="min-w-0 text-caption" data-testid="image-status">
          {state.status === 'idle' ? (
            <span className="text-mute">Drop a square image on the box or choose a file. It is pinned to IPFS.</span>
          ) : state.status === 'uploading' ? (
            <span className="font-mono tabular text-mute">Pinning to IPFS… {Math.round(state.progress * 100)}%</span>
          ) : state.status === 'done' ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-ink">Pinned</span>
              <a href={state.result.url} target="_blank" rel="noreferrer" className="truncate font-mono text-mute hover:text-ink" title={state.result.ipfsUri}>
                {state.result.ipfsUri}
              </a>
            </span>
          ) : (
            <span className="text-danger">{state.message}</span>
          )}
        </div>
        <div className="flex gap-3 text-caption">
          {state.status === 'error' && lastFile ? (
            <button type="button" className="text-link hover:underline" onClick={() => void start(lastFile)}>
              Try again
            </button>
          ) : null}
          {state.status === 'idle' || state.status === 'error' ? (
            <button type="button" className="text-link hover:underline" onClick={() => inputRef.current?.click()}>
              Choose file
            </button>
          ) : null}
          {state.status !== 'idle' ? (
            <button type="button" className="text-link hover:underline" onClick={remove}>
              {state.status === 'uploading' ? 'Cancel' : 'Remove'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
