/**
 * BootrClankerLauncherV5 ABI with creator-set token settings (docs/design/clanker-v5-token-settings.md section 2), the
 * one place the web names the v5 launcher's functions, events and errors.
 *
 * **Written by hand from the design** while the contract is built on a sibling branch: `launch(p, s)`,
 * `tokenInitCodeHash(p, s)` and `predictToken(creator, p, s)` take the spec's `TokenSettings`; the launcher's own
 * configuration is read through `agentDefaults()` and `allowedQuote(kind, asset)`; the creator's image and metadata
 * edits go through `updateImage`, `updateMetadata` and `lockMetadata`. `AgentLaunched`, `LaunchContext`,
 * `LaunchFeePaid` and `predictKernel` are unchanged from the fixed v5 launcher (forge build of 2026-11-10). At merge,
 * replace this file with the forge output of the settings launcher (packages/contracts/out/BootrClankerLauncherV5.sol)
 * and fix the names that differ in `lib/token-settings.ts` (`v5AgentDefaultsFromTuple`), `lib/clanker-v5.ts` and the
 * console's metadata block; nothing else in the web names these functions.
 */
const launchParams = {
  name: 'p',
  type: 'tuple',
  internalType: 'struct BootrClankerLauncherV5.LaunchParams',
  components: [
    { name: 'name', type: 'string', internalType: 'string' },
    { name: 'symbol', type: 'string', internalType: 'string' },
    { name: 'image', type: 'string', internalType: 'string' },
    { name: 'metadata', type: 'string', internalType: 'string' },
    { name: 'context', type: 'string', internalType: 'string' },
    { name: 'salt', type: 'bytes32', internalType: 'bytes32' },
    { name: 'buybackBurn', type: 'bool', internalType: 'bool' },
    { name: 'fuelUsdc', type: 'uint256', internalType: 'uint256' },
    { name: 'devBuyWei', type: 'uint256', internalType: 'uint256' },
    { name: 'workerHash', type: 'bytes32', internalType: 'bytes32' },
    { name: 'model', type: 'string', internalType: 'string' },
    { name: 'agentURI', type: 'string', internalType: 'string' },
    { name: 'supervisorSessionKey', type: 'address', internalType: 'address' },
  ],
} as const;

/** `TokenSettings` (design section 2.1). Taxes are 1e6-based (15_000 = 1.5%); burn, dividends and rows are bps. */
const tokenSettings = {
  name: 's',
  type: 'tuple',
  internalType: 'struct BootrClankerLauncherV5.TokenSettings',
  components: [
    { name: 'quoteToken', type: 'address', internalType: 'address' },
    { name: 'buyTaxBps', type: 'uint24', internalType: 'uint24' },
    { name: 'sellTaxBps', type: 'uint24', internalType: 'uint24' },
    { name: 'burnBps', type: 'uint16', internalType: 'uint16' },
    { name: 'dividendBps', type: 'uint16', internalType: 'uint16' },
    { name: 'minDividendHolding', type: 'uint256', internalType: 'uint256' },
    {
      name: 'rewards',
      type: 'tuple[]',
      internalType: 'struct BootrClankerLauncherV5.RewardInput[]',
      components: [
        { name: 'recipient', type: 'address', internalType: 'address' },
        { name: 'admin', type: 'address', internalType: 'address' },
        { name: 'bps', type: 'uint16', internalType: 'uint16' },
      ],
    },
    { name: 'antiSnipe', type: 'bool', internalType: 'bool' },
    { name: 'metadataEditable', type: 'bool', internalType: 'bool' },
    { name: 'contractURI', type: 'string', internalType: 'string' },
  ],
} as const;

