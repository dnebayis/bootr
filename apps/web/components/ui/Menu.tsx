'use client';

import type { ReactElement, ReactNode, RefObject } from 'react';
import Link from 'next/link';
import { Menu as BaseMenu } from '@base-ui-components/react/menu';
import { cn } from './cn';
import { fade, floatSurface } from './surface';

/**
 * Dropdown menu on Base UI (`@base-ui-components/react/menu`): `role="menu"` / `menuitem`, typeahead,
 * arrow keys, closes on Escape / outside press / item press, returns focus to the trigger. Popup
 * per DESIGN.md: canvas, hairline, radius `md`, 4px padding, the floating shadow; items are 32px
 * rows, `canvas-sub` when highlighted, no accent anywhere (a menu holds no primary action).
 *
 * ```tsx
 * <Menu trigger={<Button variant="ghost" size="sm">More</Button>}>
 *   <MenuItem onClick={copy}>Copy address</MenuItem>
 *   <MenuItem href={`/t/${slug}`}>Open coin</MenuItem>
 *   <MenuSeparator />
 *   <MenuItem destructive onClick={pause}>Pause agent</MenuItem>
 * </Menu>
 * ```
 */
export function Menu({
  trigger,
  children,
  side = 'bottom',
  align = 'end',
  open,
  onOpenChange,
  className,
  container,
  'aria-label': ariaLabel,
}: {
  /** The opener; must accept a ref and DOM event props (`Button` does). */
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode;
  /** Preferred side and alignment; the popup flips and shifts on its own to stay inside the viewport. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the popup (width, for example). */
  className?: string;
  /**
   * Where the popup is portalled; `<body>` by default. Pass the content element of a modal layer
   * (the mobile drawer) when the trigger sits inside one, so the popup stays inside that layer's
   * focus trap and outside-press detection instead of being treated as a press outside the layer.
   */
  container?: HTMLElement | null | RefObject<HTMLElement | null>;
  /** Accessible name for the popup, for a menu whose items are not self-explanatory as a set. */
  'aria-label'?: string;
}) {
  return (
    <BaseMenu.Root open={open} onOpenChange={(o) => onOpenChange?.(o)} modal={false}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal container={container}>
        <BaseMenu.Positioner side={side} align={align} sideOffset={6} className="z-50 outline-none">
          <BaseMenu.Popup aria-label={ariaLabel} className={cn('min-w-48 rounded-md p-1 outline-none', floatSurface, fade, className)}>
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

const itemClass =
  'flex h-8 w-full cursor-default select-none items-center gap-2 rounded-sm px-2 text-sm text-ink outline-none data-highlighted:bg-canvas-sub data-disabled:opacity-50';

/** One action. With `href` it renders a link (internal via `next/link`, external in a new tab). `destructive` sets `negative-text`. */
export function MenuItem({
  children,
  onClick,
  href,
  disabled,
  destructive,
  closeOnClick = true,
  className,
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  destructive?: boolean;
  closeOnClick?: boolean;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
  /** Any other `data-*` hook for tests and styling (`data-connector`, for example). */
  [data: `data-${string}`]: string | undefined;
}) {
  const cls = cn(itemClass, destructive && 'text-negative-text', className);
  const render = href ? (
    /^https?:/.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer" />
    ) : (
      <Link href={href} />
    )
  ) : undefined;
  return (
    <BaseMenu.Item render={render} onClick={onClick} disabled={disabled} closeOnClick={closeOnClick} className={cls} {...rest}>
      {children}
    </BaseMenu.Item>
  );
}

/** Hairline between item groups. */
export function MenuSeparator({ className }: { className?: string }) {
  return <BaseMenu.Separator className={cn('my-1 h-px bg-hairline', className)} />;
}

/** A labelled run of items; the label is caption `mute`. */
export function MenuGroup({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <BaseMenu.Group className={className}>
      <BaseMenu.GroupLabel className="px-2 py-1 text-caption text-mute">{label}</BaseMenu.GroupLabel>
      {children}
    </BaseMenu.Group>
  );
}
