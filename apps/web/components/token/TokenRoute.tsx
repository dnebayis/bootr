'use client';

import { useParams } from 'next/navigation';
import { TokenView } from './TokenView';

export function TokenRoute() {
  const params = useParams<{ address: string }>();
  const address = decodeURIComponent(params?.address ?? '');
  return <TokenView key={address.toLowerCase()} address={address} />;
}
