'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { useMediaQuery, useReducedMotion } from '@/lib/hooks';
import { cn } from './cn';
import { specularStyle, tiltFromPointer, tiltStyle, type TiltState } from './tilt-math';

/**
 * Holographic tilt: the wrapped card rotates toward the pointer by at most 6° on each axis
 * (`intensity`, clamped), with a neutral specular layer (white ≤ 10%, ink ≤ 4%, no hue) that
 * follows the pointer and a 250 ms `ease-out-quint` return to flat on leave. DESIGN.md "Primitives
 * (Base UI)" has the rules.
 *
 * Off, and rendered as a plain wrapper with no handlers and no transform, when the user prefers
 * reduced motion, on touch / coarse pointers (`(hover: hover) and (pointer: fine)` is false), and
 * on the server and first client render (so there is no hydration mismatch). Touch pointer events
 * are ignored even on hybrid devices.
 *
 * ```tsx
 * <Tilt className="rounded-md"><TokenCard token={t} /></Tilt>
 * ```
 */
export function Tilt({ children, className, intensity, style }: { children: ReactNode; className?: string; intensity?: number; style?: CSSProperties }) {
  const reduced = useReducedMotion();
  const fine = useMediaQuery('(hover: hover) and (pointer: fine)');
  const active = fine && !reduced;
  const [tilt, setTilt] = useState<TiltState | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<TiltState | null>(null);

  const flush = useCallback(() => {
    frame.current = null;
    setTilt(pending.current);
  }, []);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    const r = e.currentTarget.getBoundingClientRect();
    pending.current = tiltFromPointer({ x: e.clientX - r.left, y: e.clientY - r.top, width: r.width, height: r.height }, intensity);
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  };

  const onPointerLeave = () => {
    pending.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setTilt(null);
  };

  if (!active) {
    return (
      <div className={cn('relative', className)} style={style}>
        {children}
      </div>
    );
  }

  return (
    <div
      className={cn('relative [transform-style:preserve-3d] will-change-transform', tilt ? 'transition-none' : 'transition-transform duration-250 ease-out-quint', className)}
      style={{ ...style, ...tiltStyle(tilt) }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerLeave}
      data-tilt={tilt ? 'hot' : 'rest'}
    >
      {children}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-250 ease-out-quint" style={specularStyle(tilt)} />
    </div>
  );
}
