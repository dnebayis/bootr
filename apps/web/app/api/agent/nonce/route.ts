import { NextResponse } from 'next/server';
import { issueNonce, NONCE_TTL_S } from '@/lib/server/siwe-verify';

/**
 * POST /api/agent/nonce -> {nonce, expiresIn}
 * A single-use SIWE nonce for the agent API (`/api/agent/launch`, `/api/agent/x-connect`). Unlike the
 * site's own sign-in it is not bound to a browser cookie: the caller is a program with a wallet, and the
 * signature binds the nonce to that wallet. Valid for 10 minutes, consumed by the first verification.
 */
export async function POST() {
  const { nonce } = issueNonce();
  return NextResponse.json({ nonce, expiresIn: NONCE_TTL_S }, { headers: { 'Cache-Control': 'no-store' } });
}
