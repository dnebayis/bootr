'use client';

import { forwardRef, useMemo, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';
import { Select as BaseSelect } from '@base-ui-components/react/select';
import { Switch as BaseSwitch } from '@base-ui-components/react/switch';
import { cn } from './cn';
import { CheckIcon, ChevronDownIcon } from './Icons';
import { fade, floatSurface } from './surface';
import { findOption, selectEntries, type SelectEntry, type SelectGroup, type SelectOption } from './select-options';

export type { SelectGroup, SelectOption } from './select-options';

const control =
  'w-full rounded-sm border border-hairline bg-canvas text-ink placeholder:text-mute transition-colors duration-150 hover:border-hairline-strong focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-50 aria-invalid:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { suffix?: ReactNode; mono?: boolean; inputSize?: 'md' | 'lg' }>(
  function Input({ className, suffix, mono, inputSize = 'md', ...rest }, ref) {
    const h = inputSize === 'lg' ? 'h-10' : 'h-8';
    if (!suffix) return <input ref={ref} className={cn(control, h, 'px-3 text-sm', mono && 'font-mono tabular', className)} {...rest} />;
    return (
      <div className={cn('relative', className)}>
        <input ref={ref} className={cn(control, h, 'pl-3 pr-16 text-sm', mono && 'font-mono tabular')} {...rest} />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-caption text-mute">{suffix}</span>
      </div>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(control, 'min-h-24 px-3 py-2 text-sm leading-5', className)} {...rest} />;
});

/** The change event `Select` hands to `onChange`: the subset of a native select change event that callers read. */
export type SelectChangeEvent = { type: string; target: { value: string; name?: string }; currentTarget: { value: string; name?: string } };

