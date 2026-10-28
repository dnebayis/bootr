'use client';

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Curve, Event as VxEvent, Scale, Shape } from '@visx/visx';
import { cn } from '@/components/ui/cn';

/**
 * Bootr chart kit (visx + CSS keyframes, see .chart-* in globals.css).
 * Palette comes from CSS tokens (fill-chart-1, fill-chart-2..4, accent for the hovered datum)
 * so light/dark switch at paint time without re-rendering. No gridlines: one baseline, three x labels, a max label.
 */

const M = { top: 20, right: 8, bottom: 22, left: 8 };

export type Point = { x: string; y: number };

type Hover = { i: number; left: number };

function useHover(n: number, innerW: number) {
  const [hover, setHover] = useState<Hover | null>(null);
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const p = VxEvent.localPoint(e);
    if (!p || n === 0) return;
    const x = Math.max(0, Math.min(innerW, p.x - M.left));
    const i = Math.max(0, Math.min(n - 1, Math.round((x / innerW) * (n - 1))));
    setHover({ i, left: p.x });
  };
  return { hover, onMove, onLeave: () => setHover(null) };
}

function Tooltip({ left, width, children }: { left: number; width: number; children: ReactNode }) {
  const flip = left > width - 160;
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-sm border border-hairline bg-canvas px-2.5 py-1.5 shadow-[0_8px_16px_-4px_#0000001a]"
      style={{ left: flip ? undefined : left + 12, right: flip ? width - left + 12 : undefined }}
    >
      {children}
    </div>
  );
}

function XLabels({ labels, innerW, innerH }: { labels: string[]; innerW: number; innerH: number }) {
  if (labels.length === 0) return null;
  const picks = [0, Math.floor((labels.length - 1) / 2), labels.length - 1];
  return (
    <g>
      {picks.map((idx, k) => (
        <text
          key={k}
          x={labels.length === 1 ? 0 : (idx / (labels.length - 1)) * innerW}
          y={innerH + 16}
          textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}
          className="fill-mute font-mono text-[10px]"
        >
          {labels[idx]}
        </text>
      ))}
    </g>
  );
}

/**
 * Measures its own width. Not visx `useParentSize`: that defers measurement to
 * requestAnimationFrame, which never runs in a background tab, leaving charts at width 0.
 * A layout-effect read works without a frame; the ResizeObserver handles later resizes.
 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function Frame({ height, children }: { height: number; children: (w: number) => ReactNode }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? children(width) : null}
    </div>
  );
}

/** Area or line time-series with crosshair. */
export function SeriesChart({
  data,
  kind = 'area',
  height = 200,
  format,
  labelFormat = (x) => x,
  label,
}: {
  data: Point[];
  kind?: 'area' | 'line';
  height?: number;
  format: (n: number) => string;
  labelFormat?: (x: string) => string;
  label: string;
}) {
  return (
    <Frame height={height}>
      {(width) => <SeriesInner data={data} kind={kind} width={width} height={height} format={format} labelFormat={labelFormat} label={label} />}
    </Frame>
  );
}

