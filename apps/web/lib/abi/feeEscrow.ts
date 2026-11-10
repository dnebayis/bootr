import type { Address } from 'viem';

/**
 * Clanker v5's FeeEscrow, the two calls the fee panels need (docs/design/clanker-v5-migration.md, section 3). The v5
 * hook credits every fee slot here on each trade, one balance per recipient and currency across every v5 coin:
 * `owed(recipient, currency)` is the balance, `claimFor(recipient, currency)` pays all of it to `recipient`, whoever
 * sends it (it reverts `NothingToClaim` on zero). Bootr's v5 coins are paired with native ETH, so the currency is the
 * zero address and the payout is ETH.
 */
export const feeEscrowAbi = [
  {
    type: 'function',
    name: 'owed',
    inputs: [
      { name: 'recipient', type: 'address', internalType: 'address' },
      { name: 'currency', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: 'claimableAmount', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claimFor',
    inputs: [
      { name: 'recipient', type: 'address', internalType: 'address' },
      { name: 'currency', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'error', name: 'NothingToClaim', inputs: [] },
] as const;

/** The escrow's currency for native ETH, which every Bootr v5 coin is paired with. */
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as Address;
