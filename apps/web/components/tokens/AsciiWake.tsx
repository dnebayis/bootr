'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

/**
 * A background field of faint ink dots on a character grid, behind whatever it wraps (the home page's title
 * block). The pointer drags a wake through it: cells near the hand turn into ASCII glyphs that thicken with
 * the heat (`.` `:` `-` `=` `+` `*` `#`) and drift a little toward the pointer, then cool back to dots behind
 * it over `TRAIL_MS`. A press (or tap) sends a ring out.
 *
 * Canvas only, no DOM per cell, idle when nothing is hot (no animation frame), redraws on resize and theme
 * change, static under `prefers-reduced-motion`. Decorative: the canvas is `aria-hidden` and sits behind the
 * children; pointer events are read on the wrapper so hovering the text wakes the field too, and nothing
 * blocks scrolling or selection.
 */

const CELL = 12; // px per grid cell = the mono font size
const REACH = 72; // px: how far from the pointer cells heat up
const TRAIL_MS = 1200; // cooling time from full heat back to a dot
const PULL = 10; // px: max drift of a cell toward the pointer
const RING_SPEED = 480; // px/s
const RING_WIDTH = 28; // px
const GLYPHS = ['.', ':', '-', '=', '+', '*', '#'];
const DOT_RADIUS = 1.1;
const DOT_ALPHA = 0.28;

interface Ring {
  x: number;
  y: number;
  start: number;
}

export function AsciiWake({ className, children }: { className?: string; children?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = wrap.current;
    const canvas = ref.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let cols = 0;
    let rows = 0;
    let heat = new Float32Array(0);
    let width = 0;
    let height = 0;
    let dpr = 1;
    let ink = '#fff';
    let pointer: { x: number; y: number } | null = null;
    const rings: Ring[] = [];
    let raf = 0;
    let last = 0;

    const readInk = () => {
      ink = getComputedStyle(canvas).color || ink;
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = `${CELL}px ${getComputedStyle(canvas).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ink;
      for (let i = 0; i < heat.length; i++) {
        let x = (i % cols) * CELL + CELL / 2;
        let y = Math.floor(i / cols) * CELL + CELL / 2;
        const h = heat[i];
        if (h < 0.08) {
          ctx.globalAlpha = DOT_ALPHA;
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
        ctx.globalAlpha = DOT_ALPHA + (1 - DOT_ALPHA) * h;
        const g = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(h * GLYPHS.length))];
        ctx.fillText(g, x, y + 0.5);
      }
      ctx.globalAlpha = 1;
    };

    const layout = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = host.clientWidth;
      height = host.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      cols = Math.max(1, Math.ceil(width / CELL));
      rows = Math.max(1, Math.ceil(height / CELL));
      heat = new Float32Array(cols * rows);
      readInk();
      draw();
    };

    const warm = (x: number, y: number) => {
      const c0 = Math.max(0, Math.floor((x - REACH) / CELL));
      const c1 = Math.min(cols - 1, Math.ceil((x + REACH) / CELL));
      const r0 = Math.max(0, Math.floor((y - REACH) / CELL));
      const r1 = Math.min(rows - 1, Math.ceil((y + REACH) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const d = Math.hypot(x - (c * CELL + CELL / 2), y - (r * CELL + CELL / 2));
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
          const cx = (i % cols) * CELL + CELL / 2;
          const cy = Math.floor(i / cols) * CELL + CELL / 2;
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
    const onLeave = () => {
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
    ro.observe(host);
    const mo = new MutationObserver(() => {
      readInk();
      draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('pointerdown', onDown);

    return () => {
      ro.disconnect();
      mo.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('pointerdown', onDown);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={wrap} className={cn('relative', className)} data-testid="ascii-wake">
      <canvas ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 block size-full select-none font-mono text-ink" />
      <div className="relative">{children}</div>
    </div>
  );
}
