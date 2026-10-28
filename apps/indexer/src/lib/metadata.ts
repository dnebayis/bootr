/**
 * Coin image from the launch metadata URI (the B20 `contractURI()`), used when the launch calldata is
 * not available (a smart-wallet batch). A JSON document (inline `data:` URI or plain JSON) yields its
 * `image`; a URI that already points at an image is the image; anything else gives ''.
 */
export function imageFromUri(uri: string): string {
  const u = uri.trim();
  if (!u) return '';
  const json = parseJsonUri(u);
  if (json) return typeof json.image === 'string' ? json.image : '';
  if (/^(https?|ipfs|ar):\/\//i.test(u) && /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/i.test(u)) return u;
  if (/^data:image\//i.test(u)) return u;
  return '';
}

function parseJsonUri(u: string): Record<string, unknown> | null {
  let text: string | null = null;
  const m = /^data:application\/json(;[^,]*)?,(.*)$/is.exec(u);
  if (m) {
    const params = m[1] ?? '';
    try {
      text = /;base64/i.test(params) ? Buffer.from(m[2]!, 'base64').toString('utf8') : decodeURIComponent(m[2]!);
    } catch {
      return null;
    }
  } else if (u.startsWith('{')) {
    text = u;
  }
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
