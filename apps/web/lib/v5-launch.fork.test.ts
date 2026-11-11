/**
 * The v5 launch as the form and the agent API prepare it, against the real security-reviewed launcher on a Base mainnet
 * fork: the terms read, the salt mined, the dev buy quoted by simulating the launch (`eth_simulateV1`), the minimum
 * signed, the launch sent, and the stale pins mapped to plain words. Skipped unless V5_FORK_RPC and V5_FORK_LAUNCHER
 * are set:
 *
 *   anvil --fork-url <Base RPC> --port 8655
 *   PRIVATE_KEY=<anvil key 0> PLATFORM_ADMIN=<gate owner> PLATFORM_RECIPIENT=<recipient> OLD_CLANKER_LAUNCHER=<v4> \
 *     forge script script/DeployClankerLauncherV5.s.sol --rpc-url http://127.0.0.1:8655 --broadcast
 *   (impersonate the admin: acceptOwnership on the launcher, addLauncher on the gate)
 *   V5_FORK_RPC=http://127.0.0.1:8655 V5_FORK_LAUNCHER=<v5> V5_FORK_ADMIN=<admin> \
 *     pnpm --filter web exec vitest run lib/v5-launch.fork.test.ts --testTimeout=300000
 *
 * Only anvil's own test key signs here. Nothing reaches a live chain.
 */
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, keccak256, numberToHex, parseEther, toHex, zeroAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { addresses } from '@bootr/shared/addresses';
import { clankerLauncherV5Abi } from './abi/clankerLauncherV5.abi';
import { mineLaunchSalt, type V5LaunchParams } from './clanker-v5';
import { defaultTokenSettings, minDevBuyOutFrom, toContractSettings, type ContractTokenSettings } from './token-settings';
import { launchValue, pinsOf, quoteDevBuy, readLaunchTerms, usdcBalanceSlot, v5LaunchProblem } from './v5-launch';

const RPC = process.env.V5_FORK_RPC ?? '';
const LAUNCHER = (process.env.V5_FORK_LAUNCHER ?? zeroAddress) as Address;
const ADMIN = (process.env.V5_FORK_ADMIN ?? '') as Address;
const A = addresses[8453];
const V5 = A.clankerV5!;
const USDC = A.usdc as Address;

// anvil's second default account: a public test key.
const creator = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const client = createPublicClient({ chain: base, transport: http(RPC) });
const wallet = createWalletClient({ account: creator, chain: base, transport: http(RPC) });
const testClient = createTestClient({ chain: base, mode: 'anvil', transport: http(RPC) });

async function prepared(pairedAsset: 'ETH' | 'USDC', devBuyWei: bigint) {
  const terms = await readLaunchTerms(client, LAUNCHER, V5.factory as Address);
  const draftId = crypto.randomUUID();
  const settings: ContractTokenSettings = toContractSettings({ ...defaultTokenSettings(creator.address), pairedAsset }, `https://bootr.fun/tokens/${draftId}.json`, terms.bounds, pinsOf(terms, devBuyWei > 0n ? 1n : 0n));
  const params: V5LaunchParams = {
    name: 'Fork Five',
    symbol: 'FIVE',
    image: 'https://bootr.fun/x.png',
    metadata: '{"description":"fork"}',
    context: JSON.stringify({ interface: 'Bootr', id: draftId }),
    salt: keccak256(toHex(draftId)),
    buybackBurn: false,
    fuelUsdc: terms.minFuelUsdc,
    devBuyWei,
    workerHash: keccak256(toHex('community')),
    model: 'openai/gpt-5-mini',
    agentURI: `https://bootr.fun/agents/${draftId}.json`,
    supervisorSessionKey: zeroAddress,
  };
  const mined = await mineLaunchSalt({ client, launcher: LAUNCHER, tokenDeployer: V5.tokenDeployer as Address, creator: creator.address, params, settings });
  params.salt = mined.salt;
  return { terms, settings, params, token: mined.token, value: launchValue(devBuyWei, terms) };
}

