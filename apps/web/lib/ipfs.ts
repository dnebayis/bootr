/**
 * IPFS helpers shared by the browser and the server (no Node or DOM APIs).
 *
 * Token images are pinned through `/api/upload` (Pinata). The launch writes the gateway URL into
 * `LaunchParams.image` and the hosted ERC-7572 contract URI's `image` (most wallets only render http(s)
 * images), and the `ipfs://<cid>` URI into that contract URI as `imageIpfs`.
 */
import { env } from './env';

/** Gateway URL for a CID (optionally with a path): `<NEXT_PUBLIC_IPFS_GATEWAY>/ipfs/<cid>[/path]`. */
export function ipfsGatewayUrl(cidPath: string): string {
  return `${env.ipfsGateway}/ipfs/${cidPath.replace(/^\/+/, '')}`;
}

/**
 * Display URL for a token image: `ipfs://<cid>` (and the non-standard `ipfs://ipfs/<cid>`) goes
 * through the configured gateway; anything else is returned unchanged.
 */
export function resolveImageSrc(src: string): string {
  const m = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(src.trim());
  return m ? ipfsGatewayUrl(m[1]!) : src;
}

/** Response of `POST /api/upload`. */
export type UploadResult = { cid: string; ipfsUri: string; url: string; mock?: true };

/** Image types `/api/upload` accepts (checked by magic bytes server-side) and its size cap. */
export const UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
