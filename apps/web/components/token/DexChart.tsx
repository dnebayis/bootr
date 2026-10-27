'use client';

import { useTheme } from '@/lib/theme';
import { dexscreenerUrl, isMainnet } from '@/lib/chains';
import { useMounted } from '@/lib/hooks';

export function DexChart({ target }: { target: string }) {
  const { resolvedTheme } = useTheme();
  const mounted = useMounted();
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';
  const src = dexscreenerUrl(target, { embed: true, theme });

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md border border-hairline bg-canvas-soft">
      {!isMainnet || !src ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
          <span className="font-mono text-caption text-mute">SEPOLIA</span>
          <p className="text-sm text-mute">Charts appear on Base mainnet. DexScreener does not index testnets.</p>
        </div>
      ) : mounted ? (
        <iframe
          key={theme}
          src={src}
          title="Price chart"
          className="absolute inset-0 size-full border-0"
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      ) : null}
    </div>
  );
}
