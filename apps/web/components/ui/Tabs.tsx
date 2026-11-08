'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { Tabs as BaseTabs } from '@base-ui-components/react/tabs';
import { cn } from './cn';
import { focusRing } from './surface';

/**
 * Tabs on Base UI (`@base-ui-components/react/tabs`): `role="tablist"` / `role="tab"` /
 * `aria-selected`, arrow-key navigation, panels wired by `aria-controls`.
 *
 * Two looks, both from DESIGN.md:
 * - `segment` (default): the Activity tape filter. Hairline box, `p-0.5`, mono micro labels, the
 *   selected tab is `bg-ink text-on-ink`.
 * - `underline`: text tabs with a 1px ink underline on the active item (page-level tabs).
 *
 * `Tab` styles its selected state from Base UI's `data-active` attribute. Panels are optional: a
 * filter that only changes a query (the tape) uses `Tabs` + `TabList` + `Tab` alone.
 *
 * ```tsx
 * <Tabs value={filter} onValueChange={setFilter}>
 *   <TabList aria-label="Activity filter">
 *     <Tab value="all">All</Tab>
 *     <Tab value="posts" count={12}>Posts</Tab>
 *   </TabList>
 * </Tabs>
 * ```
 */
export function Tabs<T extends string | number = string>({
  value,
  defaultValue,
  onValueChange,
  orientation,
  className,
  children,
}: {
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  children: ReactNode;
}) {
  return (
    <BaseTabs.Root value={value} defaultValue={defaultValue} onValueChange={(v) => onValueChange?.(v as T)} orientation={orientation} className={className}>
      {children}
    </BaseTabs.Root>
  );
}

export type TabListVariant = 'segment' | 'underline' | 'rail';

const VariantContext = createContext<TabListVariant>('segment');

const lists: Record<TabListVariant, string> = {
  segment: 'inline-flex rounded-sm border border-hairline p-0.5',
  underline: 'flex border-b border-hairline',
  // The dense underline strip on a phone; from `lg` a vertical rail of rows (the creator console page).
  rail: 'flex gap-2 overflow-x-auto border-b border-hairline [scrollbar-width:none] lg:flex-col lg:gap-0.5 lg:overflow-visible lg:border-b-0',
};

/** The space between underline tabs: 16px, or 8px (`dense`) where six tabs must fit a 320px column. */
const underlineGaps = { regular: 'gap-4', dense: 'gap-2' } as const;

const underlineTab = 'relative -mb-px h-9 px-0.5 text-sm text-mute hover:text-ink data-active:text-ink data-active:shadow-[inset_0_-1px_0_var(--ink)]';

const tabs: Record<TabListVariant, string> = {
  segment:
    'h-6 rounded-xs px-2 font-mono text-micro text-mute hover:text-ink data-active:bg-ink data-active:text-on-ink data-active:hover:text-on-ink',
  underline: underlineTab,
  // Rail rows: `canvas-sub` fill and a 2px ink bar on the left for the active one (the ⌘K selection, in ink).
  rail: `${underlineTab} lg:mb-0 lg:h-8 lg:w-full lg:justify-start lg:rounded-sm lg:px-2.5 lg:hover:bg-canvas-sub lg:data-active:bg-canvas-sub lg:data-active:shadow-[inset_2px_0_0_var(--ink)]`,
};

/** The `role="tablist"` container. Give it an `aria-label`. `dense` tightens the gap of underline tabs (the creator console's six tabs). */
export function TabList({ className, children, variant = 'segment', dense, ...rest }: { 'aria-label'?: string; className?: string; children: ReactNode; variant?: TabListVariant; dense?: boolean }) {
  return (
    <VariantContext.Provider value={variant}>
      <BaseTabs.List className={cn(lists[variant], variant === 'underline' && underlineGaps[dense ? 'dense' : 'regular'], className)} data-variant={variant} {...rest}>
        {children}
      </BaseTabs.List>
    </VariantContext.Provider>
  );
}

/** One tab. `count` renders in mono `mute` after the label (DESIGN.md "Counts in mono mute"). */
export function Tab({ value, children, count, className, disabled }: { value: string | number; children: ReactNode; count?: ReactNode; className?: string; disabled?: boolean }) {
  const variant = useContext(VariantContext);
  return (
    <BaseTabs.Tab
      value={value}
      disabled={disabled}
      className={cn(
        'group inline-flex shrink-0 select-none items-center gap-1 whitespace-nowrap transition-colors duration-150 disabled:opacity-50',
        focusRing,
        tabs[variant],
        className,
      )}
    >
      {children}
      {count !== undefined ? <span className={cn('font-mono tabular text-mute', variant === 'segment' && 'group-data-active:text-on-ink/70', variant === 'rail' && 'lg:ml-auto')}>{count}</span> : null}
    </BaseTabs.Tab>
  );
}

/** The content for one tab value. Unmounted while inactive unless `keepMounted`. */
export function TabPanel({ value, children, className, keepMounted }: { value: string | number; children: ReactNode; className?: string; keepMounted?: boolean }) {
  return (
    <BaseTabs.Panel value={value} keepMounted={keepMounted} className={cn('outline-none', className)}>
      {children}
    </BaseTabs.Panel>
  );
}
