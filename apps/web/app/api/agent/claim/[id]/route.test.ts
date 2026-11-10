import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { clankerFeeLockerAbi } from '@/lib/abi/clankerFeeLocker';
import { feeEscrowAbi } from '@/lib/abi/feeEscrow';
import { rwagmiLpLockerV3Abi } from '@/lib/abi/rwagmiLpLockerV3';
import { buildClaims } from '@/lib/server/claim';
import { GET } from './route';

const OWNER = getAddress('0x1111111111111111111111111111111111111111');
const WETH = '0x4200000000000000000000000000000000000006' as Address;
const LOCKER = getAddress('0x2222222222222222222222222222222222222222');
const FEE_LOCKER = getAddress('0x3333333333333333333333333333333333333333');
const POOL_A = `0x${'a'.repeat(64)}` as Hex;
const POOL_B = `0x${'b'.repeat(64)}` as Hex;

const input = { owner: OWNER, weth: WETH, lpLocker: LOCKER, clankerFeeLocker: FEE_LOCKER, settled: 0n, unsettled: [], clankerAvailable: 0n };

describe('buildClaims', () => {
  it('prepares nothing when nothing is waiting', () => {
    expect(buildClaims({ ...input, unsettled: [{ poolId: POOL_A, amount: 0n }] })).toEqual([]);
  });

  it('settles only the coins with unsettled fees, as the profile page does', () => {
    const [claim] = buildClaims({ ...input, settled: 5n, unsettled: [{ poolId: POOL_A, amount: 2n }, { poolId: POOL_B, amount: 0n }] });
    expect(claim).toMatchObject({ path: 'bootr', target: LOCKER, value: '0', amountWei: '7', sendFrom: OWNER });
    const call = decodeFunctionData({ abi: rwagmiLpLockerV3Abi, data: claim!.data });
    expect(call.functionName).toBe('settleAndClaim');
    expect(call.args).toEqual([[POOL_A], WETH, OWNER]);
  });

  it('takes the settled balance alone when no coin has unsettled fees', () => {
    const [claim] = buildClaims({ ...input, settled: 5n });
    const call = decodeFunctionData({ abi: rwagmiLpLockerV3Abi, data: claim!.data });
    expect(call.functionName).toBe('claimQuote');
    expect(call.args).toEqual([WETH, OWNER]);
  });

  it('claims Clanker’s balance for the owner, from any wallet', () => {
    const [claim] = buildClaims({ ...input, clankerAvailable: 9n });
    expect(claim).toMatchObject({ path: 'clanker', target: FEE_LOCKER, value: '0', amountWei: '9', sendFrom: null });
    const call = decodeFunctionData({ abi: clankerFeeLockerAbi, data: claim!.data });
    expect(call.functionName).toBe('claim');
    expect(call.args).toEqual([OWNER, WETH]);
    expect(claim!.description).toContain('Any wallet may send it');
  });

  it('claims Clanker v5’s escrow balance for the owner in native ETH, from any wallet', () => {
    const ESCROW = getAddress('0x5dd237d1f716C65426CCd2FAe82B95109825FA61');
    const claims = buildClaims({ ...input, clankerAvailable: 9n, clankerFeeEscrow: ESCROW, clankerV5Owed: 4n });
    expect(claims.map((c) => c.path)).toEqual(['clanker', 'clanker-v5']);
    const v5 = claims[1]!;
    expect(v5).toMatchObject({ target: ESCROW, value: '0', asset: '0x0000000000000000000000000000000000000000', amountWei: '4', sendFrom: null });
    const call = decodeFunctionData({ abi: feeEscrowAbi, data: v5.data });
    expect(call.functionName).toBe('claimFor');
    expect(call.args).toEqual([OWNER, '0x0000000000000000000000000000000000000000']);
    expect(v5.description).toContain('ETH to');
    // Nothing owed, or no escrow on this chain: no v5 claim.
    expect(buildClaims({ ...input, clankerFeeEscrow: ESCROW, clankerV5Owed: 0n })).toEqual([]);
    expect(buildClaims({ ...input, clankerFeeEscrow: null, clankerV5Owed: 4n })).toEqual([]);
  });

  it('carries the attribution suffix the site’s own claims carry, after decodable calldata', () => {
    const [claim] = buildClaims({ ...input, clankerAvailable: 9n, dataSuffix: '0xabcdef' });
    expect(claim!.data.endsWith('abcdef')).toBe(true);
    expect(decodeFunctionData({ abi: clankerFeeLockerAbi, data: claim!.data }).functionName).toBe('claim');
  });

  it('skips a path with no deployment', () => {
    expect(buildClaims({ ...input, lpLocker: null, clankerFeeLocker: null, settled: 5n, clankerAvailable: 9n })).toEqual([]);
  });
});

const request = (ip: string) => new NextRequest('http://localhost:3000/api/agent/claim/x', { headers: { 'x-real-ip': ip } });
const call = (id: string, ip = '10.0.0.1') => GET(request(ip), { params: Promise.resolve({ id }) });

describe('GET /api/agent/claim/{address}', () => {
  it('refuses what is not an address', async () => {
    const res = await call('nonsense', '10.0.0.2');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers unsigned claims and says nothing was sent', async () => {
    const res = await call(OWNER.toLowerCase(), '10.0.0.3');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { address: string; mock?: boolean; claims: { target: string; data: string; value: string; description: string }[]; note: string };
    expect(body.address).toBe(OWNER);
    expect(body.mock).toBe(true);
    expect(body.note).toContain('Nothing was signed or sent');
    expect(body.claims.length).toBeGreaterThan(0);
    for (const c of body.claims) {
      expect(c.target).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(c.data).toMatch(/^0x[0-9a-f]+$/);
      expect(c.value).toBe('0');
      expect(c.description.length).toBeGreaterThan(20);
    }
  });

  it('limits each IP to 20 calls a minute', async () => {
    for (let i = 0; i < 20; i++) expect((await call(OWNER, '10.0.0.4')).status).toBe(200);
    const res = await call(OWNER, '10.0.0.4');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
