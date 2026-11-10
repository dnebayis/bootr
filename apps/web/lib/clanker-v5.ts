/**
 * Clanker v5 launch helpers, with no React and no env so the form, the agent launch API and the tests run the same code
 * (docs/design/clanker-v5-migration.md sections 1 and 7).
 *
 * **Salt mining.** Clanker v5 refuses a launch whose token address does not end in `cccc`
 * (`InvalidTokenAddressSuffix`). The token is created with CREATE2 from Clanker's token deployer:
 * `address = create2(tokenDeployer, scopedSalt, initCodeHash)` with
 * `scopedSalt = keccak256(abi.encode(launcher, keccak256(abi.encode(creator, salt))))` (`BootrClankerLauncherV5.scopedSalt`)
 * and `initCodeHash = launcher.tokenInitCodeHash(params)`, which does not depend on the salt. So the hash is read once
 * and the salt is counted up locally until the address ends in `cccc`, the way clanker-sdk's `vanity.ts` does it: about
 * 65,536 tries on average (1 in 16^4). `launcher.predictToken(creator, params)` checks the result on chain.
 */
import { bytesToHex, getAddress, hexToBytes, keccak256, toHex, type Address, type ContractFunctionArgs, type Hex, type PublicClient } from 'viem';
import { clankerLauncherV5Abi } from './abi/clankerLauncherV5.abi';

/** What Clanker's factory checks: the low 16 bits of the token address. */
export const TOKEN_SUFFIX = 'cccc';

/** Tries before giving up: at 1 in 65,536 per try, 2 M tries fail about once in 10^13 launches. */
export const MAX_MINING_ATTEMPTS = 2_000_000;

/** Work between two yields to the event loop, so the page keeps painting (and a server keeps answering). */
const SLICE_MS = 12;
/** Tries between two looks at the clock. */
const CLOCK_EVERY = 256;

/** Clanker v5 supply: 1,000,000,000 coins of 18 decimals (`factory.launchSupply()`, read on Base on 2026-11-10). */
export const CLANKER_V5_SUPPLY = 1_000_000_000;

/**
 * The opening tick Clanker set for native-ETH launches (`factory.quoteConfig(0x0).startTickToken0Frame`, read on Base on
 * 2026-11-10): about 1.86 ETH of market cap. Clanker moves it with the ETH price; the form reads the live value.
 */
export const FALLBACK_V5_START_TICK = -201_000;

/** Market cap in ETH at an opening tick (the tick in the frame where the coin is token0: 1.0001^tick ETH per coin). */
export function openingCapEth(startTick: number, supply = CLANKER_V5_SUPPLY): number {
  return Math.pow(1.0001, startTick) * supply;
}

/** The factory reads the form and the API need (`IClankerV5Factory`). */
export const clankerV5FactoryAbi = [
  {
    type: 'function',
    name: 'quoteConfig',
    stateMutability: 'view',
    inputs: [{ name: 'quoteToken', type: 'address' }],
    outputs: [
      { name: 'registered', type: 'bool' },
      { name: 'quoteDecimals', type: 'uint8' },
      { name: 'startTickToken0Frame', type: 'int24' },
    ],
  },
  { type: 'function', name: 'nativeLaunchFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenDeployer', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export type MiningInput = {
  /** BootrClankerLauncherV5: the factory's caller, which scopes the salt again. */
  launcher: Address;
  /** Clanker's CREATE2 token deployer (`factory.tokenDeployer()`). */
  tokenDeployer: Address;
  /** The wallet that sends `launch` (`msg.sender`). */
  creator: Address;
  /** `launcher.tokenInitCodeHash(params)`. */
  initCodeHash: Hex;
  /** Where counting starts (the form uses `keccak256(draftId)`, so one draft always mines the same salt). */
  startSalt: Hex;
};

export type MinedSalt = { salt: Hex; token: Address; attempts: number; ms: number };

export class SaltMiningError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'SaltMiningError';
  }
}

function addressInto(buf: Uint8Array, offset: number, a: Address) {
  buf.set(hexToBytes(a), offset);
}

/** Adds one to a 32-byte big-endian counter in place (wrapping at 2^256). */
function increment(buf: Uint8Array, offset: number) {
  for (let i = offset + 31; i >= offset; i--) {
    buf[i] = (buf[i]! + 1) & 0xff;
    if (buf[i] !== 0) return;
  }
}

/** The token address a launch with `salt` creates (what `launcher.predictToken(creator, params)` returns). */
export function predictV5Token({ launcher, tokenDeployer, creator, initCodeHash }: Omit<MiningInput, 'startSalt'>, salt: Hex): Address {
  const m = new Miner({ launcher, tokenDeployer, creator, initCodeHash, startSalt: salt });
  return m.token();
}

/** The three keccaks of one try, over preallocated buffers (no ABI encoder in the loop). */
class Miner {
  /** abi.encode(creator, salt) */
  private readonly inner = new Uint8Array(64);
  /** abi.encode(launcher, keccak(inner)) */
  private readonly outer = new Uint8Array(64);
  /** 0xff ‖ deployer ‖ scopedSalt ‖ initCodeHash */
  private readonly create2 = new Uint8Array(85);

