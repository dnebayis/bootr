/**
 * The moment a Clanker v5 launch is prepared (docs/design/clanker-v5-token-settings.md section 8.1), with no React and
 * no env so the launch form, the agent launch API and the tests run the same code:
 *
 * - `readLaunchTerms`: the numbers the creator's pins are made of, read once, right before signing: the launcher's fee
 *   and `agentDefaults()` (the locked shares), Clanker's `configVersion()` and native launch fee.
 * - `quoteDevBuy`: what the dev buy delivers now. The coin's pool does not exist before the launch, so no quoter can
 *   price it: the launch itself is simulated (`eth_simulateV1`: approve the fuel, `launch` with a minimum of 1 coin,
 *   then the creator's balance of the predicted coin), from the creator, with the ETH and the USDC fuel put in the
 *   creator's wallet for the simulation only. The minimum the creator signs is that quote less a slippage tolerance
 *   (`minDevBuyOutFrom`, 3% by default).
 * - `v5LaunchProblem`: the launcher's and Clanker's reverts in plain words, and whether the numbers must be read again.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeAbiParameters,
  erc20Abi,
  keccak256,
  numberToHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { clankerLauncherV5Abi } from './abi/clankerLauncherV5.abi';
import { clankerV5FactoryAbi, type V5LaunchParams } from './clanker-v5';
import { coinsLabel, v5BoundsFromTuple, V5_STRING_CAPS, type ContractTokenSettings, type V5Bounds, type V5Pins } from './token-settings';

// ------------------------------------------------------------------ the live terms

/** What the pins are made of, read in one multicall when the transaction is prepared. */
export type V5LaunchTerms = {
  /** `launcher.launchFeeWei()`: paid with the launch, and signed as `maxLaunchFeeWei`. */
  launchFeeWei: bigint;
  /** `factory.nativeLaunchFee()`: Clanker's own fee (0 on 2026-11-11), part of the value sent. */
  clankerFeeWei: bigint;
  /** `factory.configVersion()`: signed as `expectedConfigVersion`. */
  configVersion: bigint;
  /** `agentDefaults()`: the bounds and the locked shares, signed as the expected shares. */
  bounds: V5Bounds;
  minFuelUsdc: bigint;
};

export async function readLaunchTerms(client: Pick<PublicClient, 'multicall'>, launcher: Address, factory: Address): Promise<V5LaunchTerms> {
  const [launchFeeWei, defaults, configVersion, clankerFeeWei] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: launcher, abi: clankerLauncherV5Abi, functionName: 'launchFeeWei' },
      { address: launcher, abi: clankerLauncherV5Abi, functionName: 'agentDefaults' },
      { address: factory, abi: clankerV5FactoryAbi, functionName: 'configVersion' },
      { address: factory, abi: clankerV5FactoryAbi, functionName: 'nativeLaunchFee' },
    ],
  });
  return { launchFeeWei, clankerFeeWei, configVersion: BigInt(configVersion), bounds: v5BoundsFromTuple(defaults), minFuelUsdc: defaults[3] };
}

/** The pins from the terms just read; `minDevBuyOut` comes from the quote (0 without a dev buy). */
export function pinsOf(terms: Pick<V5LaunchTerms, 'launchFeeWei' | 'configVersion' | 'bounds'>, minDevBuyOut: bigint): V5Pins {
  return {
    minDevBuyOut,
    expectedConfigVersion: terms.configVersion,
    maxLaunchFeeWei: terms.launchFeeWei,
    expectedAgentShareBps: terms.bounds.agentShareBps,
    expectedPlatformShareBps: terms.bounds.platformShareBps,
  };
}

/** What `launch` must carry: the dev buy, the launcher's fee and Clanker's own. */
export function launchValue(devBuyWei: bigint, terms: Pick<V5LaunchTerms, 'launchFeeWei' | 'clankerFeeWei'>): bigint {
  return devBuyWei + terms.launchFeeWei + terms.clankerFeeWei;
}

