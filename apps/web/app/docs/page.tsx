import type { Metadata } from 'next';
import { DOC_CONTENT } from '@/components/docs/content';

export const metadata: Metadata = { title: 'How it works', description: 'From launch to an agent running its own coin.' };

export default function DocsIndex() {
  const Content = DOC_CONTENT[''];
  return <Content />;
}
