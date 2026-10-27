import * as Attribution from 'ox/erc8021/Attribution';
import type { Hex } from 'viem';
import { env } from './env';

function suffix(code: string): Hex | undefined {
  if (!code) return undefined;
  try {
    return Attribution.toDataSuffix({ codes: [code] });
  } catch {
    return undefined;
  }
}

/**
 * ERC-8021 calldata suffix carrying the Bootr Builder Code, or undefined when
 * NEXT_PUBLIC_BUILDER_CODE is unset. Pass as `dataSuffix` to writeContract.
 */
export const builderDataSuffix: Hex | undefined = suffix(env.builderCode);
