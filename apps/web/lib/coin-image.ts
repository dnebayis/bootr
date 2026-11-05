/**
 * The picture Bootr shows for a coin: the creator's off-chain choice when there is one, else the on-chain image. The on-chain
 * image and the documents wallets read (`/tokens/<id>.json`, `/agents/<id>.json`) never change, so other sites keep showing the original.
 * Every list and page gets the override in one place: the fetchers in `lib/indexer.ts` call `applyCoinImage`. No imports: safe anywhere.
 */

/** Lowercase coin address -> image URI. */
export type CoinImageMap = Record<string, string>;

/** The token with the override in `image` and the original in `imageOnChain`; the same object when it has no override. */
export function applyCoinImage<T extends { id: string; image: string }>(token: T, images: CoinImageMap): T & { imageOnChain?: string } {
  const override = Object.hasOwn(images, token.id.toLowerCase()) ? images[token.id.toLowerCase()] : undefined;
  return override ? { ...token, image: override, imageOnChain: token.image } : token;
}

/** The statement the creator signs for a change of image, or to go back to the original. */
export function coinImageStatement(symbol: string, token: string): string {
  return `Update the image of Bootr coin $${symbol} (${token}).`;
}