const launchDefaultsComponents = [
  { name: 'lpFeeBps', type: 'uint24', internalType: 'uint24' },
  { name: 'agentBps', type: 'uint16', internalType: 'uint16' },
  { name: 'creatorBps', type: 'uint16', internalType: 'uint16' },
  { name: 'burnBps', type: 'uint16', internalType: 'uint16' },
  { name: 'platformBps', type: 'uint16', internalType: 'uint16' },
  { name: 'platformRecipient', type: 'address', internalType: 'address' },
  { name: 'minFuelUsdc', type: 'uint256', internalType: 'uint256' },
  { name: 'dormancyPeriod', type: 'uint32', internalType: 'uint32' },
] as const;

const poolKey = {
  name: 'key',
  type: 'tuple',
  internalType: 'struct PoolKey',
  components: [
    { name: 'currency0', type: 'address', internalType: 'address' },
    { name: 'currency1', type: 'address', internalType: 'address' },
    { name: 'fee', type: 'uint24', internalType: 'uint24' },
    { name: 'tickSpacing', type: 'int24', internalType: 'int24' },
    { name: 'hooks', type: 'address', internalType: 'address' },
  ],
} as const;

const tokenArg = { name: 'token', type: 'address', internalType: 'address' } as const;
const err = (name: string) => ({ type: 'error', name, inputs: [] }) as const;

