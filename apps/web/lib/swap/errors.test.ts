import { ContractFunctionRevertedError, UserRejectedRequestError, type Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { classifySwapError, SwapFailure, type SwapFailureCode } from './errors';

/** Revert data as the quoter really returned it on a Base fork. */
const NOT_ENOUGH_LIQUIDITY =
  '0x6190b2b0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000247a5ed7348bc634771ded3d01de173219fe3862bd17f80e887b73f81de09c34bad12aa39500000000000000000000000000000000000000000000000000000000';
/** `UnexpectedRevertBytes(WrappedError(hook, afterSwap, PartialFill(), HookCallFailed()))` from the RWAGMI hook. */
const PARTIAL_FILL =
  '0x6190b2b00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000010490bfb865000000000000000000000000b20b00367e37f826a0652c85a6df375d784b20ecb47b2fb1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000004d964f52800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004a9e35b2f00000000000000000000000000000000000000000000000000000000';

const reverted = (raw: `0x${string}`) =>
  new ContractFunctionRevertedError({ abi: [] as Abi, functionName: 'quoteExactInputSingle', data: raw, message: 'reverted' });

const cases: [string, unknown, SwapFailureCode][] = [
  ['a viem rejection', new UserRejectedRequestError(new Error('User rejected the request.')), 'rejected'],
  ['an EIP-1193 rejection', { code: 4001, message: 'nope' }, 'rejected'],
  ['ethers-style rejection', { code: 'ACTION_REJECTED', message: 'denied' }, 'rejected'],
  ['a rejection nested in a cause', { message: 'failed', cause: { cause: { code: 4001 } } }, 'rejected'],
  ['liquidity from the quoter', reverted(NOT_ENOUGH_LIQUIDITY), 'no_liquidity'],
  ['a partial fill the RWAGMI hook refuses', reverted(PARTIAL_FILL), 'no_liquidity'],
  ['the floor by name', { message: 'The contract function reverted', data: { errorName: 'V4TooLittleReceived' } }, 'slippage'],
  // Selector of V4TooLittleReceived(uint256,uint256) inside the router's ExecutionFailed.
  ['the floor by selector', { message: 'execution reverted', cause: { data: '0x2c4029e9000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000408b063d73' } }, 'slippage'],
  ['an unwrap below the floor', { message: 'execution reverted', cause: { data: '0x6a12f104' } }, 'slippage'],
  ['an old deadline', { message: 'execution reverted', data: '0x5bf6f916' }, 'expired'],
  ['a Permit2 allowance that expired', { message: 'x', details: 'AllowanceExpired(123)' }, 'approval'],
  ['too little ETH for gas', { message: 'insufficient funds for gas * price + value' }, 'gas'],
  ['a wallet on another chain', { message: 'The current chain of the wallet (id: 1) does not match the target chain for the transaction' }, 'wrong_chain'],
  ['an unnamed revert', { message: 'execution reverted' }, 'reverted'],
  ['a dead connection', { message: 'Failed to fetch' }, 'network'],
  ['anything else', { message: 'something odd' }, 'reverted'],
];

describe('classifySwapError', () => {
  it.each(cases)('%s', (_name, error, code) => {
    expect(classifySwapError(error)).toBe(code);
  });

  it('an unnamed revert during the launch window is the launch window', () => {
    const launchWindow = { armed: true, endsAt: 1000 };
    expect(classifySwapError({ message: 'execution reverted' }, { launchWindow, now: 999 })).toBe('launch_window');
    expect(classifySwapError({ message: 'execution reverted' }, { launchWindow, now: 1000 })).toBe('reverted');
    expect(classifySwapError({ message: 'execution reverted' }, { launchWindow: { armed: false, endsAt: 1000 }, now: 999 })).toBe('reverted');
    // A floor is a floor, even then.
    expect(classifySwapError({ message: 'execution reverted', data: '0x8b063d73' }, { launchWindow, now: 999 })).toBe('slippage');
  });

  it('keeps a failure already classified', () => {
    expect(classifySwapError(new SwapFailure('no_pool'))).toBe('no_pool');
    expect(SwapFailure.from(new SwapFailure('gas')).code).toBe('gas');
  });

  it('every message is readable, without raw errors or advice', () => {
    const codes: SwapFailureCode[] = ['not_connected', 'wrong_chain', 'no_balance', 'rejected', 'slippage', 'no_liquidity', 'no_pool', 'launch_window', 'approval', 'expired', 'gas', 'network', 'reverted'];
    for (const code of codes) {
      const { message } = new SwapFailure(code);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/0x|revert|selector|profit|\bgains?\b|opportunity/i);
    }
  });
});
