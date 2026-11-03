import { Children, Fragment, isValidElement, type ReactNode } from 'react';

/**
 * The option model behind `Select` (components/ui/Field.tsx). Callers can pass `options` / `groups`
 * directly, or keep writing native `<option>` / `<optgroup>` children: `optionsFromChildren` maps the
 * native children onto this model so the Base UI Select renders them. Pure functions, no DOM.
 */

export type SelectOption = {
  value: string;
  /** What the popup item and the trigger show. */
  label: ReactNode;
  /** Plain text of `label`, for typeahead and accessible names. Derived when omitted. */
  text?: string;
  disabled?: boolean;
};

export type SelectGroup = { label: string; options: SelectOption[] };

/** Either loose options or labelled groups, in source order. */
export type SelectEntry = { kind: 'option'; option: SelectOption } | { kind: 'group'; group: SelectGroup };

/** Flattens a ReactNode to its text, the way a native `<option>` would display it. */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

type OptionProps = { value?: string | number | readonly string[]; children?: ReactNode; disabled?: boolean; label?: string };
type GroupProps = { label?: string; children?: ReactNode; disabled?: boolean };

function optionFrom(props: OptionProps): SelectOption {
  const text = props.label ?? textOf(props.children);
  const value = props.value === undefined ? text : Array.isArray(props.value) ? props.value.join(',') : String(props.value);
  return { value, label: props.children ?? text, text, disabled: props.disabled || undefined };
}

/** Maps native `<option>` / `<optgroup>` children (fragments and arrays allowed) to `SelectEntry[]`. Anything else is ignored. */
export function optionsFromChildren(children: ReactNode): SelectEntry[] {
  const out: SelectEntry[] = [];
  const walk = (node: ReactNode) => {
    for (const child of Children.toArray(node)) {
      if (!isValidElement(child)) continue;
      if (child.type === Fragment) {
        walk((child.props as { children?: ReactNode }).children);
      } else if (child.type === 'option') {
        out.push({ kind: 'option', option: optionFrom(child.props as OptionProps) });
      } else if (child.type === 'optgroup') {
        const p = child.props as GroupProps;
        const options: SelectOption[] = [];
        for (const o of Children.toArray(p.children)) {
          if (isValidElement(o) && o.type === 'option') {
            const opt = optionFrom(o.props as OptionProps);
            options.push(p.disabled ? { ...opt, disabled: true } : opt);
          }
        }
        out.push({ kind: 'group', group: { label: p.label ?? '', options } });
      }
    }
  };
  walk(children);
  return out;
}

/** Builds the entry list from whichever of `groups`, `options` or native children a caller passed (in that priority). */
export function selectEntries(args: { options?: SelectOption[]; groups?: SelectGroup[]; children?: ReactNode }): SelectEntry[] {
  if (args.groups) return args.groups.map((group) => ({ kind: 'group', group }));
  if (args.options) return args.options.map((option) => ({ kind: 'option', option }));
  return optionsFromChildren(args.children);
}

/** Every option in order, groups flattened. */
export function flattenEntries(entries: SelectEntry[]): SelectOption[] {
  return entries.flatMap((e) => (e.kind === 'option' ? [e.option] : e.group.options));
}

/** The option whose value matches, if any. */
export function findOption(entries: SelectEntry[], value: string | null | undefined): SelectOption | undefined {
  if (value == null) return undefined;
  return flattenEntries(entries).find((o) => o.value === value);
}