/**
 * What changed between the numbers the creator was shown and the ones just read, in plain words; null when nothing
 * that is pinned moved. The form asks again rather than signing numbers the creator never saw.
 */
export function termsChanged(shown: { launchFeeWei: bigint; clankerFeeWei: bigint; bounds: Pick<V5Bounds, 'agentShareBps' | 'platformShareBps'> }, live: V5LaunchTerms): string | null {
  const eth = (wei: bigint) => `${Number(wei) / 1e18} ETH`;
  if (live.launchFeeWei !== shown.launchFeeWei) return `The launch fee is now ${eth(live.launchFeeWei)} (it was ${eth(shown.launchFeeWei)}). Check the new total and press Launch again.`;
  if (live.clankerFeeWei !== shown.clankerFeeWei) return `Clanker’s launch fee is now ${eth(live.clankerFeeWei)} (it was ${eth(shown.clankerFeeWei)}). Check the new total and press Launch again.`;
  if (live.bounds.agentShareBps !== shown.bounds.agentShareBps || live.bounds.platformShareBps !== shown.bounds.platformShareBps) {
    return `The locked shares changed to agent ${live.bounds.agentShareBps / 100}% and platform ${live.bounds.platformShareBps / 100}%. Check the new split and press Launch again.`;
  }
  return null;
}

// ------------------------------------------------------------------ the dev buy quote

/**
 * The storage slot of `account`'s USDC balance: Circle's FiatToken v2.2 (USDC on Base and Base Sepolia) keeps
 * `balanceAndBlacklistStates` at slot 9, the balance in the low 255 bits. Checked on Base with `eth_simulateV1`
 * (2026-11-11). Only ever written in a simulation's state override.
 */
export function usdcBalanceSlot(account: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, 9n]));
}

/** A simulated launch that reverted, with the launcher's or Clanker's reason in plain words. */
export class V5LaunchRefused extends Error {
  constructor(readonly problem: V5LaunchProblem) {
    super(problem.message);
    this.name = 'V5LaunchRefused';
  }
}

export type DevBuyQuote = {
  /** The coins the dev buy delivers if the launch went out now (raw, 18 decimals). */
  quotedOut: bigint;
  /** What the creator signs: the quote less the tolerance. */
  minOut: bigint;
  slippagePct: number;
};

/**
 * The dev buy's output right now, from a simulation of the launch itself (see the file comment). `settings` carry the
 * pins already read, with any `minDevBuyOut` > 0 (it is replaced by 1 here). Throws `V5LaunchRefused` when the launch
 * itself reverts (a stale pin, a paused launcher, a missing route), so the creator never signs a launch that cannot go
 * through, and a plain `Error` when the RPC cannot simulate.
 */
export async function quoteDevBuy({
  client,
  launcher,
  usdc,
  creator,
  token,
  params,
  settings,
  value,
}: {
  client: Pick<PublicClient, 'simulateCalls'>;
  launcher: Address;
  usdc: Address;
  creator: Address;
  /** The predicted coin (the mined salt's address). */
  token: Address;
  params: V5LaunchParams;
  settings: ContractTokenSettings;
  value: bigint;
}): Promise<bigint> {
  const { results } = await client.simulateCalls({
    account: creator,
    stateOverrides: [
      { address: creator, balance: value + 10n ** 18n },
      { address: usdc, stateDiff: [{ slot: usdcBalanceSlot(creator), value: numberToHex(params.fuelUsdc, { size: 32 }) }] },
    ],
    calls: [
      { to: usdc, abi: erc20Abi, functionName: 'approve', args: [launcher, params.fuelUsdc] },
      { to: launcher, abi: clankerLauncherV5Abi, functionName: 'launch', args: [params, { ...settings, minDevBuyOut: 1n }], value },
      { to: token, abi: erc20Abi, functionName: 'balanceOf', args: [creator] },
    ],
  });
  const [, launched, balance] = results;
  if (launched?.status !== 'success') {
    const problem = v5LaunchProblem(launched?.error, { devBuy: true });
    throw new V5LaunchRefused(problem ?? { code: 'reverted', message: 'The launch would revert, so the dev buy cannot be quoted. Nothing was sent.', reread: false });
  }
  if (balance?.status !== 'success') throw new Error('The dev buy could not be quoted.');
  return balance.result as bigint;
}

