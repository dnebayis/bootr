import type { Metadata } from 'next';
import { DOC_CONTENT } from '@/components/docs/content';
import { docMetadata } from '@/components/docs/pages';

export const metadata: Metadata = docMetadata('terms');

export default function DocPage() {
  const Content = DOC_CONTENT['terms'];
  return <Content />;
}
