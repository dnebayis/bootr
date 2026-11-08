import { connection, NextResponse, type NextRequest } from 'next/server';
import { IMAGE, RELAY_IMAGE, type ImageModelsResponse } from '@/lib/models';
import { currentModels, relayModels } from '@/lib/server/relay-models';

/**
 * GET /api/models -> ModelsResponse
 * The models a new agent may think with: the model catalog (`@bootr/agent-core`), priced per thought the way the
 * agent pays BlockRun for one, under the admin's `allowedModels`.
 *
 * GET /api/models?kind=image -> ImageModelsResponse
 * The image models priced per picture on the route pictures take (`source`: the relay's list by default, the catalog
 * at BlockRun's prices with BLOCKRUN_IMAGE_ROUTE=direct), for the creator console's image model select. Not subject to
 * the admin allow-list, which names minds.
 */

export async function GET(req: NextRequest) {
  await connection();
  const headers = { 'Cache-Control': 'public, max-age=60' };
  if (req.nextUrl.searchParams.get('kind') === 'image') {
    const { imageSource, imageModels } = await relayModels();
    const body: ImageModelsResponse = { source: imageSource, image: imageSource === 'blockrun' ? IMAGE : RELAY_IMAGE, models: imageModels };
    return NextResponse.json(body, { headers });
  }
  return NextResponse.json(await currentModels(), { headers });
}