function SeriesInner({
  data,
  kind,
  width,
  height,
  format,
  labelFormat,
  label,
}: {
  data: Point[];
  kind: 'area' | 'line';
  width: number;
  height: number;
  format: (n: number) => string;
  labelFormat: (x: string) => string;
  label: string;
}) {
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const max = Math.max(1, ...data.map((d) => d.y));
  const x = useMemo(() => Scale.scaleLinear({ domain: [0, Math.max(1, data.length - 1)], range: [0, innerW] }), [data.length, innerW]);
  const y = useMemo(() => Scale.scaleLinear({ domain: [0, max * 1.08], range: [innerH, 0], nice: false }), [max, innerH]);
  const { hover, onMove, onLeave } = useHover(data.length, innerW);
  const h = hover ? data[hover.i] : null;

  return (
    <>
      <svg width={width} height={height} role="img" aria-label={label}>
        <g transform={`translate(${M.left},${M.top})`}>
          <text x={0} y={-8} className="fill-mute font-mono text-[10px]">
            {format(max)}
          </text>
          <line x1={0} x2={innerW} y1={innerH + 0.5} y2={innerH + 0.5} className="stroke-hairline" />
          <g>
            {kind === 'area' ? (
              <Shape.AreaClosed
                data={data}
                x={(_, i) => x(i)}
                y={(d) => y(d.y)}
                yScale={y}
                curve={Curve.curveMonotoneX}
                className="chart-fade fill-chart-1"
                fillOpacity={0.08}
              />
            ) : null}
            <Shape.LinePath
              data={data}
              x={(_, i) => x(i)}
              y={(d) => y(d.y)}
              curve={Curve.curveMonotoneX}
              className="chart-draw stroke-chart-1"
              strokeWidth={1.5}
              fill="none"
              pathLength={1}
            />
          </g>
          <XLabels labels={data.map((d) => labelFormat(d.x))} innerW={innerW} innerH={innerH} />
          {hover && h ? (
            <g pointerEvents="none">
              <line x1={x(hover.i)} x2={x(hover.i)} y1={0} y2={innerH} className="stroke-hairline-strong" strokeDasharray="2 2" />
              <circle cx={x(hover.i)} cy={y(h.y)} r={3.5} className="fill-accent stroke-canvas" strokeWidth={2} />
            </g>
          ) : null}
          <rect width={innerW} height={innerH} fill="transparent" onPointerMove={onMove} onPointerLeave={onLeave} />
        </g>
      </svg>
      {hover && h ? (
        <Tooltip left={hover.left} width={width}>
          <div className="font-mono text-micro text-mute">{labelFormat(h.x)}</div>
          <div className="font-mono text-sm text-ink tabular">{format(h.y)}</div>
        </Tooltip>
      ) : null}
    </>
  );
}

/** Vertical bars (one series). */
export function BarsChart({ data, height = 200, format, labelFormat = (x) => x, label }: { data: Point[]; height?: number; format: (n: number) => string; labelFormat?: (x: string) => string; label: string }) {
  return (
    <Frame height={height}>
      {(width) => {
        const innerW = width - M.left - M.right;
        const innerH = height - M.top - M.bottom;
        return (
          <StackInner
            width={width}
            height={height}
            innerW={innerW}
            innerH={innerH}
            rows={data.map((d) => ({ x: d.x, parts: [d.y] }))}
            seriesClass={['fill-chart-1']}
            seriesLabels={[label]}
            format={format}
            labelFormat={labelFormat}
            label={label}
          />
        );
      }}
    </Frame>
  );
}

/** Stacked bars, bottom-up in the order of `keys`. */
export function StackedBarsChart<K extends string>({
  data,
  keys,
  labels,
  height = 220,
  format,
  labelFormat = (x) => x,
  label,
}: {
  data: ({ x: string } & Record<K, number>)[];
  keys: K[];
  labels: Record<K, string>;
  height?: number;
  format: (n: number) => string;
  labelFormat?: (x: string) => string;
  label: string;
}) {
  const classes = ['fill-chart-1', 'fill-chart-2', 'fill-chart-3', 'fill-chart-4'];
  return (
    <Frame height={height}>
      {(width) => (
        <StackInner
          width={width}
          height={height}
          innerW={width - M.left - M.right}
          innerH={height - M.top - M.bottom}
          rows={data.map((d) => ({ x: d.x, parts: keys.map((k) => d[k]) }))}
          seriesClass={classes}
          seriesLabels={keys.map((k) => labels[k])}
          format={format}
          labelFormat={labelFormat}
          label={label}
        />
      )}
    </Frame>
  );
}

