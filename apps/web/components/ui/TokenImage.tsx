/* eslint-disable @next/next/no-img-element */
import { cn } from './cn';

/**
 * Square token image with a 1px hairline. Renders a neutral placeholder (first letter of the
 * symbol) when `src` is empty, so we never emit <img src="">.
 */
export function TokenImage({ src, symbol, size, className }: { src: string | null | undefined; symbol?: string; size: number; className?: string }) {
  const base = cn('shrink-0 border border-hairline bg-canvas-sub', className);
  if (!src) {
    return (
      <span
        aria-hidden="true"
        className={cn(base, 'inline-flex items-center justify-center font-mono font-medium text-mute')}
        style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) }}
      >
        {(symbol ?? '').slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt="" width={size} height={size} loading="lazy" className={cn(base, 'object-cover')} style={{ width: size, height: size }} />;
}