export type SelectProps = Omit<HTMLAttributes<HTMLElement>, 'onChange' | 'defaultValue'> & {
  value?: string;
  defaultValue?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  form?: string;
  autoComplete?: string;
  /** Native-shaped handler, so `(e) => e.target.value` keeps working. */
  onChange?: (event: SelectChangeEvent) => void;
  /** Same change, as a plain value. */
  onValueChange?: (value: string) => void;
  /** Loose options. Alternative to native `<option>` children. */
  options?: SelectOption[];
  /** Labelled groups. Alternative to native `<optgroup>` children. Wins over `options`. */
  groups?: SelectGroup[];
  /** Shown in the trigger while nothing is selected. */
  placeholder?: ReactNode;
  /** 32px (md, default) or 40px (lg). */
  selectSize?: 'md' | 'lg';
  /** Escape hatch: render the plain native `<select>` (same props, same children) instead of the Base UI popup. */
  native?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

/**
 * Select on Base UI (`@base-ui-components/react/select`). Same call shape as before: `id`, `value`,
 * `onChange(e)` with `e.target.value`, `disabled`, `name`, and native `<option>` / `<optgroup>`
 * children, which are mapped to Base UI items (`select-options.ts`). `options` / `groups` props are
 * the typed alternative. The trigger is a `<button role="combobox">` that carries the `id` (so a
 * `<Label htmlFor>` names it) and the current value as its `value` attribute; a hidden input carries
 * `name` for forms. The popup is portalled, hairline + canvas + the floating shadow.
 */
export function Select({
  className,
  children,
  value,
  defaultValue,
  onChange,
  onValueChange,
  options,
  groups,
  placeholder,
  selectSize = 'md',
  native,
  id,
  name,
  disabled,
  required,
  form,
  autoComplete,
  ref,
  ...rest
}: SelectProps) {
  const h = selectSize === 'lg' ? 'h-10' : 'h-8';
  const entries = useMemo(() => selectEntries({ options, groups, children }), [options, groups, children]);

  if (native) {
    return (
      <div className={cn('relative', className)}>
        <select
          ref={ref as Ref<HTMLSelectElement> | undefined}
          id={id}
          name={name}
          disabled={disabled}
          required={required}
          form={form}
          autoComplete={autoComplete}
          value={value}
          defaultValue={defaultValue}
          onChange={(e) => {
            onChange?.(e);
            onValueChange?.(e.target.value);
          }}
          className={cn(control, h, 'appearance-none pl-3 pr-8 text-sm')}
          {...rest}
        >
          {options || groups ? renderNativeEntries(entries) : children}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-mute" />
      </div>
    );
  }

  const emit = (next: string | null) => {
    const v = next ?? '';
    onChange?.({ type: 'change', target: { value: v, name }, currentTarget: { value: v, name } });
    onValueChange?.(v);
  };

  return (
    <BaseSelect.Root<string> value={value} defaultValue={defaultValue} onValueChange={emit} name={name} disabled={disabled} required={required} modal={false}>
      <BaseSelect.Trigger
        ref={ref}
        id={id}
        value={value}
        className={cn(control, h, 'flex items-center justify-between gap-2 pl-3 pr-2 text-left text-sm data-popup-open:border-accent', className)}
        {...rest}
      >
        <BaseSelect.Value className="min-w-0 flex-1 truncate">
          {(v: string | null) => {
            const opt = findOption(entries, v);
            if (opt) return opt.label;
            return <span className="text-mute">{placeholder ?? (v || ' ')}</span>;
          }}
        </BaseSelect.Value>
        <BaseSelect.Icon className="flex shrink-0 text-mute">
          <ChevronDownIcon />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-50 outline-none" side="bottom" align="start" sideOffset={4} alignItemWithTrigger={false}>
          <BaseSelect.Popup className={cn('max-h-[min(360px,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto rounded-md p-1', floatSurface, fade)}>
            <BaseSelect.List>{renderEntries(entries)}</BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

const item =
  'relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-7 text-sm text-ink outline-none data-highlighted:bg-canvas-sub data-disabled:opacity-50';

function renderItem(o: SelectOption) {
  return (
    <BaseSelect.Item key={o.value} value={o.value} label={o.text} disabled={o.disabled} className={item}>
      <BaseSelect.ItemText className="min-w-0 flex-1">{o.label}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="absolute right-2 flex text-ink">
        <CheckIcon size={12} />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

function renderEntries(entries: SelectEntry[]) {
  return entries.map((e, i) =>
    e.kind === 'option' ? (
      renderItem(e.option)
    ) : (
      <BaseSelect.Group key={`g-${e.group.label}-${i}`} className={cn(i > 0 && 'mt-1 border-t border-hairline pt-1')}>
        <BaseSelect.GroupLabel className="px-2 py-1 text-caption text-mute">{e.group.label}</BaseSelect.GroupLabel>
        {e.group.options.map(renderItem)}
      </BaseSelect.Group>
    ),
  );
}

function renderNativeEntries(entries: SelectEntry[]) {
  return entries.map((e, i) =>
    e.kind === 'option' ? (
      <option key={e.option.value} value={e.option.value} disabled={e.option.disabled}>
        {e.option.text ?? e.option.label}
      </option>
    ) : (
      <optgroup key={`g-${e.group.label}-${i}`} label={e.group.label}>
        {e.group.options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.text ?? o.label}
          </option>
        ))}
      </optgroup>
    ),
  );
}

export function Label({ htmlFor, children, hint }: { htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-caption font-medium text-ink">
        {children}
      </label>
      {hint ? <span className="text-caption text-mute">{hint}</span> : null}
    </div>
  );
}

/**
 * Switch on Base UI (`@base-ui-components/react/switch`), rendered as a native `<button role="switch">`
 * with `aria-label`, so `getByRole('switch', { name })`, `aria-checked` and `disabled` behave as before.
 * `id` lands on the hidden checkbox Base UI renders beside it, so a `<label htmlFor={id}>` toggles it.
 * Ink track when on, `canvas-sub` + `hairline-strong` when off; no accent (the switch is not the
 * view's primary action).
 */
export function Switch({
  checked,
  onChange,
  id,
  label,
  disabled,
  name,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id?: string;
  label: string;
  disabled?: boolean;
  name?: string;
  className?: string;
}) {
  return (
    <BaseSwitch.Root
      id={id}
      name={name}
      checked={checked}
      onCheckedChange={(v) => onChange(v)}
      disabled={disabled}
      aria-label={label}
      nativeButton
      render={<button type="button" />}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-hairline-strong bg-canvas-sub transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-ink data-checked:bg-ink',
        className,
      )}
    >
      <BaseSwitch.Thumb className="inline-block size-3.5 translate-x-[2px] rounded-full bg-mute transition-transform duration-150 motion-reduce:transition-none data-checked:translate-x-[18px] data-checked:bg-on-ink" />
    </BaseSwitch.Root>
  );
}
