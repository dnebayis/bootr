'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/components/ui/cn';

/**
 * The Bootr mark drawn in ink dots on a character grid. The pointer drags a wake through it: cells under the
 * hand turn into ASCII glyphs that thicken with the heat (`.` `:` `-` `=` `+` `*` `#`) and are pulled a little
 * toward the pointer, then cool back to dots behind it over `TRAIL_MS`. A press (or tap) sends a ring out.
 *
 * Canvas only, no DOM per cell. Idle when nothing is hot (no animation frame), redraws on resize and theme
 * change, static dots under `prefers-reduced-motion`. Decorative: `aria-hidden`, pointer events never block
 * scrolling (`touch-action: pan-y`).
 */

const CELL = 10; // px per grid cell = the mono font size
const REACH = 60; // px: how far from the pointer cells heat up
const TRAIL_MS = 1200; // cooling time from full heat back to a dot
const PULL = 14; // px: max displacement of a cell toward the pointer
const RING_SPEED = 420; // px/s
const RING_WIDTH = 26; // px
const GLYPHS = ['.', ':', '-', '=', '+', '*', '#'];
const DOT_RADIUS = 1.7;

interface Ring {
  x: number;
  y: number;
  start: number;
}

/** Samples the mark (components/brand/Mark.tsx, 24-unit grid) at cell centres: true where the ink is. */
function buildMask(cols: number, rows: number, size: number, originX: number, originY: number): Uint8Array<ArrayBuffer> {
  const off = document.createElement('canvas');
  off.width = cols;
  off.height = rows;
  const g = off.getContext('2d');
  const mask = new Uint8Array(cols * rows);
  if (!g) return mask;
  const u = size / 24; // one mark unit in cells
  const r = 5 * u;
  const sx = originX;
  const sy = originY;
  g.fillStyle = '#000';
  g.beginPath();
  g.roundRect(sx, sy, 24 * u, 24 * u, r);
  g.fill();
  // Knock the power glyph out (the two strokes of Mark.tsx, 2.5 units wide).
  g.globalCompositeOperation = 'destination-out';
  g.strokeStyle = '#000';
  g.lineWidth = 2.5 * u;
  g.lineCap = 'square';
  g.beginPath();
  g.moveTo(sx + 12 * u, sy + 4.75 * u);
  g.lineTo(sx + 12 * u, sy + 12 * u);
  g.stroke();
  g.beginPath();
  g.moveTo(sx + 8.75 * u, sy + 7.75 * u);
  g.lineTo(sx + 6.75 * u, sy + 7.75 * u);
  g.lineTo(sx + 6.75 * u, sy + 17.25 * u);
  g.lineTo(sx + 17.25 * u, sy + 17.25 * u);
  g.lineTo(sx + 17.25 * u, sy + 7.75 * u);
  g.lineTo(sx + 15.25 * u, sy + 7.75 * u);
  g.stroke();
  const data = g.getImageData(0, 0, cols, rows).data;
  for (let i = 0; i < cols * rows; i++) mask[i] = data[i * 4 + 3] > 96 ? 1 : 0;
  return mask;
}

export function AsciiWake({ className, height = 256 }: { className?: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let cols = 0;
    let rows = 0;
    let mask: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    let heat = new Float32Array(0);
    let width = 0;
    let dpr = 1;
    let ink = '#fff';
    let pointer: { x: number; y: number } | null = null;
    const rings: Ring[] = [];
    let raf = 0;
    let last = 0;

    const readInk = () => {
      ink = getComputedStyle(canvas).color || ink;
    };

    const layout = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      cols = Math.max(1, Math.floor(width / CELL));
      rows = Math.max(1, Math.floor(height / CELL));
      heat = new Float32Array(cols * rows);
      // The mark takes most of the band's height, centred.
      const size = Math.max(8, rows - 4); // in cells
      const originX = (cols - size) / 2;
      const originY = (rows - size) / 2;
      mask = buildMask(cols, rows, size, originX, originY);
      readInk();
      draw();
    };

    const cellCentre = (i: number) => {
      const cx = (i % cols) * CELL + CELL / 2;
      const cy = Math.floor(i / cols) * CELL + CELL / 2;
      return [cx, cy] as const;
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = `${CELL}px ${getComputedStyle(canvas).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        let [x, y] = cellCentre(i);
        const h = heat[i];
        if (pointer && h > 0) {
          const dx = pointer.x - x;
          const dy = pointer.y - y;
          const d = Math.hypot(dx, dy);
          if (d > 0.5 && d < REACH) {
            const f = (1 - d / REACH) ** 2 * PULL;
            x += (dx / d) * f;
            y += (dy / d) * f;
          }
        }
        if (h < 0.08) {
          ctx.globalAlpha = 0.82;
          ctx.fillStyle = ink;
          ctx.beginPath();
          ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = ink;
        const g = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(h * GLYPHS.length))];
        ctx.fillText(g, x, y + 0.5);
      }
      ctx.globalAlpha = 1;
    };

    const warm = (x: number, y: number) => {
      const c0 = Math.max(0, Math.floor((x - REACH) / CELL));
      const c1 = Math.min(cols - 1, Math.ceil((x + REACH) / CELL));
      const r0 = Math.max(0, Math.floor((y - REACH) / CELL));
      const r1 = Math.min(rows - 1, Math.ceil((y + REACH) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = r * cols + c;
          if (!mask[i]) continue;
          const d = Math.hypot(x - (c * CELL + CELL / 2), y - (r * CELL + CELL / 2));
          if (d < REACH) heat[i] = Math.max(heat[i], 1 - d / REACH);
        }
      }
    };

    const step = (now: number) => {
      const dt = last ? Math.min(100, now - last) : 16;
      last = now;
      let hot = false;
      // Cool every cell toward a dot.
      const cool = dt / TRAIL_MS;
      for (let i = 0; i < heat.length; i++) {
        if (heat[i] > 0) {
          heat[i] = Math.max(0, heat[i] - cool);
          if (heat[i] > 0) hot = true;
        }
      }
      // Rings heat the cells they pass over.
      for (let k = rings.length - 1; k >= 0; k--) {
        const ring = rings[k];
        const radius = ((now - ring.start) / 1000) * RING_SPEED;
        if (radius > Math.hypot(width, height)) {
          rings.splice(k, 1);
          continue;
        }
        hot = true;
        for (let i = 0; i < mask.length; i++) {
          if (!mask[i]) continue;
          const [cx, cy] = cellCentre(i);
          const d = Math.abs(Math.hypot(cx - ring.x, cy - ring.y) - radius);
          if (d < RING_WIDTH) heat[i] = Math.max(heat[i], 1 - d / RING_WIDTH);
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
    ro.observe(canvas);
    const mo = new MutationObserver(() => {
      readInk();
      draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown);

    return () => {
      ro.disconnect();
      mo.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [height]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-testid="ascii-wake"
      style={{ height, touchAction: 'pan-y' }}
      className={cn('block w-full select-none font-mono text-ink', className)}
    />
  );
}
