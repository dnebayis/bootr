'use client';

import { useParams } from 'next/navigation';
import { normalizeUserCode } from '@/lib/own-agent';
import { ConnectApproval } from './ConnectApproval';

/** Reads the code from the URL on the client (the route has one static shell) and hands it on in its canonical form. */
export function ConnectRoute() {
  const params = useParams<{ code: string }>();
  let raw = params?.code ?? '';
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* a malformed escape is just not a code */
  }
  const code = normalizeUserCode(raw) ?? raw;
  return <ConnectApproval key={code} code={code} />;
}
