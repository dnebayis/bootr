'use client';

import type { ReactElement, ReactNode } from 'react';
import { Tooltip as BaseTooltip } from '@base-ui-components/react/tooltip';
import { cn } from './cn';
import { fade, floatSurface } from './surface';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/**
 * Tooltip on Base UI (`@base-ui-components/react/tooltip`). Wraps one focusable element (a
 * `Button`, a link, an icon button): opens on hover and keyboard focus, closes on Escape, is
 * announced via `aria-describedby`. Caption text on canvas, hairline, `rounded-sm`, the floating
 * shadow, no arrow. Keep the content to a short phrase; anything a user must read before acting
 * belongs in the layout, not a tooltip.
 *
 * ```tsx
 * <Tooltip content="Copy address"><Button variant="ghost" size="sm">…</Button></Tooltip>
 * ```
 *
 * Optional: wrap a page in `TooltipProvider` so neighbouring tooltips share one delay and skip
 * the wait when the pointer moves from one trigger to the next.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  delay = 400,
  disabled,
  className,
}: {
  content: ReactNode;
  /** The trigger. Must accept a ref and DOM event props (Button, LinkButton, a plain element). */
  children: ReactElement<Record<string, unknown>>;
  side?: TooltipSide;
  align?: 'start' | 'center' | 'end';
  /** Hover delay before opening, ms. */
  delay?: number;
  disabled?: boolean;
  /** Extra classes for the popup. */
  className?: string;
}) {
  return (
    <BaseTooltip.Root disabled={disabled || content == null || content === ''}>
      <BaseTooltip.Trigger render={children} delay={delay} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} align={align} sideOffset={6} className="z-50 outline-none">
          <BaseTooltip.Popup className={cn('max-w-64 rounded-sm px-2 py-1 text-caption text-ink', floatSurface, fade, className)}>{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/** Groups the tooltips below it so they share `delay` and open instantly when moving between triggers. */
export function TooltipProvider({ children, delay = 400, closeDelay = 0 }: { children: ReactNode; delay?: number; closeDelay?: number }) {
  return (
    <BaseTooltip.Provider delay={delay} closeDelay={closeDelay}>
      {children}
    </BaseTooltip.Provider>
  );
}
