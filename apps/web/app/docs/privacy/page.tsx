import type { Metadata } from 'next';
import { DOC_CONTENT } from '@/components/docs/content';
import { docMetadata } from '@/components/docs/pages';

export const metadata: Metadata = docMetadata('privacy');

export default function DocPage() {
  const Content = DOC_CONTENT['privacy'];
  return <Content />;
}
