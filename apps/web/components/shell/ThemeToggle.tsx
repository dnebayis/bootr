'use client';

import { useTheme } from '@/lib/theme';
import { useSyncExternalStore } from 'react';
import { MoonIcon, SunIcon } from '@/components/ui/Icons';

const subscribe = () => () => {};

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const dark = mounted && resolvedTheme === 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="inline-flex size-8 items-center justify-center rounded-sm text-mute transition-colors hover:bg-canvas-sub hover:text-ink"
    >
      {mounted ? dark ? <SunIcon /> : <MoonIcon /> : <span className="size-4" />}
    </button>
  );
}
