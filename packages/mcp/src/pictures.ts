import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PICTURE_MAX_BYTES, type PictureMime } from '@bootrfun/sdk';

/**
 * The local half of `bootr_agent_upload_picture` (docs/design/byo-agent.md section 1.5): before a single byte leaves
 * the creator's machine, the file must sit inside the one folder the creator set, be a PNG, JPEG or WebP by its first
 * bytes and be at most 5 MB. This is what stops an instruction hidden in a mention from sending a key file or a
 * private document through the upload: a path outside the folder, a link that points out of it, or a file of another
 * kind is refused and nothing is read into a request.
 */

export const DEFAULT_PICTURES_FOLDER = 'bootr-pictures';

/** The only folder the upload reads: `BOOTR_PICTURES_DIR`, else `~/bootr-pictures`. */
export function picturesDir(env: Record<string, string | undefined> = process.env): string {
  const named = env.BOOTR_PICTURES_DIR?.trim();
  return named ? path.resolve(named) : path.join(homedir(), DEFAULT_PICTURES_FOLDER);
}

/** Makes the folder if it is missing, for its owner only. A failure is not an error: the upload will say what is wrong. */
export async function ensurePicturesDir(dir = picturesDir()): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

export const outsideFolder = (dir: string) => `picture_outside_folder: only files inside ${dir} can be uploaded. Nothing was sent.`;
export const NOT_AN_IMAGE = 'picture_not_an_image: that file is not a PNG, JPEG or WebP picture. Nothing was sent.';
export const tooLarge = (bytes: number) => `image_too_large: ${bytes} bytes; a picture is at most 5 MB. Publish your post without a picture.`;

/** The picture type by the file's first bytes, never by its name. */
export function sniffPicture(bytes: Uint8Array): PictureMime | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // RIFF....WEBP
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export type PictureRead = { ok: true; mime: PictureMime; dataBase64: string; bytes: number } | { ok: false; error: string };

/**
 * Reads one picture for upload, or says why not. `file` may be a name inside the folder or a full path; either way the
 * real location (links and `..` resolved) must be inside the real folder. Checked in this order: the folder rule, that
 * it is a plain file, its size, its first bytes. Nothing here talks to the network.
 */
export async function readPicture(file: string, dir = picturesDir()): Promise<PictureRead> {
  const refused = (error: string): PictureRead => ({ ok: false, error });
  if (typeof file !== 'string' || file.trim() === '' || file.includes('\0')) return refused(outsideFolder(dir));
  let root: string;
  let real: string;
  try {
    root = await realpath(dir);
    // A relative name is a name inside the folder, wherever this process happens to run.
    real = await realpath(path.resolve(root, file.trim()));
  } catch {
    // No folder, or no such file: nothing to tell apart for a caller that should not learn what else exists.
    return refused(outsideFolder(dir));
  }
  const inside = path.relative(root, real);
  if (inside === '' || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return refused(outsideFolder(dir));
  let handle;
  try {
    // The real path holds no link; O_NOFOLLOW refuses one swapped in after the check. O_NONBLOCK makes the open of a
    // named pipe (a FIFO somebody put in the folder) return at once: without it the open waits for a writer that
    // never comes and the tool hangs. It changes nothing for a plain file, and what is not one is refused just below.
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return refused(outsideFolder(dir));
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return refused(NOT_AN_IMAGE);
    if (info.size > PICTURE_MAX_BYTES) return refused(tooLarge(info.size));
    // One byte more than allowed is read at most, so a file that grows under us is still caught.
    const buffer = Buffer.alloc(Math.min(info.size, PICTURE_MAX_BYTES) + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length >= buffer.length) break;
    }
    if (length > PICTURE_MAX_BYTES) return refused(tooLarge(length));
    const bytes = buffer.subarray(0, length);
    const mime = sniffPicture(bytes);
    if (!mime) return refused(NOT_AN_IMAGE);
    return { ok: true, mime, dataBase64: bytes.toString('base64'), bytes: length };
  } finally {
    await handle.close();
  }
}
