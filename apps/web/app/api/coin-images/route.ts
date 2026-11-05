import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { readCoinImages } from '@/lib/server/coin-images';

/**
 * GET /api/coin-images -> {images: {<lowercase coin address>: <image URI>}}
 * The images creators chose to show on Bootr in place of the on-chain one (`PUT /api/coin/:id/image`). A coin not listed shows
 * its on-chain image. Reads one small local file, nothing else.
 */
export async function GET() {
  const images = env.useMock ? mock.coinImages() : await readCoinImages();
  return NextResponse.json({ images }, { headers: { 'Cache-Control': 'public, max-age=15' } });
}