export const clankerLauncherV5Abi = [
  {
    type: 'function',
    name: 'launch',
    stateMutability: 'payable',
    inputs: [launchParams, tokenSettings],
    outputs: [
      { name: 'token', type: 'address', internalType: 'address' },
      { name: 'kernel', type: 'address', internalType: 'address' },
      { name: 'burner', type: 'address', internalType: 'address' },
      { name: 'agentId', type: 'uint256', internalType: 'uint256' },
    ],
  },
  { type: 'function', name: 'tokenInitCodeHash', stateMutability: 'view', inputs: [launchParams, tokenSettings], outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }] },
  {
    type: 'function',
    name: 'predictToken',
    stateMutability: 'view',
    inputs: [{ name: 'creator', type: 'address', internalType: 'address' }, launchParams, tokenSettings],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
  },
  {
    type: 'function',
    name: 'scopedSalt',
    stateMutability: 'view',
    inputs: [
      { name: 'creator', type: 'address', internalType: 'address' },
      { name: 'salt', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'predictKernel',
    stateMutability: 'view',
    inputs: [
      { name: 'creator', type: 'address', internalType: 'address' },
      { name: 'salt', type: 'bytes32', internalType: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
  },
  { type: 'function', name: 'launchFeeWei', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool', internalType: 'bool' }] },
  {
    // The owner's configuration for future agent launches (design section 2.2): the locked slots' floors, the tax bounds
    // and the creator rows allowed. One struct in place of the fixed launcher's two presets.
    type: 'function',
    name: 'agentDefaults',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'agentShareBps', type: 'uint16', internalType: 'uint16' },
      { name: 'platformShareBps', type: 'uint16', internalType: 'uint16' },
      { name: 'platformRecipient', type: 'address', internalType: 'address' },
      { name: 'minFuelUsdc', type: 'uint256', internalType: 'uint256' },
      { name: 'dormancyPeriod', type: 'uint32', internalType: 'uint32' },
      { name: 'minTaxBps', type: 'uint24', internalType: 'uint24' },
      { name: 'maxTaxBps', type: 'uint24', internalType: 'uint24' },
      { name: 'maxRewardRows', type: 'uint8', internalType: 'uint8' },
    ],
  },
  {
    // The paired-asset allow-list per launch kind (`LaunchKind { Agent, Plain }`); Agent starts with ETH and USDC.
    type: 'function',
    name: 'allowedQuote',
    stateMutability: 'view',
    inputs: [
      { name: 'kind', type: 'uint8', internalType: 'enum BootrClankerLauncherV5.LaunchKind' },
      { name: 'asset', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
  },
  { type: 'function', name: 'quoteOf', stateMutability: 'view', inputs: [tokenArg], outputs: [{ name: '', type: 'address', internalType: 'address' }] },
  { type: 'function', name: 'coinCreator', stateMutability: 'view', inputs: [tokenArg], outputs: [{ name: '', type: 'address', internalType: 'address' }] },
  { type: 'function', name: 'metadataLocked', stateMutability: 'view', inputs: [tokenArg], outputs: [{ name: '', type: 'bool', internalType: 'bool' }] },
  { type: 'function', name: 'poolKeyFor', stateMutability: 'view', inputs: [tokenArg], outputs: [poolKey] },
  {
    type: 'function',
    name: 'updateImage',
    stateMutability: 'nonpayable',
    inputs: [tokenArg, { name: 'image', type: 'string', internalType: 'string' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateMetadata',
    stateMutability: 'nonpayable',
    inputs: [tokenArg, { name: 'metadata', type: 'string', internalType: 'string' }],
    outputs: [],
  },
  { type: 'function', name: 'lockMetadata', stateMutability: 'nonpayable', inputs: [tokenArg], outputs: [] },
  {
    type: 'event',
    name: 'AgentLaunched',
    anonymous: false,
    inputs: [
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'kernel', type: 'address', indexed: true, internalType: 'address' },
      { name: 'creator', type: 'address', indexed: true, internalType: 'address' },
      { name: 'burner', type: 'address', indexed: false, internalType: 'address' },
      { name: 'agentId', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'defaults', type: 'tuple', indexed: false, internalType: 'struct BootrClankerLauncherV5.LaunchDefaults', components: launchDefaultsComponents },
      { name: 'workerHash', type: 'bytes32', indexed: false, internalType: 'bytes32' },
      { name: 'model', type: 'string', indexed: false, internalType: 'string' },
      { name: 'agentURI', type: 'string', indexed: false, internalType: 'string' },
      { name: 'supervisorSessionKey', type: 'address', indexed: false, internalType: 'address' },
    ],
  },
  {
    type: 'event',
    name: 'ClankerV5Launched',
    anonymous: false,
    inputs: [
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'poolId', type: 'bytes32', indexed: false, internalType: 'bytes32' },
      { name: 'hook', type: 'address', indexed: false, internalType: 'address' },
      { name: 'feeEscrow', type: 'address', indexed: false, internalType: 'address' },
      { name: 'quoteToken', type: 'address', indexed: false, internalType: 'address' },
      { name: 'tickSpacing', type: 'int24', indexed: false, internalType: 'int24' },
      { name: 'buyTaxBps', type: 'uint24', indexed: false, internalType: 'uint24' },
      { name: 'sellTaxBps', type: 'uint24', indexed: false, internalType: 'uint24' },
      { name: 'burnBps', type: 'uint16', indexed: false, internalType: 'uint16' },
      { name: 'dividendBps', type: 'uint16', indexed: false, internalType: 'uint16' },
      { name: 'antiSnipe', type: 'bool', indexed: false, internalType: 'bool' },
      { name: 'metadataEditable', type: 'bool', indexed: false, internalType: 'bool' },
    ],
  },
  {
    type: 'event',
    name: 'LaunchContext',
    anonymous: false,
    inputs: [
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'context', type: 'string', indexed: false, internalType: 'string' },
    ],
  },
  {
    type: 'event',
    name: 'LaunchFeePaid',
    anonymous: false,
    inputs: [
      { name: 'token', type: 'address', indexed: true, internalType: 'address' },
      { name: 'recipient', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
  },
  { type: 'event', name: 'MetadataLocked', anonymous: false, inputs: [{ name: 'token', type: 'address', indexed: true, internalType: 'address' }] },
  err('EmptyNameOrSymbol'),
  err('EnforcedPause'),
  err('InsufficientFuel'),
  err('InsufficientValue'),
  err('ZeroAddress'),
  // The settings checks of design section 2.2, one error each.
  err('QuoteNotAllowed'),
  err('TaxOutOfBounds'),
  err('AllocationOverflow'),
  err('InvalidRewards'),
  err('DividendHoldingMismatch'),
  err('NotCoinCreator'),
  err('MetadataNotEditable'),
] as const;
