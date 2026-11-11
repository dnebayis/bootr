import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { clankerLauncherV5Abi } from './abi/clankerLauncherV5.abi';
import {
  coinsLabel,
  defaultTokenSettings,
  DEFAULT_DEV_BUY_SLIPPAGE_PCT,
  editProblem,
  FALLBACK_V5_BOUNDS,
  launchStringProblems,
  minDevBuyOutFrom,
  parseSlippagePct,
  toContractSettings,
  utf8Bytes,
  V5_STRING_CAPS,
  viewPins,
  type V5LaunchStrings,
} from './token-settings';
import {
  devBuyLine,
  launchValue,
  pinsOf,
  quoteDevBuy,
  revertOf,
  termsChanged,
  usdcBalanceSlot,
  v5LaunchErrorsAbi,
  v5LaunchProblem,
  V5LaunchRefused,
  type V5LaunchTerms,
} from './v5-launch';

const CREATOR = '0x1111111111111111111111111111111111111111' as Address;
const LAUNCHER = '0x3333333333333333333333333333333333333333' as Address;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const TOKEN = '0x000000000000000000000000000000000000cccc' as Address;

const SOL = readFileSync(fileURLToPath(new URL('../../../packages/contracts/src/BootrClankerLauncherV5.sol', import.meta.url)), 'utf8');
/** A `uint256 public constant NAME = <n>;` of the contract source. */
function constantOf(name: string): number {
  const m = new RegExp(`constant ${name} = (\\d+)`).exec(SOL);
  if (!m) throw new Error(`no ${name} in the contract`);
  return Number(m[1]);
}

const terms: V5LaunchTerms = { launchFeeWei: 500_000_000_000_000n, clankerFeeWei: 0n, configVersion: 7n, bounds: FALLBACK_V5_BOUNDS, minFuelUsdc: 5_000_000n };

/** A revert as viem reports it from `writeContract` / `simulateContract`: the launch's error, wrapped. */
function reverted(errorName: string, args: readonly unknown[] = []): ContractFunctionExecutionError {
  const data = encodeErrorResult({ abi: v5LaunchErrorsAbi as Abi, errorName, args: args as unknown[] });
  const inner = new ContractFunctionRevertedError({ abi: clankerLauncherV5Abi as Abi, data, functionName: 'launch' });
  return new ContractFunctionExecutionError(inner, { abi: clankerLauncherV5Abi as Abi, functionName: 'launch', args: [] });
}

describe('the five pins in TokenSettings', () => {
  it('end the struct in the contract’s order, after contractURI', () => {
    const launch = clankerLauncherV5Abi.find((e) => e.type === 'function' && e.name === 'launch')!;
    const fields = (launch.inputs[1] as { components: readonly { name: string; type: string }[] }).components;
    expect(fields.slice(-6).map((c) => `${c.type} ${c.name}`)).toEqual([
      'string contractURI',
      'uint256 minDevBuyOut',
      'uint64 expectedConfigVersion',
      'uint256 maxLaunchFeeWei',
      'uint16 expectedAgentShareBps',
      'uint16 expectedPlatformShareBps',
    ]);
  });

  it('are built from the terms read when the launch is prepared', () => {
    const pins = pinsOf(terms, 970n);
    expect(pins).toEqual({ minDevBuyOut: 970n, expectedConfigVersion: 7n, maxLaunchFeeWei: 500_000_000_000_000n, expectedAgentShareBps: 500, expectedPlatformShareBps: 3_000 });
    const s = toContractSettings(defaultTokenSettings(CREATOR), 'https://bootr.fun/tokens/x.json', terms.bounds, pins);
    expect(s).toMatchObject(pins);
    expect(s.contractURI).toBe('https://bootr.fun/tokens/x.json');
  });

  it('take the expected shares from the terms just read, not from older bounds', () => {
    const moved = { ...terms, bounds: { ...FALLBACK_V5_BOUNDS, platformShareBps: 3_500 } };
    expect(toContractSettings(defaultTokenSettings(CREATOR), '', FALLBACK_V5_BOUNDS, pinsOf(moved, 0n)).expectedPlatformShareBps).toBe(3_500);
  });

  it('views get zero pins, which only `launch` reads', () => {
    expect(viewPins()).toEqual({ minDevBuyOut: 0n, expectedConfigVersion: 0n, maxLaunchFeeWei: 0n, expectedAgentShareBps: 500, expectedPlatformShareBps: 3_000 });
    expect(toContractSettings(defaultTokenSettings(CREATOR), '').minDevBuyOut).toBe(0n);
  });

  it('the value sent is the dev buy plus both launch fees', () => {
    expect(launchValue(10n ** 16n, { launchFeeWei: 5n, clankerFeeWei: 2n })).toBe(10n ** 16n + 7n);
  });

  it('asks again when a pinned number moved since the form showed it', () => {
    const shown = { launchFeeWei: terms.launchFeeWei, clankerFeeWei: 0n, bounds: FALLBACK_V5_BOUNDS };
    expect(termsChanged(shown, terms)).toBeNull();
    expect(termsChanged(shown, { ...terms, launchFeeWei: 10n ** 15n })).toMatch(/launch fee is now 0\.001 ETH \(it was 0\.0005 ETH\)/);
    expect(termsChanged(shown, { ...terms, clankerFeeWei: 1n })).toMatch(/Clanker’s launch fee/);
    expect(termsChanged(shown, { ...terms, bounds: { ...FALLBACK_V5_BOUNDS, platformShareBps: 4_500 } })).toMatch(/agent 5% and platform 45%/);
  });
});