/** The creator's USDC for the fuel, and the approval. */
async function fund(fuel: bigint) {
  await testClient.setStorageAt({ address: USDC, index: usdcBalanceSlot(creator.address), value: numberToHex(fuel, { size: 32 }) });
  const hash = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [LAUNCHER, fuel] });
  await client.waitForTransactionReceipt({ hash });
}

describe.skipIf(!RPC || LAUNCHER === zeroAddress)('a v5 launch on a Base fork, as the web prepares it', () => {
  for (const asset of ['ETH', 'USDC'] as const) {
    it(`quotes the dev buy by simulating the launch, signs the quote less 3%, and gets the quote (${asset})`, async () => {
      const p = await prepared(asset, parseEther('0.01'));
      const quotedOut = await quoteDevBuy({ client, launcher: LAUNCHER, usdc: USDC, creator: creator.address, token: p.token, params: p.params, settings: p.settings, value: p.value });
      expect(quotedOut).toBeGreaterThan(0n);
      const minOut = minDevBuyOutFrom(quotedOut, 3);

      await fund(p.params.fuelUsdc);
      // one coin above the quote: the launch reverts, and the words suggest a fresh quote
      const tooHigh = await client
        .simulateContract({ account: creator, address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'launch', args: [p.params, { ...p.settings, minDevBuyOut: quotedOut + 1n }], value: p.value })
        .then(() => null, (e: unknown) => e);
      expect(tooHigh).not.toBeNull();
      expect(v5LaunchProblem(tooHigh, { devBuy: true })).toMatchObject({ code: 'DevBuyBelowMinimum', reread: true });

      const hash = await wallet.writeContract({ address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'launch', args: [p.params, { ...p.settings, minDevBuyOut: minOut }], value: p.value });
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      const got = await client.readContract({ address: p.token, abi: erc20Abi, functionName: 'balanceOf', args: [creator.address] });
      expect(got).toBeGreaterThanOrEqual(minOut);
      expect(got).toBe(quotedOut);
    });
  }

  it('maps the stale pins: StaleConfig through Clanker, LockedSharesChanged and LaunchFeeAboveMax from the launcher', async () => {
    const p = await prepared('ETH', 0n);
    await fund(p.params.fuelUsdc);
    const tryLaunch = (s: ContractTokenSettings) =>
      client.simulateContract({ account: creator, address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'launch', args: [p.params, s], value: p.value }).then(
        () => null,
        (e: unknown) => v5LaunchProblem(e),
      );
    expect(await tryLaunch(p.settings)).toBeNull();
    expect(await tryLaunch({ ...p.settings, expectedConfigVersion: p.terms.configVersion - 1n })).toMatchObject({ code: 'StaleConfig', reread: true });
    expect(await tryLaunch({ ...p.settings, expectedPlatformShareBps: p.settings.expectedPlatformShareBps + 1 })).toMatchObject({ code: 'LockedSharesChanged', reread: true });
    if (ADMIN) {
      await testClient.impersonateAccount({ address: ADMIN });
      await testClient.setBalance({ address: ADMIN, value: parseEther('1') });
      const bump = await createWalletClient({ account: ADMIN, chain: base, transport: http(RPC) }).writeContract({ address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'setLaunchFee', args: [p.terms.launchFeeWei + 1n] });
      await client.waitForTransactionReceipt({ hash: bump });
      expect(await tryLaunch(p.settings)).toMatchObject({ code: 'LaunchFeeAboveMax', reread: true });
      const back = await createWalletClient({ account: ADMIN, chain: base, transport: http(RPC) }).writeContract({ address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'setLaunchFee', args: [p.terms.launchFeeWei] });
      await client.waitForTransactionReceipt({ hash: back });
    }
  });

  it('refuses a dev buy without a minimum before anything is created', async () => {
    const p = await prepared('ETH', parseEther('0.001'));
    await fund(p.params.fuelUsdc);
    const err = await client
      .simulateContract({ account: creator, address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'launch', args: [p.params, { ...p.settings, minDevBuyOut: 0n }], value: p.value })
      .then(() => null, (e: unknown) => e);
    expect(v5LaunchProblem(err)).toMatchObject({ code: 'MinDevBuyOutRequired' });
  });
});