function StackInner({
  width,
  height,
  innerW,
  innerH,
  rows,
  seriesClass,
  seriesLabels,
  format,
  labelFormat,
  label,
}: {
  width: number;
  height: number;
  innerW: number;
  innerH: number;
  rows: { x: string; parts: number[] }[];
  seriesClass: string[];
  seriesLabels: string[];
  format: (n: number) => string;
  labelFormat: (x: string) => string;
  label: string;
}) {
  const totals = rows.map((r) => r.parts.reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const band = Scale.scaleBand({ domain: rows.map((_, i) => i), range: [0, innerW], padding: 0.25 });
  const y = Scale.scaleLinear({ domain: [0, max * 1.08], range: [innerH, 0] });
  const { hover, onMove, onLeave } = useHover(rows.length, innerW);
  const bw = Math.max(1, band.bandwidth());

  return (
    <>
      <svg width={width} height={height} role="img" aria-label={label}>
        <g transform={`translate(${M.left},${M.top})`}>
          <text x={0} y={-8} className="fill-mute font-mono text-[10px]">
            {format(max)}
          </text>
          {rows.map((r, i) => {
            let acc = 0;
            const x0 = band(i) ?? 0;
            const dim = hover && hover.i !== i;
            return (
              <g
                key={r.x}
                className="chart-grow-y transition-opacity duration-150"
                style={{ opacity: dim ? 0.45 : 1, ['--chart-delay' as string]: `${Math.min(200, i * 3)}ms` }}
              >
                {r.parts.map((v, k) => {
                  const top = y(acc + v);
                  const hgt = y(acc) - top;
                  acc += v;
                  if (hgt <= 0) return null;
                  return <rect key={k} x={x0} y={top} width={bw} height={hgt} className={hover?.i === i && r.parts.length === 1 ? 'fill-accent' : seriesClass[k]} />;
                })}
              </g>
            );
          })}
          <line x1={0} x2={innerW} y1={innerH + 0.5} y2={innerH + 0.5} className="stroke-hairline" />
          <g transform={`translate(${bw / 2},0)`}>
            <XLabels labels={rows.map((r) => labelFormat(r.x))} innerW={innerW - bw} innerH={innerH} />
          </g>
          <rect width={innerW} height={innerH} fill="transparent" onPointerMove={onMove} onPointerLeave={onLeave} />
        </g>
      </svg>
      {hover && rows[hover.i] ? (
        <Tooltip left={hover.left} width={width}>
          <div className="font-mono text-micro text-mute">{labelFormat(rows[hover.i]!.x)}</div>
          {rows[hover.i]!.parts.length > 1 ? (
            <dl className="mt-1 flex flex-col gap-0.5">
              {rows[hover.i]!.parts.map((v, k) => (
                <div key={k} className="flex items-center justify-between gap-4 text-caption">
                  <dt className="flex items-center gap-1.5 text-mute">
                    <svg width="8" height="8" aria-hidden="true">
                      <rect width="8" height="8" rx="2" className={seriesClass[k]} />
                    </svg>
                    {seriesLabels[k]}
                  </dt>
                  <dd className="font-mono text-ink tabular">{format(v)}</dd>
                </div>
              ))}
              <div className="mt-0.5 flex justify-between gap-4 border-t border-hairline pt-0.5 text-caption">
                <dt className="text-mute">Total</dt>
                <dd className="font-mono text-ink tabular">{format(totals[hover.i]!)}</dd>
              </div>
            </dl>
          ) : (
            <div className="font-mono text-sm text-ink tabular">{format(rows[hover.i]!.parts[0]!)}</div>
          )}
        </Tooltip>
      ) : null}
    </>
  );
}

/** Horizontal ranked bars with inline labels. */
export function HBarsChart({ items, format, max: maxProp }: { items: { label: string; sub?: string; value: number; href?: string }[]; format: (n: number) => string; max?: number }) {
  const max = maxProp ?? Math.max(1, ...items.map((i) => i.value));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <ol className="flex flex-col gap-2">
      {items.map((it, i) => (
        <li key={it.label + i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)_56px] items-center gap-3">
          <span className="truncate text-sm text-ink">
            {it.href ? (
              <a href={it.href} className="hover:text-link">
                {it.label}
              </a>
            ) : (
              it.label
            )}
            {it.sub ? <span className="ml-1.5 font-mono text-caption text-mute">{it.sub}</span> : null}
          </span>
          <span className="h-2 overflow-hidden rounded-[2px] bg-canvas-sub">
            <span
              className={cn('chart-grow-x block h-full transition-colors duration-150', hover === i ? 'bg-accent' : 'bg-chart-1')}
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, it.value / max))})`, ['--chart-delay' as string]: `${i * 20}ms` }}
            />
          </span>
          <span className="text-right font-mono text-caption text-ink tabular">{format(it.value)}</span>
        </li>
      ))}
    </ol>
  );
}

export function Legend({ items }: { items: { label: string; className: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5 text-caption text-mute">
          <span className={cn('size-2 rounded-[2px]', it.className)} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
