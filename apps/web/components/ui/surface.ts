/**
 * Shared class strings for floating layers (select popup, menu, tooltip, dialog). DESIGN.md
 * "Spacing, radii, elevation": elevation is a hairline; the one shadow is for floating layers only.
 */

/** The floating shadow from DESIGN.md, verbatim. */
export const floatShadow = 'shadow-[0_1px_1px_#00000005,0_8px_16px_-4px_#0000000a,0_24px_32px_-8px_#0000000f]';

/** Canvas surface, hairline border, floating shadow. Radius is set per layer (`rounded-sm` tooltip, `rounded-md` popup, `rounded-lg` dialog). */
export const floatSurface = `border border-hairline bg-canvas ${floatShadow}`;

/**
 * Base UI toggles `data-starting-style` on mount and `data-ending-style` on unmount; with a
 * transition on the element those two states fade it in and out. Reduced motion swaps instantly.
 */
export const fade = 'transition-opacity duration-150 ease-out-quint data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none';

/** Focus ring for keyboard focus, same accent ring as inputs. */
export const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/25';