describe('the dev buy’s minimum', () => {
  it('is the quote less the slippage, 3% by default, rounded down', () => {
    expect(DEFAULT_DEV_BUY_SLIPPAGE_PCT).toBe(3);
    expect(minDevBuyOutFrom(1_000n)).toBe(970n);
    expect(minDevBuyOutFrom(1_000n, 0.5)).toBe(995n);
    expect(minDevBuyOutFrom(999n, 3)).toBe(969n); // 969.03
    expect(minDevBuyOutFrom(10n ** 27n, 50)).toBe(5n * 10n ** 26n);
  });

  it('is never 0 (the launcher refuses a dev buy without one) and refuses an empty quote', () => {
    expect(minDevBuyOutFrom(1n)).toBe(1n);
    expect(() => minDevBuyOutFrom(0n)).toThrow(/empty/);
    expect(() => minDevBuyOutFrom(100n, 100)).toThrow(/out of range/);
  });

  it('takes a slippage of 0.1% to 50%, two decimals', () => {
    expect(parseSlippagePct('3')).toBe(3);
    expect(parseSlippagePct(0.5)).toBe(0.5);
    expect(parseSlippagePct('50')).toBe(50);
    for (const bad of ['0', '0.05', '51', 'three', '1.234', -1, null]) expect(parseSlippagePct(bad), String(bad)).toBeNull();
  });

  it('reads as whole coins for the creator', () => {
    expect(coinsLabel(12_345_678n * 10n ** 18n + 5n)).toBe('12,345,678');
    expect(devBuyLine({ quotedOut: 1_000n * 10n ** 18n, minOut: 970n * 10n ** 18n, slippagePct: 3 }, 'QENG')).toBe('About 1,000 $QENG, at least 970 (3% slippage)');
  });
});