/** Mock mode's stand-in quote: about 500 M coins per ETH, the order of a fresh pool at Clanker's ETH start tick. */
export function mockDevBuyQuote(devBuyWei: bigint): bigint {
  return devBuyWei * 500_000_000n;
}

/** The dev buy's line for the creator: "about 12,345 coins, at least 11,975 (3% slippage)". */
export function devBuyLine(q: DevBuyQuote, symbol: string): string {
  return `About ${coinsLabel(q.quotedOut)} $${symbol}, at least ${coinsLabel(q.minOut)} (${q.slippagePct}% slippage)`;
}

// ------------------------------------------------------------------ the reverts

/** Every error a v5 launch or edit can revert with: the launcher's own and Clanker's, which come through it. */
export const v5LaunchErrorsAbi = [...clankerLauncherV5Abi.filter((e) => e.type === 'error'), ...clankerV5FactoryAbi.filter((e) => e.type === 'error')];

export type V5LaunchProblem = {
  /** The revert's name, or `reverted` for one this file does not know. */
  code: string;
  message: string;
  /** True when the numbers the creator signed are stale: read them again and ask the creator again. */
  reread: boolean;
  /** For `StringTooLong`: the field the launcher names (`name`, `metadata`, …). */
  field?: string;
};

/** The revert's name and arguments, from a viem error (any depth) or raw revert data. */
export function revertOf(err: unknown): { errorName: string; args: readonly unknown[] } | null {
  let raw: Hex | undefined;
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted?.data?.errorName && v5LaunchErrorsAbi.some((e) => e.name === reverted.data!.errorName)) {
      return { errorName: reverted.data.errorName, args: reverted.data.args ?? [] };
    }
    raw = reverted?.raw ?? ((err.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null)?.data as Hex | undefined);
  } else if (typeof err === 'string' && err.startsWith('0x')) {
    raw = err as Hex;
  }
  if (!raw || raw.length < 10) return null;
  try {
    const d = decodeErrorResult({ abi: v5LaunchErrorsAbi, data: raw });
    return { errorName: d.errorName, args: (d.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

const STRING_WORDS: Record<string, string> = {
  name: 'The name',
  symbol: 'The ticker',
  image: 'The image URL',
  contractURI: 'The contract URI',
  agentURI: 'The agent card URL',
  metadata: 'The metadata',
  context: 'The launch context',
  model: 'The model id',
};

/**
 * A v5 launch's (or edit's) revert in plain words. `StaleConfig`, `LockedSharesChanged` and `LaunchFeeAboveMax` mean the
 * pinned numbers moved after they were read (`reread`); the rest are the creator's to fix. Null for an error that is
 * not a revert (a rejected wallet prompt, a network error): the caller shows its own words.
 */
export function v5LaunchProblem(err: unknown, opts: { devBuy?: boolean } = {}): V5LaunchProblem | null {
  const r = revertOf(err);
  if (!r) {
    if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError) && opts.devBuy) {
      // Clanker's swap adapter reverts with its own error when the dev buy delivers less than the signed minimum.
      return { code: 'reverted', message: 'The launch would revert. If the price moved, the dev buy may now deliver fewer coins than your minimum: press Launch again for a fresh quote, or raise the slippage. Nothing was sent.', reread: true };
    }
    return null;
  }
  const a = r.args;
  switch (r.errorName) {
    case 'StaleConfig':
      return { code: 'StaleConfig', message: `Clanker changed its launch settings after this launch was prepared (version ${String(a[0])} is now ${String(a[1])}). Nothing was sent: the new settings are read again, check them and press Launch again.`, reread: true };
    case 'LockedSharesChanged':
      return { code: 'LockedSharesChanged', message: `The locked shares changed to agent ${Number(a[0]) / 100}% and platform ${Number(a[1]) / 100}% after this launch was prepared. Nothing was sent: check the new split and press Launch again.`, reread: true };
    case 'LaunchFeeAboveMax':
      return { code: 'LaunchFeeAboveMax', message: `The launch fee is now ${Number(a[0]) / 1e18} ETH, above the ${Number(a[1]) / 1e18} ETH you were shown. Nothing was sent: check the new total and press Launch again.`, reread: true };
    case 'MinDevBuyOutRequired':
      return { code: 'MinDevBuyOutRequired', message: 'A dev buy needs a minimum number of coins. Nothing was sent: press Launch again to quote the dev buy.', reread: true };
    case 'StringTooLong': {
      const field = String(a[0]);
      return { code: 'StringTooLong', field, message: `${STRING_WORDS[field] ?? field} is ${String(a[1])} bytes; the launcher takes at most ${String(a[2])}. Shorten it and try again.`, reread: false };
    }
    case 'InsufficientValue':
      return { code: 'InsufficientValue', message: 'The ETH sent does not cover the dev buy and the launch fees. Nothing was sent: press Launch again.', reread: true };
    case 'InsufficientFuel':
      return { code: 'InsufficientFuel', message: 'The fuel is under the launcher’s minimum. Raise it and try again.', reread: true };
    case 'QuoteNotAllowed':
      return { code: 'QuoteNotAllowed', message: 'The launcher does not take this paired asset right now: pick ETH.', reread: true };
    case 'DevBuyRouteMissing':
      return { code: 'DevBuyRouteMissing', message: 'A dev buy through this paired asset is not available yet: launch without one.', reread: false };
    case 'EnforcedPause':
      return { code: 'EnforcedPause', message: 'Launches are paused by the platform. Nothing was sent.', reread: false };
    case 'NotCoinCreator':
      return { code: 'NotCoinCreator', message: 'Only the wallet that launched this coin can change it.', reread: false };
    case 'MetadataNotEditable':
      return { code: 'MetadataNotEditable', message: 'This coin’s image and metadata are locked for good.', reread: false };
    case 'InvalidTokenAddressSuffix':
    case 'LaunchSaltUsed':
      return { code: r.errorName, message: 'The coin’s address is no longer free. Nothing was sent: press Launch again to find a new one.', reread: true };
    case 'Error': {
      // A require string. Clanker's swap adapter's, under the creator's minimum, read on a Base fork (2026-11-11):
      // "ERR_EXCEEDED_SLIPPAGE:minReturn not reached".
      const reason = String(a[0] ?? '');
      if (/SLIPPAGE|minReturn/i.test(reason)) {
        return { code: 'DevBuyBelowMinimum', message: 'The dev buy would now deliver fewer coins than your minimum (the price moved since the quote). Nothing was sent: press Launch again for a fresh quote, or raise the slippage.', reread: true };
      }
      return { code: 'reverted', message: `The launch reverts: ${reason || 'no reason given'}. Nothing was sent.`, reread: false };
    }
    case 'LaunchCreationDisabled':
      return { code: 'LaunchCreationDisabled', message: 'Clanker is not taking launches right now. Nothing was sent: try again later.', reread: false };
    default:
      return { code: r.errorName, message: `The launcher refuses this launch (${r.errorName}). Nothing was sent.`, reread: false };
  }
}

/** The caps a person reads in the docs and the skill, from the same constants the checks use. */
export const V5_CAPS_TEXT = `name ${V5_STRING_CAPS.name} bytes, symbol ${V5_STRING_CAPS.symbol}, image / contractURI / agentURI ${V5_STRING_CAPS.uri}, metadata ${V5_STRING_CAPS.metadata}, context ${V5_STRING_CAPS.context}, model ${V5_STRING_CAPS.model}`;
