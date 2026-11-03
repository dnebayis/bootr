import type { CSSProperties } from 'react';

/**
 * Pure geometry behind `Tilt` (components/ui/Tilt.tsx), kept DOM-free so it is unit-testable.
 * The card follows the pointer by at most `MAX_TILT` degrees on each axis.
 */

/** Hard ceiling for the tilt, degrees (DESIGN.md "Primitives": ≤ 6°). */
export const MAX_TILT = 6;

/** Perspective distance for the 3D transform, px. */
export const PERSPECTIVE = 800;

export type TiltState = {
  /** Pointer position inside the element, 0..1 on each axis. */
  px: number;
  py: number;
  /** Rotation in degrees, each within ±intensity. */
  rotateX: number;
  rotateY: number;
};

/** Clamps a requested intensity to `0..MAX_TILT`; non-finite input yields the maximum. */
export function clampIntensity(intensity?: number): number {
  if (intensity === undefined || !Number.isFinite(intensity)) return MAX_TILT;
  return Math.min(MAX_TILT, Math.max(0, intensity));
}

const unit = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

/**
 * Pointer `x`/`y` (px, relative to the element's top-left) over an element of `width` x `height`
 * to a tilt. The top edge lifts toward the viewer when the pointer is near it (positive rotateX),
 * the right edge when the pointer is near the right (positive rotateY). Out-of-bounds points are
 * clamped to the edge, so the rotation never exceeds the intensity.
 */
export function tiltFromPointer({ x, y, width, height }: { x: number; y: number; width: number; height: number }, intensity?: number): TiltState {
  const max = clampIntensity(intensity);
  const px = width > 0 ? unit(x / width) : 0.5;
  const py = height > 0 ? unit(y / height) : 0.5;
  return { px, py, rotateX: (0.5 - py) * 2 * max, rotateY: (px - 0.5) * 2 * max };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Inline style for the tilted element: no transform at rest (`null`), a perspective + rotation while hot. */
export function tiltStyle(t: TiltState | null): CSSProperties {
  if (!t) return {};
  return { transform: `perspective(${PERSPECTIVE}px) rotateX(${r2(t.rotateX)}deg) rotateY(${r2(t.rotateY)}deg)` };
}

/**
 * The specular layer: a white highlight under the pointer (≤ 10% alpha, reads in dark mode) and a
 * faint ink shade on the far side (≤ 4%, reads in light mode). Both are neutral: no hue, no accent.
 */
export function specularStyle(t: TiltState | null): CSSProperties {
  if (!t) return { opacity: 0 };
  const x = r2(t.px * 100);
  const y = r2(t.py * 100);
  const angle = r2((Math.atan2(t.py - 0.5, t.px - 0.5) * 180) / Math.PI + 90);
  return {
    opacity: 1,
    backgroundImage: `radial-gradient(60% 60% at ${x}% ${y}%, rgb(255 255 255 / 0.1), rgb(255 255 255 / 0) 70%), linear-gradient(${angle}deg, transparent 55%, color-mix(in srgb, var(--ink) 4%, transparent) 100%)`,
  };
}
