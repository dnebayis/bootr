/**
 * An own-agent launch with no fuel, against the two live launchers on a Base mainnet fork (docs/design/byo-agent.md
 * sections 1.4 and 6): `BootrLauncher` v3.1 (the RWAGMI path) and `BootrClankerLauncherV5`. What it proves on the real
 * contracts: both read a fuel minimum of 0, a launch that carries the reserved model id `own-agent` and 0 USDC is one
 * transaction with no USDC approval before it (the creator holds no USDC and has approved nothing), the event says
 * `own-agent`, the new treasury holds no USDC, and a launch that does carry fuel still needs the approval.
 * Skipped unless OWN_FORK_RPC is set:
 *
 *   base-anvil --fork-url <Base RPC> --chain-id 8453 --port 8656
 *     (Base's own anvil: the RWAGMI path needs its B20 precompile, and plain anvil reverts that launch)
 *   OWN_FORK_RPC=http://127.0.0.1:8656 pnpm --filter web exec vitest run lib/own-launch.fork.test.ts --testTimeout=300000
 *
 * Only a throwaway test key signs here, funded by the fork itself. Nothing reaches a live chain.
 */
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, keccak256, parseEther, parseEventLogs, toHex, zeroAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { beforeAll, describe, expect, it } from 'vitest';
import { addresses } from '@bootr/shared/addresses';
import { OWN_AGENT_MODEL_ID } from '@bootr/shared/own-agent';
import { clankerLauncherV5Abi } from './abi/clankerLauncherV5.abi';
import { defaultsFromTuple, launcherAbi, type LaunchDefaultsTuple } from './abi/launcher';
import { mineLaunchSalt, type V5LaunchParams } from './clanker-v5';
import { defaultTokenSettings, toContractSettings } from './token-settings';
import { launchValue, pinsOf, readLaunchTerms } from './v5-launch';

const RPC = process.env.OWN_FORK_RPC ?? '';
const A = addresses[8453];
const BOOTR_LAUNCHER = A.bootr.launcher as Address;
const V5_LAUNCHER = A.bootr.clankerLauncherV5 as Address;
const USDC = A.usdc as Address;

// A throwaway key made for this test (the hash of a fixed phrase, so it is public and owns nothing anywhere): on a
// mainnet fork anvil's own default accounts carry years of other people's state. The fork gives it ETH; it never holds USDC.
const creator = privateKeyToAccount(keccak256(toHex('bootr own-agent fork test creator')));
const client = createPublicClient({ chain: base, transport: http(RPC) });
const wallet = createWalletClient({ account: creator, chain: base, transport: http(RPC) });
const testClient = createTestClient({ chain: base, mode: 'anvil', transport: http(RPC) });

const usdcOf = (holder: Address) => client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
const allowanceTo = (spender: Address) => client.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [creator.address, spender] });

function params(draftId: string, fuelUsdc: bigint): V5LaunchParams {
  return {
    name: 'Own Agent Fork',
    symbol: 'OWNF',
    image: 'https://bootr.fun/x.png',
    metadata: `https://bootr.fun/tokens/${draftId}.json`,
    context: JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id: draftId }),
    salt: keccak256(toHex(draftId)),
    buybackBurn: false,
    fuelUsdc,
    devBuyWei: 0n,
    workerHash: keccak256(toHex('community')),
    model: OWN_AGENT_MODEL_ID,
    agentURI: `https://bootr.fun/agents/${draftId}.json`,
    supervisorSessionKey: zeroAddress,
  };
}

