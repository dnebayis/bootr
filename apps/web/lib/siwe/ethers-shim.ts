/**
 * Minimal `ethers` stand-in for the `siwe` package (aliased in next.config.ts).
 * siwe only touches `ethers.utils.{verifyMessage,hashMessage,getAddress}` / v6 equivalents.
 * We never call `SiweMessage.verify()` (signatures are verified with viem, which also handles
 * ERC-1271 / ERC-6492 smart-account signatures), so verifyMessage throws loudly if reached.
 */
import { getAddress, hashMessage } from 'viem';

function verifyMessage(): string {
  throw new Error('ethers shim: use viem verifyMessage instead of SiweMessage.verify()');
}

export const ethers = {
  getAddress: (a: string) => getAddress(a),
  hashMessage: (m: string) => hashMessage(m),
  verifyMessage,
};

const shim = { ethers };
export default shim;