describe('the dev buy quote (a simulation of the launch itself)', () => {
  const params = {
    name: 'Quiet Engine',
    symbol: 'QENG',
    image: 'https://x/i.png',
    metadata: '{}',
    context: '{}',
    salt: keccak256(toHex('d')),
    buybackBurn: false,
    fuelUsdc: 20_000_000n,
    devBuyWei: 10n ** 16n,
    workerHash: keccak256(toHex('w')),
    model: 'm',
    agentURI: 'https://x/a.json',
    supervisorSessionKey: CREATOR,
  };
  const settings = toContractSettings(defaultTokenSettings(CREATOR), 'https://x/c.json', terms.bounds, pinsOf(terms, 1n));

  it('approves the fuel, launches with a minimum of 1 and reads the creator’s coins, with ETH and USDC put in the wallet for the simulation', async () => {
    let seen: { account?: unknown; stateOverrides?: unknown; calls?: readonly { to: Address; functionName?: string; args?: readonly unknown[]; value?: bigint }[] } = {};
    const client = {
      simulateCalls: async (p: typeof seen) => {
        seen = p;
        return { results: [{ status: 'success', result: true }, { status: 'success', result: [TOKEN, CREATOR, CREATOR, 1n] }, { status: 'success', result: 123_456n * 10n ** 18n }] };
      },
    } as never;
    const out = await quoteDevBuy({ client, launcher: LAUNCHER, usdc: USDC, creator: CREATOR, token: TOKEN, params, settings: { ...settings, minDevBuyOut: 999n }, value: launchValue(params.devBuyWei, terms) });
    expect(out).toBe(123_456n * 10n ** 18n);
    expect(seen.account).toBe(CREATOR);
    expect(seen.calls!.map((c) => [c.to, c.functionName])).toEqual([
      [USDC, 'approve'],
      [LAUNCHER, 'launch'],
      [TOKEN, 'balanceOf'],
    ]);
    expect(seen.calls![0]!.args).toEqual([LAUNCHER, 20_000_000n]);
    expect((seen.calls![1]!.args![1] as { minDevBuyOut: bigint }).minDevBuyOut).toBe(1n);
    expect(seen.calls![1]!.value).toBe(10n ** 16n + 500_000_000_000_000n);
    expect(seen.stateOverrides).toEqual([
      { address: CREATOR, balance: 10n ** 16n + 500_000_000_000_000n + 10n ** 18n },
      { address: USDC, stateDiff: [{ slot: usdcBalanceSlot(CREATOR), value: toHex(20_000_000n, { size: 32 }) }] },
    ]);
  });

  it('refuses with the launcher’s reason when the launch itself would revert', async () => {
    const error = reverted('LaunchFeeAboveMax', [10n ** 15n, 5n * 10n ** 14n]).cause as Error;
    const client = { simulateCalls: async () => ({ results: [{ status: 'success', result: true }, { status: 'failure', error }, { status: 'failure', error: new Error('no code') }] }) } as never;
    const p = quoteDevBuy({ client, launcher: LAUNCHER, usdc: USDC, creator: CREATOR, token: TOKEN, params, settings, value: 1n });
    await expect(p).rejects.toBeInstanceOf(V5LaunchRefused);
    await expect(p).rejects.toMatchObject({ problem: { code: 'LaunchFeeAboveMax', reread: true } });
  });

  it('writes the fuel into USDC’s balance slot 9 (FiatToken v2.2), the slot checked on Base', () => {
    // cast index address 0x…c0de 9
    expect(usdcBalanceSlot('0x000000000000000000000000000000000000c0de')).toBe('0x24a3938ef20b222eaa168e1326ab693ac44c865f10ea28fe737c73d7d04f53b5');
  });
});

describe('the reverts in plain words', () => {
  it('stale pins ask for a re-read: StaleConfig (Clanker’s), LockedSharesChanged, LaunchFeeAboveMax', () => {
    expect(v5LaunchProblem(reverted('StaleConfig', [7n, 8n]))).toMatchObject({ code: 'StaleConfig', reread: true, message: expect.stringMatching(/Clanker changed its launch settings .*version 7 is now 8/) });
    expect(v5LaunchProblem(reverted('LockedSharesChanged', [500, 4_500]))).toMatchObject({ code: 'LockedSharesChanged', reread: true, message: expect.stringMatching(/agent 5% and platform 45%/) });
    expect(v5LaunchProblem(reverted('LaunchFeeAboveMax', [10n ** 15n, 5n * 10n ** 14n]))).toMatchObject({ code: 'LaunchFeeAboveMax', reread: true, message: expect.stringMatching(/now 0\.001 ETH, above the 0\.0005 ETH/) });
  });

  it('MinDevBuyOutRequired and StringTooLong name what to do', () => {
    expect(v5LaunchProblem(reverted('MinDevBuyOutRequired'))).toMatchObject({ code: 'MinDevBuyOutRequired', reread: true });
    expect(v5LaunchProblem(reverted('StringTooLong', ['metadata', 4_097n, 4_096n]))).toEqual({
      code: 'StringTooLong',
      field: 'metadata',
      reread: false,
      message: 'The metadata is 4097 bytes; the launcher takes at most 4096. Shorten it and try again.',
    });
  });

  it('decodes raw revert data and the edits’ reverts too', () => {
    const raw = encodeErrorResult({ abi: v5LaunchErrorsAbi as Abi, errorName: 'NotCoinCreator' });
    expect(revertOf(raw)).toEqual({ errorName: 'NotCoinCreator', args: [] });
    expect(v5LaunchProblem(raw)?.code).toBe('NotCoinCreator');
    expect(v5LaunchProblem(reverted('MetadataNotEditable'))?.message).toMatch(/locked for good/);
  });

  it('a dev buy under the signed minimum (Clanker’s adapter, as read on a Base fork) asks for a fresh quote', () => {
    const data = encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }], errorName: 'Error', args: ['ERR_EXCEEDED_SLIPPAGE:minReturn not reached'] });
    const err = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: clankerLauncherV5Abi as Abi, data, functionName: 'launch' }), { abi: clankerLauncherV5Abi as Abi, functionName: 'launch', args: [] });
    expect(v5LaunchProblem(err)).toMatchObject({ code: 'DevBuyBelowMinimum', reread: true, message: expect.stringMatching(/fresh quote, or raise the slippage/) });
    const other = encodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }], errorName: 'Error', args: ['nope'] });
    expect(v5LaunchProblem(other)).toMatchObject({ code: 'reverted', message: 'The launch reverts: nope. Nothing was sent.' });
  });

  it('leaves a rejected wallet prompt or a network error to the caller; an unknown revert with a dev buy suggests a fresh quote', () => {
    expect(v5LaunchProblem(new Error('User rejected the request.'))).toBeNull();
    const unknown = new ContractFunctionRevertedError({ abi: clankerLauncherV5Abi as Abi, data: '0xdeadbeef' as Hex, functionName: 'launch' });
    expect(v5LaunchProblem(unknown)).toBeNull();
    expect(v5LaunchProblem(unknown, { devBuy: true })).toMatchObject({ reread: true, message: expect.stringMatching(/fresh quote/) });
  });
});

