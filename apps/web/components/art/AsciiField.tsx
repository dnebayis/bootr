'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import { useMounted } from '@/lib/hooks';
import { cn } from '@/components/ui/cn';
import { CELL, GLYPHS } from '@/components/tokens/AsciiWake';

/**
 * A drifting ASCII field: the hero's texture. On the same 12px character grid as the page-wide `AsciiWake`
 * dots, cells where a slow 2D value noise crosses a threshold are drawn as mono glyphs (`.` `:` `-` `=` `+`
 * `*` `#` by density) in `ink` at low opacity, so a faint weather of characters drifts across the hero
 * at a few pixels per second. No colour: the accent belongs to the wake and the one primary button.
 *
 * Budget: canvas only, one `requestAnimationFrame` loop gated to `FPS` (12) frames per second, stopped
 * while the tab is hidden or the canvas is scrolled out of view, and a single static frame under
 * `prefers-reduced-motion`. Nothing is rendered on the server (the canvas mounts after hydration), the
 * canvas is `aria-hidden` and ignores the pointer. A CSS mask (set by the caller) keeps the glyphs away
 * from the hero text so its contrast is the plain canvas pairing.
 */

const FPS = 12;
const FRAME_MS = 1000 / FPS;
const LATTICE = 64; // value-noise lattice side (wraps)
const SCALE = 0.11; // cells per lattice step: lower = larger, calmer blobs
const DRIFT_X = 0.028; // lattice units per second
const DRIFT_Y = -0.016;
const THRESHOLD = 0.56; // noise value under which a cell stays empty (the wake dots show through)
const ALPHA_DARK: [number, number] = [0.07, 0.2]; // glyph alpha at the threshold and at full density
const ALPHA_LIGHT: [number, number] = [0.05, 0.15]; // ink on white reads stronger, keep it lighter

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

/** Deterministic lattice so the field looks the same on every visit (seeded LCG). */
function lattice(seed: number) {
  const out = new Float32Array(LATTICE * LATTICE);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s / 4294967296;
  }
  return out;
}

function noise(grid: Float32Array, x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const x0 = ((xi % LATTICE) + LATTICE) % LATTICE;
  const y0 = ((yi % LATTICE) + LATTICE) % LATTICE;
  const x1 = (x0 + 1) % LATTICE;
  const y1 = (y0 + 1) % LATTICE;
  const a = grid[y0 * LATTICE + x0]!;
  const b = grid[y0 * LATTICE + x1]!;
  const c = grid[y1 * LATTICE + x0]!;
  const d = grid[y1 * LATTICE + x1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function AsciiField({ className, style, seed = 8004 }: { className?: string; style?: CSSProperties; seed?: number }) {
  const mounted = useMounted();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const host = canvas.parentElement;
    const ctx = canvas.getContext('2d');
    if (!host || !ctx) return;

    const grid = lattice(seed);
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motionQuery.matches;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let ox = 0;
    let oy = 0;
    let ink = '#fff';
    let alpha = ALPHA_DARK;
    let font = `${CELL}px monospace`;
    let raf = 0;
    let lastFrame = 0;
    let visible = true; // the tab is visible and the canvas is in the viewport
    let inView = true;
    const t0 = performance.now();

    const readInk = () => {
      const cs = getComputedStyle(canvas);
      ink = cs.color || ink;
      font = `${CELL}px ${cs.fontFamily}`;
      alpha = document.documentElement.classList.contains('dark') ? ALPHA_DARK : ALPHA_LIGHT;
    };

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ink;
      const [lo, hi] = alpha;
      const span = 1 - THRESHOLD;
      for (let r = 0; r < rows; r++) {
        const y = oy + r * CELL + CELL / 2;
        const ny = r * SCALE + t * DRIFT_Y;
        for (let c = 0; c < cols; c++) {
          // Two octaves: a broad drift plus a finer grain so the blobs have texture.
          const nx = c * SCALE + t * DRIFT_X;
          const v = noise(grid, nx, ny) * 0.7 + noise(grid, nx * 2.3 + 17, ny * 2.3 + 9) * 0.3;
          if (v < THRESHOLD) continue;
          const d = Math.min(1, (v - THRESHOLD) / span);
          ctx.globalAlpha = lo + (hi - lo) * d;
          ctx.fillText(GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(d * GLYPHS.length))]!, ox + c * CELL + CELL / 2, y + 0.5);
        }
      }
      ctx.globalAlpha = 1;
    };

    const step = (now: number) => {
      raf = 0;
      if (!visible || reduced) return;
      if (now - lastFrame >= FRAME_MS) {
        lastFrame = now;
        draw(now);
      }
      raf = requestAnimationFrame(step);
    };
    const run = () => {
      if (!raf && visible && !reduced) raf = requestAnimationFrame(step);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const layout = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = host.clientWidth;
      height = host.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      cols = Math.max(1, Math.ceil(width / CELL));
      rows = Math.max(1, Math.ceil(height / CELL));
      ox = (width - cols * CELL) / 2;
      oy = (height - rows * CELL) / 2;
      readInk();
      draw(performance.now());
    };

    const onVisibility = () => {
      visible = document.visibilityState === 'visible' && inView;
      if (visible) run();
      else stop();
    };
    const io = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      onVisibility();
    });
    const onMotion = () => {
      reduced = motionQuery.matches;
      if (reduced) {
        stop();
        draw(performance.now());
      } else run();
    };

    layout();
    run();
    const ro = new ResizeObserver(layout);
    ro.observe(host);
    io.observe(canvas);
    const mo = new MutationObserver(() => {
      readInk();
      draw(performance.now());
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    document.addEventListener('visibilitychange', onVisibility);
    motionQuery.addEventListener('change', onMotion);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery.removeEventListener('change', onMotion);
    };
  }, [mounted, seed]);

  if (!mounted) return null;
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-testid="ascii-field"
      style={style}
      className={cn('pointer-events-none absolute inset-0 block size-full select-none font-mono text-ink', className)}
    />
  );
}
