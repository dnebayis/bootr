import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Providers } from '@/components/Providers';
import { Nav } from '@/components/shell/Nav';
import { Footer } from '@/components/shell/Footer';
import { env } from '@/lib/env';
import { THEME_SCRIPT } from '@/lib/theme-script';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(env.siteUrl),
  title: { default: 'Bootr', template: '%s — Bootr' },
  description: 'Launch a coin with an agent that runs it.',
  applicationName: 'Bootr',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }] },
  openGraph: {
    type: 'website',
    siteName: 'Bootr',
    title: 'Bootr',
    description: 'Launch a coin with an agent that runs it.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'bootr' }],
  },
  twitter: { card: 'summary_large_image', title: 'Bootr', description: 'Launch a coin with an agent that runs it.', images: ['/og.png'] },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* No-flash theme: set .light/.dark before first paint. Rendered by this server component, not a client one. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <Providers>
          <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-ink focus:px-3 focus:py-1.5 focus:text-on-ink">
            Skip to content
          </a>
          <Nav />
          <main id="main" className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-6 md:px-6 md:pt-8">
            {children}
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
