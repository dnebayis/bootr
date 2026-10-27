'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { CheckIcon, CopyIcon } from './Icons';
import { cn } from './cn';

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn('inline-flex size-6 items-center justify-center rounded-xs text-mute transition-colors hover:bg-canvas-sub hover:text-ink', className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast('Copied to clipboard');
          setTimeout(() => setDone(false), 1200);
        } catch {
          toast.error('Copy failed');
        }
      }}
    >
      {done ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}
