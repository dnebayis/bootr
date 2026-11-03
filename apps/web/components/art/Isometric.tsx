import type { ReactNode, SVGProps } from 'react';

/**
 * Three small isometric line drawings in one stroke of `currentColor` on nothing, for the waiting and empty
 * states: `vault` (a treasury box), `antenna` (an agent waiting for a signal: no X account yet), `blueprint`
 * (nothing launched yet: a floor grid with the outline of something not built). 1px strokes, 48-unit box,
 * decorative (`aria-hidden`); the sentence beside them carries the meaning.
 */

export type IsometricKind = 'vault' | 'antenna' | 'blueprint';

type Props = Omit<SVGProps<SVGSVGElement>, 'children'> & { kind: IsometricKind; size?: number };

// Iso axes: right = (cos 30°, sin 30°) = (0.866, 0.5); up = (0, -1). Every shape is drawn by hand on that grid.
const ART: Record<IsometricKind, ReactNode> = {
  vault: (
    <>
      {/* The box: three faces. */}
      <path d="M24 40 13.6 34V22L24 28ZM24 40l10.4-6V22L24 28ZM24 28 13.6 22 24 16l10.4 6Z" />
      {/* Lid seam on the top face. */}
      <path d="M16.2 23.5 24 19l7.8 4.5" strokeOpacity=".5" />
      {/* Door and dial on the right face, drawn in that face's own skewed plane. */}
      <g transform="matrix(.866 -.5 0 1 24 40)">
        <path d="M2.5-9.5h7v7h-7z" />
        <circle cx="6" cy="-6" r="1.7" />
        <path d="M6-6l1.2-1.2" />
      </g>
      {/* Ground. */}
      <path d="M8 36.5l5.6 3.2M40 36.5l-5.6 3.2" strokeOpacity=".35" />
    </>
  ),
  antenna: (
    <>
      {/* A slab the mast stands on. */}
      <path d="M24 42 11.9 35v-3L24 25l12.1 7v3Z" />
      <path d="M11.9 32 24 39l12.1-7M24 39v3" />
      {/* Mast and crossbar. */}
      <path d="M24 32V12M18.8 19l10.4-6" />
      <circle cx="24" cy="12" r="1.2" fill="currentColor" stroke="none" />
      {/* The signal it is waiting for: dashed arcs, faint. */}
      <g strokeOpacity=".45" strokeDasharray="2 2">
        <path d="M19.67 9.5A5 5 0 0 1 28.33 9.5" />
        <path d="M16.2 7.5A9 9 0 0 1 31.8 7.5" />
        <path d="M12.74 5.5A13 13 0 0 1 35.26 5.5" />
      </g>
    </>
  ),
  blueprint: (
    <>
      {/* Floor with a 3x3 grid. */}
      <path d="M24 44 8.4 35 24 26l15.6 9Z" />
      <path d="M18.8 41 34.4 32M13.6 38l15.6-9M29.2 41 13.6 32M34.4 38 18.8 29" strokeOpacity=".35" />
      {/* The outline of what is not built yet. */}
      <g strokeDasharray="1.5 1.5" strokeOpacity=".7">
        <path d="M24 38 17.1 34V26L24 30ZM24 38l6.9-4V26L24 30ZM24 30l-6.9-4L24 22l6.9 4Z" />
      </g>
      {/* A corner mark above, the draughtsman's cross. */}
      <path d="M24 14v4M22 16h4" strokeOpacity=".5" />
    </>
  ),
};

export function Isometric({ kind, size = 48, className, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid={`iso-${kind}`}
      className={className}
      {...rest}
    >
      {ART[kind]}
    </svg>
  );
}
