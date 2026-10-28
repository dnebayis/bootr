import type { Metadata } from 'next';
import { DocArticle } from '@/components/docs/DocArticle';
import { docMetadata } from '@/components/docs/pages';

export const metadata: Metadata = docMetadata('for-agents');

export default function DocPage() {
  return <DocArticle slug="for-agents" />;
}
