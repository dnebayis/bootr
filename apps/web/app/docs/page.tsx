import type { Metadata } from 'next';
import { DocArticle } from '@/components/docs/DocArticle';
import { docMetadata } from '@/components/docs/pages';

export const metadata: Metadata = docMetadata('');

export default function DocsIndex() {
  return <DocArticle slug="" />;
}
