/**
 * The "Trending" score of a coin: how many different wallets traded it recently, and how much, in a way one wallet
 * cannot buy. Shared by the indexer (`GET /tokens/trending`) and the web's mock mode, so the two cannot drift.
 *
 *   traders = min(wallets, 25)
 *   volume  = sum over wallets of min(wallet volume, $500)
 *   trades  = sum over wallets of min(wallet trades, 5)
 *   score   = traders * (log10(1 + volume) + log10(1 + trades))
 *
 * A wallet counts once however much it trades, so a single wash wallet tops out at 1 * (log10(501) + log10(6)) = 3.48,
 * while ten wallets trading $200 each, twice each, score 10 * (log10(2001) + log10(21)) = 46.2. It measures trading
 * activity over the window and nothing else: not quality, not safety, not what the price does next. Many wallets run by
 * one person still count as many; the chain does not say who owns a wallet.
 */
export const TRENDING_WINDOW_HOURS = 6;
export const TRENDING_MAX_TRADERS = 25;
export const TRENDING_WALLET_VOLUME_CAP_USD = 500;
export const TRENDING_WALLET_TRADES_CAP = 5;

/** One wallet's trades of one coin inside the window. */
export type TrendingWallet = { volumeUsd: number; trades: number };

export function trendingScore(wallets: readonly TrendingWallet[]): number {
  const active = wallets.filter((w) => w.trades > 0);
  if (active.length === 0) return 0;
  let volume = 0;
  let trades = 0;
  for (const w of active) {
    volume += Math.min(Number.isFinite(w.volumeUsd) ? Math.max(w.volumeUsd, 0) : 0, TRENDING_WALLET_VOLUME_CAP_USD);
    trades += Math.min(w.trades, TRENDING_WALLET_TRADES_CAP);
  }
  const score = Math.min(active.length, TRENDING_MAX_TRADERS) * (Math.log10(1 + volume) + Math.log10(1 + trades));
  return Math.round(score * 100) / 100;
}
