import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';
import { ChevronDownIcon } from './Icons';

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

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <div className={cn('relative', className)}>
      <select ref={ref} className={cn(control, 'h-8 appearance-none pl-3 pr-8 text-sm')} {...rest}>
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-mute" />
    </div>
  );
});

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

export function Switch({
  checked,
  onChange,
  id,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id?: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-50',
        checked ? 'border-ink bg-ink' : 'border-hairline-strong bg-canvas-sub',
      )}
    >
      <span
        className={cn(
          'inline-block size-3.5 rounded-full transition-transform duration-150',
          checked ? 'translate-x-[18px] bg-on-ink' : 'translate-x-[2px] bg-mute',
        )}
      />
    </button>
  );
}
