'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { Token } from '@/lib/types';
import { useNow } from '@/lib/hooks';
import { CARD_HEIGHT, TokenCard } from './TokenCard';

const GAP = 12;
const VIRTUALIZE_AFTER = 60;

function columnsFor(width: number) {
  if (width >= 1200) return 4;
  if (width >= 880) return 3;
  if (width >= 560) return 2;
  return 1;
}

/** Tracks ids that appeared after the first render so new launches can flash once. */
function useFreshIds(tokens: Token[], resetKey: string) {
  const seen = useRef<Set<string> | null>(null);
  const key = useRef(resetKey);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (key.current !== resetKey || seen.current === null) {
      key.current = resetKey;
      seen.current = new Set(tokens.map((t) => t.id));
      return;
    }
    const added = tokens.filter((t) => !seen.current!.has(t.id)).map((t) => t.id);
    if (added.length === 0) return;
    added.forEach((id) => seen.current!.add(id));
    setFresh(new Set(added));
    const timer = setTimeout(() => setFresh(new Set()), 1200);
    return () => clearTimeout(timer);
  }, [tokens, resetKey]);
  return fresh;
}

export function TokenGrid({ tokens, resetKey }: { tokens: Token[]; resetKey: string }) {
  const now = useNow();
  const fresh = useFreshIds(tokens, resetKey);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      setOffset(el.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const virtual = tokens.length > VIRTUALIZE_AFTER;
  const cols = columnsFor(width);
  const rows = useMemo(() => {
    const out: Token[][] = [];
    for (let i = 0; i < tokens.length; i += cols) out.push(tokens.slice(i, i + cols));
    return out;
  }, [tokens, cols]);

  const virtualizer = useWindowVirtualizer({
    count: virtual ? rows.length : 0,
    estimateSize: () => CARD_HEIGHT + GAP,
    overscan: 4,
    scrollMargin: offset,
  });

  if (!virtual) {
    return (
      <div ref={containerRef}>
        {/* motion handles reordering only (layout); entering uses a CSS keyframe so a card is never left
            invisible in a background tab where requestAnimationFrame-driven animations do not run. */}
        <ul className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {tokens.map((t) => (
            <motion.li
              key={t.id}
              layout="position"
              className={fresh.has(t.id) ? 'animate-enter' : undefined}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            >
              <TokenCard token={t} now={now} flash={fresh.has(t.id)} />
            </motion.li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => (
          <ul
            key={row.key}
            className="absolute inset-x-0 top-0 grid gap-3"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {rows[row.index]!.map((t) => (
              <motion.li key={t.id} layout="position" transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
                <TokenCard token={t} now={now} flash={fresh.has(t.id)} />
              </motion.li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}
