'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex flex-col items-start gap-4 py-24">
      <span className="font-mono text-caption text-mute">Error{error.digest ? ` · ${error.digest}` : ''}</span>
      <h1 className="text-display-lg font-semibold text-ink">Something failed to load.</h1>
      <p className="max-w-lg text-sm text-mute">The indexer may be unreachable. Try again in a moment.</p>
      <Button variant="secondary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
