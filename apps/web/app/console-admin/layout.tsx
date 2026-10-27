import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Console',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
