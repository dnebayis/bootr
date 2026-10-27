'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { ThemeProvider } from '@/lib/theme';
import { Toaster } from 'sonner';
import { MotionConfig } from 'motion/react';
import { makeWagmiConfig } from '@/lib/wagmi';
import { useIndexerStream } from '@/lib/indexer';

function Stream() {
  useIndexerStream();
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [wagmiConfig] = useState(() => makeWagmiConfig());
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );

  return (
    <ThemeProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <MotionConfig reducedMotion="user" transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
            <Stream />
            {children}
            <Toaster
              position="bottom-right"
              toastOptions={{
                className: '!bg-canvas !text-ink !border-hairline !rounded-md !font-sans !text-sm',
              }}
            />
          </MotionConfig>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
