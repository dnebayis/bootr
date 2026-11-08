/**
 * Retention for pictures. A picture is stored twice: its bytes in `sv_images` (what a post attaches) and, as the
 * relay's answer, base64 inside `sv_inference.response` of its `image:<actionId>` row (what makes a crashed step
 * replayable without a second payment). Neither was ever cleaned up. The tick's sweep (`sweepImages`, at most once an
 * hour per process) now:
 *   - empties the `response` of image rows older than RESPONSE_RETENTION_MS whose picture is stored (the replay
 *     path reads `sv_images` by action first, so the response is dead weight once the row exists), and of failed or
 *     pictureless rows of that age too (nothing to replay). The row itself, its payment receipt and its charge stay:
 *     metering (`fuelReport`) and the daily cap count rows, not bytes. The emptied response is marked, so a replay
 *     that somehow reaches it fails as `image_not_generated` instead of finding a picture;
 *   - deletes `sv_images` rows older than IMAGE_RETENTION_MS that no pending review item still refers to (an
 *     approved or rejected item's picture is already on X or never will be). A post already sent keeps its picture
 *     on X; the tape shows the alt text from the action row, which stays.
 */
import { and, inArray, like, lt, sql } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { approvals, images, inference } from './db/schema.js';

/** How long the relay's base64 answer is kept next to the stored picture. */
export const RESPONSE_RETENTION_MS = 24 * 3_600_000;
/** How long a stored picture is kept. The review queue expires in 48 h (approvals.ts), so nothing pending is this old. */
export const IMAGE_RETENTION_MS = 30 * 24 * 3_600_000;
/** The sweep runs at most this often per process. */
export const SWEEP_EVERY_MS = 3_600_000;

/** What stands in for the swept answer: a body `parseImageResponse` reads as "no picture". */
export const SWEPT_RESPONSE = { choices: [], swept: 'the picture bytes were removed after a day; the stored image row, if any, holds the picture' } as const;

export interface ImageSweepReport {
  responsesEmptied: number;
  imagesDeleted: number;
}

/** Last run per supervisor config (one per process; tests get their own). */
const lastRun = new WeakMap<object, number>();

/** Forgets the hourly throttle for one supervisor config (tests). */
export function resetImageSweep(config: object): void {
  lastRun.delete(config);
}

export async function sweepImages(ctx: Pick<SupervisorContext, 'db' | 'now' | 'log' | 'config'>, opts: { force?: boolean } = {}): Promise<ImageSweepReport> {
  const now = ctx.now();
  const last = lastRun.get(ctx.config);
  if (!opts.force && last !== undefined && now - last < SWEEP_EVERY_MS) return { responsesEmptied: 0, imagesDeleted: 0 };
  lastRun.set(ctx.config, now);

  const emptied = await ctx.db
    .update(inference)
    .set({ response: SWEPT_RESPONSE as unknown as Record<string, unknown>, updatedAt: new Date(now) })
    .where(and(like(inference.idempotencyKey, 'image:%'), lt(inference.createdAt, new Date(now - RESPONSE_RETENTION_MS)), sql`${inference.response} is not null`, sql`not (${inference.response} ? 'swept')`))
    .returning({ key: inference.idempotencyKey });

  const pendingImageIds = ctx.db.select({ id: approvals.imageId }).from(approvals).where(and(sql`${approvals.imageId} is not null`, inArray(approvals.status, ['pending_approval'])));
  const deleted = await ctx.db
    .delete(images)
    .where(and(lt(images.createdAt, new Date(now - IMAGE_RETENTION_MS)), sql`${images.id} not in (${pendingImageIds})`))
    .returning({ id: images.id });

  const report = { responsesEmptied: emptied.length, imagesDeleted: deleted.length };
  if (report.responsesEmptied || report.imagesDeleted) ctx.log.info(report, 'image retention sweep');
  return report;
}
