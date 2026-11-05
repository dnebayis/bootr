import { connection, NextResponse, type NextRequest } from 'next/server';
import { IMAGE, type ImageModelsResponse } from '@/lib/models';
import { currentModels, relayModels } from '@/lib/server/relay-models';

/**
 * GET /api/models -> ModelsResponse
 * The relay is internal in production, so the browser never calls `/v1/models` itself. This route
 * reads it server-side (cached 60 s per instance), prices one thought per model the way the relay
 * quotes, and keeps only the admin's `allowedModels` (same matching as the launch form used to do).
 * Unreachable or unset relay: the built-in list, filtered the same way.
 *
 * GET /api/models?kind=image -> ImageModelsResponse
 * The relay's image generation models (`output_modalities` with `image`) priced per picture, for the
 * creator console's image model select. Not subject to the admin allow-list, which names minds.
 */

export async function GET(req: NextRequest) {
  await connection();
  const headers = { 'Cache-Control': 'public, max-age=60' };
  if (req.nextUrl.searchParams.get('kind') === 'image') {
    const { source, imageModels } = await relayModels();
    const body: ImageModelsResponse = { source, image: IMAGE, models: imageModels };
    return NextResponse.json(body, { headers });
  }
  return NextResponse.json(await currentModels(), { headers });
}
