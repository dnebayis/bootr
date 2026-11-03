'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

/**
 * A background field of faint ink dots on a character grid. `fixed` covers the viewport behind the whole page
 * (the home page); otherwise it sits behind whatever it wraps. The pointer drags a wake through it: cells near the hand turn into ASCII glyphs that thicken with
 * the heat (`.` `:` `-` `=` `+` `*` `#`) and drift a little toward the pointer, then cool back to dots behind
 * it over `TRAIL_MS`. A press (or tap) sends a ring out.
 *
 * Canvas only, no DOM per cell, idle when nothing is hot (no animation frame), redraws on resize and theme
 * change, static under `prefers-reduced-motion`. Decorative: the canvas is `aria-hidden` and sits behind the
 * content; pointer events are read on the wrapper (or the window when `fixed`) so hovering any content wakes
 * the field too, and nothing blocks scrolling or selection.
 */

/** Grid pitch (px) and the glyph ramp, shared with `components/art/AsciiField` so the hero's field sits on the same grid. */
export const CELL = 12; // px per grid cell = the mono font size
const REACH = 72; // px: how far from the pointer cells heat up
const TRAIL_MS = 1200; // cooling time from full heat back to a dot
const PULL = 10; // px: max drift of a cell toward the pointer
const RING_SPEED = 480; // px/s
const RING_WIDTH = 28; // px
export const GLYPHS = ['.', ':', '-', '=', '+', '*', '#'];
const DOT_RADIUS = 1.1;
const DOT_ALPHA_DARK = 0.09; // resting dots on the dark canvas
const DOT_ALPHA_LIGHT = 0.06; // dark dots on white read stronger, so lighter
const GLYPH_ALPHA_DARK = 0.9; // a fully hot glyph (accent colour)
const GLYPH_ALPHA_LIGHT = 0.65; // Base Blue on white is loud, keep the wake under the text

interface Ring {
  x: number;
  y: number;
  start: number;
}

