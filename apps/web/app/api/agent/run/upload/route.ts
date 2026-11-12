import { type NextRequest } from 'next/server';
import { runRoute } from '@/lib/server/own-agent';

/**
 * POST /api/agent/run/upload UploadPictureRequest -> ActResult
 * One picture for a post of this turn, as base64 with its alt text and a one-sentence description; the answer's
 * `result` is an `UploadedPicture` whose `imageId` goes on `publish_post` or `publish_reply`. Body at most 8 MB.
 * For a connected AI client: `Authorization: Bearer <credential>`, 120 requests a minute per client over all run
 * routes, and no `Origin` header (a web page is refused). `lib/server/own-agent.ts` holds the checks.
 */
export async function POST(req: NextRequest) {
  return runRoute(req, 'upload');
}