  constructor(input: MiningInput) {
    addressInto(this.inner, 12, input.creator);
    this.inner.set(hexToBytes(input.startSalt, { size: 32 }), 32);
    addressInto(this.outer, 12, input.launcher);
    this.create2[0] = 0xff;
    addressInto(this.create2, 1, input.tokenDeployer);
    this.create2.set(hexToBytes(input.initCodeHash, { size: 32 }), 53);
  }

  /** The address hash of the current salt; the address is its last 20 bytes. */
  private hash(): Uint8Array {
    this.outer.set(keccak256(this.inner, 'bytes'), 32);
    this.create2.set(keccak256(this.outer, 'bytes'), 21);
    return keccak256(this.create2, 'bytes');
  }

  /** True when the current salt's address ends in `cccc`. */
  hit(): boolean {
    const h = this.hash();
    return h[30] === 0xcc && h[31] === 0xcc;
  }

  token(): Address {
    return getAddress(bytesToHex(this.hash().slice(12)));
  }

  salt(): Hex {
    return bytesToHex(this.inner.slice(32));
  }

  next() {
    increment(this.inner, 32);
  }
}

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Counts the salt up from `startSalt` until the token address ends in `cccc`. Works in slices of about 12 ms and yields
 * to the event loop between them, so a page stays responsive; stops after `maxAttempts` (or when `signal` aborts) with
 * a `SaltMiningError` whose message can be shown as is. `onProgress` gets the tries so far after each slice.
 */
export async function mineV5Salt(
  input: MiningInput,
  opts: { maxAttempts?: number; signal?: AbortSignal; onProgress?: (attempts: number) => void } = {},
): Promise<MinedSalt> {
  const max = opts.maxAttempts ?? MAX_MINING_ATTEMPTS;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const started = now();
  let sliceStart = started;
  const m = new Miner(input);
  for (let attempts = 1; attempts <= max; attempts++) {
    if (m.hit()) return { salt: m.salt(), token: m.token(), attempts, ms: Math.round(now() - started) };
    m.next();
    if (attempts % CLOCK_EVERY === 0 && now() - sliceStart >= SLICE_MS) {
      opts.onProgress?.(attempts);
      await yieldToLoop();
      if (opts.signal?.aborted) throw new SaltMiningError('Stopped looking for the coin’s address.', attempts);
      sliceStart = now();
    }
  }
  throw new SaltMiningError(
    `No coin address ending in ${TOKEN_SUFFIX} turned up in ${max.toLocaleString('en-US')} tries, which almost never happens. Nothing was sent: try the launch again.`,
    max,
  );
}

/** `LaunchParams` as the v5 launcher takes them (the same struct as the other two launchers). */
export type V5LaunchParams = ContractFunctionArgs<typeof clankerLauncherV5Abi, 'view', 'tokenInitCodeHash'>[0];
/** The launcher's `TokenSettings` (`lib/token-settings.ts` builds it from the form or the agent API). */
export type V5TokenSettingsArg = ContractFunctionArgs<typeof clankerLauncherV5Abi, 'view', 'tokenInitCodeHash'>[1];

/**
 * Mock mode's stand-in for `launcher.tokenInitCodeHash(params, settings)`: no chain to ask, so a hash of what the real
 * one depends on (name, symbol, metadata, image, context, the contract URI and whether metadata stays editable, which
 * changes the token's init code). The mining is real, so a mock v5 coin's address ends in `cccc`.
 */
export function mockInitCodeHash(
  p: Pick<V5LaunchParams, 'name' | 'symbol' | 'metadata' | 'image' | 'context'>,
  s: Pick<V5TokenSettingsArg, 'contractURI' | 'metadataEditable'>,
): Hex {
  return keccak256(toHex(JSON.stringify([p.name, p.symbol, p.metadata, p.image, p.context, s.contractURI, s.metadataEditable])));
}

/**
 * The whole salt step of a v5 launch: reads `launcher.tokenInitCodeHash(params, settings)` once (or the mock stand-in
 * when `client` is null), mines from `params.salt`, and checks the result with `launcher.predictToken(creator, params,
 * settings)`. The returned salt goes into `params.salt`; a mismatch with the chain throws rather than sending a launch
 * that reverts.
 */
export async function mineLaunchSalt({
  client,
  launcher,
  tokenDeployer,
  creator,
  params,
  settings,
  signal,
  onProgress,
}: {
  client: Pick<PublicClient, 'readContract'> | null;
  launcher: Address;
  tokenDeployer: Address;
  creator: Address;
  params: V5LaunchParams;
  settings: V5TokenSettingsArg;
  signal?: AbortSignal;
  onProgress?: (attempts: number) => void;
}): Promise<MinedSalt> {
  const initCodeHash = client
    ? await client.readContract({ address: launcher, abi: clankerLauncherV5Abi, functionName: 'tokenInitCodeHash', args: [params, settings] })
    : mockInitCodeHash(params, settings);
  const mined = await mineV5Salt({ launcher, tokenDeployer, creator, initCodeHash, startSalt: params.salt }, { signal, onProgress });
  if (client) {
    const onChain = await client.readContract({ address: launcher, abi: clankerLauncherV5Abi, functionName: 'predictToken', args: [creator, { ...params, salt: mined.salt }, settings] });
    if (onChain.toLowerCase() !== mined.token.toLowerCase()) {
      throw new SaltMiningError(`The launcher predicts ${onChain} for this salt, not ${mined.token}. Nothing was sent: try again in a moment.`, mined.attempts);
    }
  }
  return mined;
}
