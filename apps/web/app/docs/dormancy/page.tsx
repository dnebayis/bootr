import { permanentRedirect } from 'next/navigation';
import { DOC_REDIRECTS } from '@/components/docs/pages';

/** Retired slug: see DOC_REDIRECTS. */
export default function MovedDocPage() {
  permanentRedirect(DOC_REDIRECTS['dormancy']!);
}