describe('the launcher’s byte caps', () => {
  it('are the contract’s own constants', () => {
    expect(V5_STRING_CAPS).toEqual({
      name: constantOf('MAX_NAME_BYTES'),
      symbol: constantOf('MAX_SYMBOL_BYTES'),
      uri: constantOf('MAX_URI_BYTES'),
      metadata: constantOf('MAX_METADATA_BYTES'),
      context: constantOf('MAX_CONTEXT_BYTES'),
      model: constantOf('MAX_MODEL_BYTES'),
    });
  });

  const ok: V5LaunchStrings = { name: 'Quiet Engine', symbol: 'QENG', image: 'https://x/i.png', metadata: '{}', context: '{}', model: 'openai/gpt-5', agentURI: 'https://x/a.json', contractURI: 'https://x/c.json' };

  it('count UTF-8 bytes, as the contract does', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('🚀')).toBe(4);
  });

  it('pass at the cap and fail one byte over, field by field', () => {
    expect(launchStringProblems(ok)).toEqual([]);
    expect(launchStringProblems({ ...ok, name: 'a'.repeat(160) })).toEqual([]);
    expect(launchStringProblems({ ...ok, name: 'a'.repeat(161) })).toEqual([{ field: 'name', message: expect.stringMatching(/^The name is 161 bytes; the launcher takes at most 160\./) }]);
    // 41 rockets: 41 characters, 164 bytes, inside the form's 48 characters but over the contract's 160 bytes
    expect(launchStringProblems({ ...ok, name: '🚀'.repeat(41) })[0]?.field).toBe('name');
    expect(launchStringProblems({ ...ok, metadata: 'x'.repeat(4_097) })[0]).toMatchObject({ field: 'metadata', message: expect.stringMatching(/4,097 bytes; the launcher takes at most 4,096/) });
    expect(launchStringProblems({ ...ok, model: 'm'.repeat(129), agentURI: 'u'.repeat(513), symbol: 'S'.repeat(33), context: 'c'.repeat(513), image: 'i'.repeat(513), contractURI: 'c'.repeat(513) }).map((p) => p.field)).toEqual([
      'symbol',
      'image',
      'context',
      'model',
      'agentURI',
      'contractURI',
    ]);
  });

  it('check the metadata editor’s two values before signing: 512 bytes for the image, 4096 for the metadata', () => {
    expect(editProblem('image', `https://${'a'.repeat(504)}`)).toBeNull();
    expect(editProblem('image', `https://${'é'.repeat(300)}`)).toMatch(/608 bytes; the launcher takes at most 512/);
    expect(editProblem('metadata', 'x'.repeat(4_096))).toBeNull();
    expect(editProblem('metadata', 'x'.repeat(4_097))).toMatch(/4,097 bytes; the launcher takes at most 4,096/);
  });
});