export function AsciiWake({ className, children, fixed = false }: { className?: string; children?: ReactNode; fixed?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host: HTMLElement | null = fixed ? canvas : wrap.current;
    if (!host || !canvas) return;
    const listenOn: Window | HTMLElement = fixed ? window : host;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let cols = 0;
    let rows = 0;
    let heat = new Float32Array(0);
    let width = 0;
    let height = 0;
    let dpr = 1;
    // The grid is centred, so partial rows and columns sit on every edge and the dots reach the borders.
    let ox = 0;
    let oy = 0;
    let ink = '#fff';
    let accent = '#3c8aff';
    let dotAlpha = DOT_ALPHA_DARK;
    let glyphAlpha = GLYPH_ALPHA_DARK;
    let pointer: { x: number; y: number } | null = null;
    const rings: Ring[] = [];
    let raf = 0;
    let last = 0;

    const readInk = () => {
      const cs = getComputedStyle(canvas);
      ink = cs.color || ink;
      accent = cs.getPropertyValue('--accent').trim() || accent;
      const dark = document.documentElement.classList.contains('dark');
      dotAlpha = dark ? DOT_ALPHA_DARK : DOT_ALPHA_LIGHT;
      glyphAlpha = dark ? GLYPH_ALPHA_DARK : GLYPH_ALPHA_LIGHT;
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = `${CELL}px ${getComputedStyle(canvas).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ink;
      for (let i = 0; i < heat.length; i++) {
        let x = ox + (i % cols) * CELL + CELL / 2;
        let y = oy + Math.floor(i / cols) * CELL + CELL / 2;
        const h = heat[i];
        if (h < 0.08) {
          ctx.fillStyle = ink;
          ctx.globalAlpha = dotAlpha;
          ctx.beginPath();
          ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        if (pointer) {
          const dx = pointer.x - x;
          const dy = pointer.y - y;
          const d = Math.hypot(dx, dy);
          if (d > 0.5 && d < REACH) {
            const f = (1 - d / REACH) ** 2 * PULL;
            x += (dx / d) * f;
            y += (dy / d) * f;
          }
        }
        // The wake is the field's one burst of colour: glyphs are drawn in the accent, dots stay ink.
        ctx.fillStyle = accent;
        ctx.globalAlpha = dotAlpha + (glyphAlpha - dotAlpha) * h;
        const g = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(h * GLYPHS.length))];
        ctx.fillText(g, x, y + 0.5);
      }
      ctx.globalAlpha = 1;
    };

    const layout = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = fixed ? window.innerWidth : host.clientWidth;
      height = fixed ? window.innerHeight : host.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      cols = Math.max(1, Math.ceil(width / CELL));
      rows = Math.max(1, Math.ceil(height / CELL));
      ox = (width - cols * CELL) / 2;
      oy = (height - rows * CELL) / 2;
      heat = new Float32Array(cols * rows);
      readInk();
      draw();
    };

    const warm = (x: number, y: number) => {
      const c0 = Math.max(0, Math.floor((x - ox - REACH) / CELL));
      const c1 = Math.min(cols - 1, Math.ceil((x - ox + REACH) / CELL));
      const r0 = Math.max(0, Math.floor((y - oy - REACH) / CELL));
      const r1 = Math.min(rows - 1, Math.ceil((y - oy + REACH) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const d = Math.hypot(x - (ox + c * CELL + CELL / 2), y - (oy + r * CELL + CELL / 2));
          if (d < REACH) {
            const i = r * cols + c;
            heat[i] = Math.max(heat[i], 1 - d / REACH);
          }
        }
      }
    };

    const step = (now: number) => {
      const dt = last ? Math.min(100, now - last) : 16;
      last = now;
      let hot = false;
      const cool = dt / TRAIL_MS;
      for (let i = 0; i < heat.length; i++) {
        if (heat[i] > 0) {
          heat[i] = Math.max(0, heat[i] - cool);
          if (heat[i] > 0) hot = true;
        }
      }
      for (let k = rings.length - 1; k >= 0; k--) {
        const ring = rings[k];
        const radius = ((now - ring.start) / 1000) * RING_SPEED;
        if (radius > Math.hypot(width, height)) {
          rings.splice(k, 1);
          continue;
        }
        hot = true;
        const lo = Math.max(0, radius - RING_WIDTH);
        const hi = radius + RING_WIDTH;
        for (let i = 0; i < heat.length; i++) {
          const cx = ox + (i % cols) * CELL + CELL / 2;
          const cy = oy + Math.floor(i / cols) * CELL + CELL / 2;
          const dist = Math.hypot(cx - ring.x, cy - ring.y);
          if (dist < lo || dist > hi) continue;
          const d = Math.abs(dist - radius);
          heat[i] = Math.max(heat[i], 1 - d / RING_WIDTH);
        }
      }
      if (pointer) {
        warm(pointer.x, pointer.y);
        hot = true;
      }
      draw();
      raf = hot ? requestAnimationFrame(step) : 0;
      if (!hot) last = 0;
    };

    const wake = () => {
      if (!raf) raf = requestAnimationFrame(step);
    };
    const local = (e: PointerEvent) => {
      const b = canvas.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    };
    const onMove = (e: PointerEvent) => {
      if (reduced) return;
      pointer = local(e);
      wake();
    };
    const onLeave = (e: PointerEvent) => {
      if (fixed && e.relatedTarget) return; // still inside the document
      pointer = null;
      wake();
    };
    const onDown = (e: PointerEvent) => {
      if (reduced) return;
      const p = local(e);
      rings.push({ x: p.x, y: p.y, start: performance.now() });
      wake();
    };

    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(fixed ? document.documentElement : host);
    const mo = new MutationObserver(() => {
      readInk();
      draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    listenOn.addEventListener('pointermove', onMove as EventListener);
    listenOn.addEventListener(fixed ? 'pointerout' : 'pointerleave', onLeave as EventListener);
    listenOn.addEventListener('pointerdown', onDown as EventListener);

    return () => {
      ro.disconnect();
      mo.disconnect();
      listenOn.removeEventListener('pointermove', onMove as EventListener);
      listenOn.removeEventListener(fixed ? 'pointerout' : 'pointerleave', onLeave as EventListener);
      listenOn.removeEventListener('pointerdown', onDown as EventListener);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [fixed]);

  if (fixed) {
    return (
      <canvas
        ref={ref}
        aria-hidden="true"
        data-testid="ascii-wake"
        className={cn('pointer-events-none fixed inset-0 -z-10 block size-full select-none font-mono text-ink', className)}
      />
    );
  }

  return (
    <div ref={wrap} className={cn('relative', className)} data-testid="ascii-wake">
      <canvas ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 block size-full select-none font-mono text-ink" />
      <div className="relative">{children}</div>
    </div>
  );
}
