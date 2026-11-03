'use client';

import type { ReactElement, ReactNode } from 'react';
import { Dialog as BaseDialog } from '@base-ui-components/react/dialog';
import { AlertDialog as BaseAlertDialog } from '@base-ui-components/react/alert-dialog';
import { cn } from './cn';
import { Button, type ButtonVariant } from './Button';
import { floatSurface } from './surface';

const backdrop = 'fixed inset-0 z-50 bg-black/40 transition-opacity duration-250 ease-out-quint data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none';

const popup = cn(
  'fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg p-5 text-ink outline-none',
  floatSurface,
  'transition-[opacity,scale] duration-250 ease-out-quint data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none',
);

/**
 * Dialog on Base UI (`@base-ui-components/react/dialog`): modal, focus-trapped, portalled, closes
 * on Escape and on a backdrop press, restores focus to the trigger. Surface per DESIGN.md
 * `ex-modal-card`: canvas, hairline, radius `lg`, the floating shadow, 20px padding, over a
 * `black/40` backdrop (the command palette's). `title` is required (it is the accessible name);
 * `description` is announced with it. Put the actions in `actions`, primary last, and use
 * `DialogClose` for the one that only dismisses.
 *
 * Controlled (`open` / `onOpenChange`) or uncontrolled with `trigger`.
 */
export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  actions,
  className,
  dismissible = true,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Uncontrolled opener; must accept a ref and DOM event props. */
  trigger?: ReactElement<Record<string, unknown>>;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons row, right-aligned. */
  actions?: ReactNode;
  className?: string;
  /** `false` keeps the dialog open on Escape and outside press (confirmations in flight). */
  dismissible?: boolean;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(o) => onOpenChange?.(o)} disablePointerDismissal={!dismissible}>
      {trigger ? <BaseDialog.Trigger render={trigger} /> : null}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdrop} />
        <BaseDialog.Popup className={cn(popup, className)}>
          <BaseDialog.Title className="text-base font-semibold tracking-tight text-ink">{title}</BaseDialog.Title>
          {description ? <BaseDialog.Description className="mt-1 text-sm text-body">{description}</BaseDialog.Description> : null}
          {children ? <div className="mt-4 text-sm text-body">{children}</div> : null}
          {actions ? <div className="mt-5 flex flex-wrap justify-end gap-2">{actions}</div> : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** A button that closes the enclosing `Dialog`. Secondary by default. */
export function DialogClose({ children = 'Cancel', variant = 'secondary', className }: { children?: ReactNode; variant?: ButtonVariant; className?: string }) {
  return <BaseDialog.Close render={<Button variant={variant} className={className} />}>{children}</BaseDialog.Close>;
}

/**
 * A confirmation: `role="alertdialog"`, so it never closes on an outside press, only via its
 * buttons or Escape. One accent button (the confirm), one secondary (cancel). `onConfirm` may
 * return a promise; the confirm button shows `loading` meanwhile and the dialog stays open until
 * `onOpenChange(false)` is called by the caller, or closes itself when `closeOnConfirm` (default).
 *
 * ```tsx
 * <ConfirmDialog open={open} onOpenChange={setOpen} title="Pause the agent?"
 *   description="It stops posting until you resume it." confirmLabel="Pause" onConfirm={pause} />
 * ```
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  onConfirm,
  loading,
  closeOnConfirm = true,
  className,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactElement<Record<string, unknown>>;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** `primary` (accent) by default; `ink` for a destructive confirm, so the accent is not read as safe. */
  confirmVariant?: ButtonVariant;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
  closeOnConfirm?: boolean;
  className?: string;
}) {
  return (
    <BaseAlertDialog.Root open={open} onOpenChange={(o) => onOpenChange?.(o)}>
      {trigger ? <BaseAlertDialog.Trigger render={trigger} /> : null}
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop className={backdrop} />
        <BaseAlertDialog.Popup className={cn(popup, className)}>
          <BaseAlertDialog.Title className="text-base font-semibold tracking-tight text-ink">{title}</BaseAlertDialog.Title>
          {description ? <BaseAlertDialog.Description className="mt-1 text-sm text-body">{description}</BaseAlertDialog.Description> : null}
          {children ? <div className="mt-4 text-sm text-body">{children}</div> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <BaseAlertDialog.Close render={<Button variant="secondary" />} disabled={loading}>
              {cancelLabel}
            </BaseAlertDialog.Close>
            {closeOnConfirm ? (
              <BaseAlertDialog.Close render={<Button variant={confirmVariant} loading={loading} />} onClick={() => void onConfirm()}>
                {confirmLabel}
              </BaseAlertDialog.Close>
            ) : (
              <Button variant={confirmVariant} loading={loading} onClick={() => void onConfirm()}>
                {confirmLabel}
              </Button>
            )}
          </div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
