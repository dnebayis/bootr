'use client';

import { useEffect, useState } from 'react';

/**
 * Base's "type scramble" for a headline: on mount every character cycles through glyphs and resolves into the
 * real text left to right, all inside `TOTAL_MS` (Base keeps type sequences under 800 ms). The server renders
 * the final text, so there is no layout shift and nothing to hydrate differently; under
 * `prefers-reduced-motion` the text never scrambles. Screen readers read the real text once (the animated
 * copy is `aria-hidden`). Headlines only, never body copy.
 */

const GLYPHS = '#+=:-*0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TOTAL_MS = 640;
const TICK_MS = 40;

export function Scramble({ text, className }: { text: string; className?: string }) {
  const [shown, setShown] = useState(text);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const chars = Array.from(text);
    // Each character settles at its own moment, spread over the first two thirds of the run.
    const settle = chars.map((_, i) => (chars.length > 1 ? (i / (chars.length - 1)) * TOTAL_MS * 0.66 : 0));
    const start = performance.now();
    let timer = 0;
    const tick = () => {
      const t = performance.now() - start;
      const next = chars.map((c, i) => (c === ' ' || t >= settle[i] ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)])).join('');
      setShown(next);
      if (t < TOTAL_MS) timer = window.setTimeout(tick, TICK_MS);
      else setShown(text);
    };
    timer = window.setTimeout(tick, TICK_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  return (
    <span className={className}>
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
