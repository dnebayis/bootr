/**
 * The Clanker v5 token's metadata reads (`IClankerV5Token`, packages/contracts/src/interfaces/IClankerV5.sol): the
 * extra-metadata keys Clanker's SDK and Bootr's launcher write (`image`, `metadata`, `context`) and `contractURI`.
 * An editable coin's creator changes `image` and `metadata` through the launcher (`updateImage`, `updateMetadata`).
 */
export const clankerV5TokenAbi = [
  { type: 'function', name: 'extraMetadata', stateMutability: 'view', inputs: [{ name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'contractURI', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;
