'use client';

import { useSyncExternalStore } from 'react';

/**
 * Shared wall clock for "2h ago" labels, ticking every 30 s.
 * Read through useSyncExternalStore so render never calls Date.now(): the server/prerender snapshot
 * is 0 (Cache Components rejects Date.now() during prerender), and the client snapshot is the last tick.
 */
const CLOCK_MS = 30_000;
let clock = 0;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(cb: () => void) {
  clockListeners.add(cb);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      clock = Date.now();
      clockListeners.forEach((l) => l());
    }, CLOCK_MS);
  }
  return () => {
    clockListeners.delete(cb);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function readClock() {
  if (clock === 0) clock = Date.now();
  return clock;
}

export function useNow() {
  return useSyncExternalStore(subscribeClock, readClock, () => 0);
}

const noopSubscribe = () => () => {};
export function useMounted() {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useReducedMotion() {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
