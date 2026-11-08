'use client';

import { useParams } from 'next/navigation';
import { ConsolePage } from './ConsolePage';

export function ConsoleRoute() {
  const params = useParams<{ address: string }>();
  const address = decodeURIComponent(params?.address ?? '');
  return <ConsolePage key={address.toLowerCase()} address={address} />;
}