describe.skipIf(!RPC)('an own-agent launch with no fuel on a Base fork', () => {
  beforeAll(async () => {
    await testClient.setBalance({ address: creator.address, value: parseEther('1') });
  });

  it('BootrLauncher v3.1: minimum fuel 0, one transaction, no approval, the event says own-agent', async () => {
    const [fee, tuple, paused] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: BOOTR_LAUNCHER, abi: launcherAbi, functionName: 'launchFeeWei' },
        { address: BOOTR_LAUNCHER, abi: launcherAbi, functionName: 'standardDefaults' },
        { address: BOOTR_LAUNCHER, abi: launcherAbi, functionName: 'paused' },
      ],
    });
    expect(paused).toBe(false);
    expect(defaultsFromTuple(tuple as LaunchDefaultsTuple).minFuelUsdc).toBe(0n);
    const buyback = await client.readContract({ address: BOOTR_LAUNCHER, abi: launcherAbi, functionName: 'buybackDefaults' });
    expect(defaultsFromTuple(buyback as LaunchDefaultsTuple).minFuelUsdc).toBe(0n);
    // the creator has no USDC and has approved nothing: a launch that pulled any would revert
    expect(await usdcOf(creator.address)).toBe(0n);
    expect(await allowanceTo(BOOTR_LAUNCHER)).toBe(0n);

    const p = params(crypto.randomUUID(), 0n);
    const nonceBefore = await client.getTransactionCount({ address: creator.address });
    const hash = await wallet.writeContract({ address: BOOTR_LAUNCHER, abi: launcherAbi, functionName: 'launch', args: [p], value: fee });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    // one transaction from the creator, and still no approval on record
    expect((await client.getTransactionCount({ address: creator.address })) - nonceBefore).toBe(1);
    expect(await allowanceTo(BOOTR_LAUNCHER)).toBe(0n);
    const [ev] = parseEventLogs({ abi: launcherAbi, eventName: 'AgentLaunched', logs: receipt.logs });
    const args = ev!.args as { token: Address; kernel: Address; creator: Address; model: string };
    expect(args.model).toBe(OWN_AGENT_MODEL_ID);
    expect(args.creator).toBe(creator.address);
    expect(await usdcOf(args.kernel)).toBe(0n);
    expect((await client.getCode({ address: args.token }))?.length ?? 0).toBeGreaterThan(2);

    // with fuel and no approval the same launch reverts: the approval is what fuel needs, and only fuel
    const withFuel = await client.simulateContract({ account: creator, address: BOOTR_LAUNCHER, abi: launcherAbi, functionName: 'launch', args: [params(crypto.randomUUID(), 1_000_000n)], value: fee }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(withFuel).not.toBeNull();
  });

  it('BootrClankerLauncherV5: minimum fuel 0, one transaction, no approval, the event says own-agent', async () => {
    const terms = await readLaunchTerms(client, V5_LAUNCHER, A.clankerV5!.factory as Address);
    expect(terms.minFuelUsdc).toBe(0n);
    expect(await client.readContract({ address: V5_LAUNCHER, abi: launcherAbi, functionName: 'paused' })).toBe(false);
    expect(await usdcOf(creator.address)).toBe(0n);
    expect(await allowanceTo(V5_LAUNCHER)).toBe(0n);

    const draftId = crypto.randomUUID();
    const p = params(draftId, 0n);
    p.metadata = '{"description":"own agent fork"}';
    const settings = toContractSettings(defaultTokenSettings(creator.address), `https://bootr.fun/tokens/${draftId}.json`, terms.bounds, pinsOf(terms, 0n));
    const mined = await mineLaunchSalt({ client, launcher: V5_LAUNCHER, tokenDeployer: A.clankerV5!.tokenDeployer as Address, creator: creator.address, params: p, settings });
    p.salt = mined.salt;
    const nonceBefore = await client.getTransactionCount({ address: creator.address });
    const hash = await wallet.writeContract({ address: V5_LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'launch', args: [p, settings], value: launchValue(0n, terms) });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    expect((await client.getTransactionCount({ address: creator.address })) - nonceBefore).toBe(1);
    expect(await allowanceTo(V5_LAUNCHER)).toBe(0n);
    const [ev] = parseEventLogs({ abi: clankerLauncherV5Abi, eventName: 'AgentLaunched', logs: receipt.logs });
    const args = ev!.args as { token: Address; kernel: Address; model: string };
    expect(args.model).toBe(OWN_AGENT_MODEL_ID);
    expect(args.token.toLowerCase()).toBe(mined.token.toLowerCase());
    expect(await usdcOf(args.kernel)).toBe(0n);

    const fueled = params(crypto.randomUUID(), 1_000_000n);
    fueled.metadata = p.metadata;
    const withFuel = await client.simulateContract({ account: creator, address: V5_LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'launch', args: [{ ...fueled, salt: mined.salt }, settings], value: launchValue(0n, terms) }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(withFuel).not.toBeNull();
  });
});
