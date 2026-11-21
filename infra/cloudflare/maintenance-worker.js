/**
 * Cloudflare Worker in front of bootr.fun: shows Bootr's own "updating" page instead of Coolify's 503 page.
 *
 * Coolify deploys the docker-compose stack by stopping every container and starting the new ones, so for about a
 * minute the origin answers 502, 503 or 504 (or Cloudflare cannot reach it, 52x). Every request goes through to the
 * origin unchanged; only when the origin answers like that, or cannot be reached, does the Worker answer instead:
 *   - a page load (GET that accepts HTML) gets a small page that says the site is updating and reloads itself;
 *   - anything else (the API, scripts, POSTs) gets the origin's own answer, or a 503 JSON body when there was none,
 *     with `Retry-After`, so clients that retry keep working as before.
 * The site never answers 502 to 504 on purpose (no page route does), so nothing real is hidden by this.
 *
 * Deploy: infra/cloudflare/README.md.
 */

const RETRY_AFTER_SECONDS = 15;

/** Answers from the origin that mean "not up right now": the proxy's own errors and Cloudflare's 52x origin errors. */
export function originDown(status) {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 527);
}

export function wantsPage(request) {
  if (request.method !== 'GET') return false;
  return (request.headers.get('accept') || '').includes('text/html');
}

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${RETRY_AFTER_SECONDS}">
<meta name="robots" content="noindex">
<title>bootr is updating</title>
<style>
  :root { color-scheme: light dark; --canvas: #ffffff; --ink: #0a0b0d; --mute: #5b616e; --hairline: #dee1e7; --accent: #0000ff; }
  @media (prefers-color-scheme: dark) { :root { --canvas: #0a0b0d; --ink: #ffffff; --mute: #b1b7c3; --hairline: #1e2025; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; padding: 16px; background: var(--canvas); color: var(--ink);
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; border: 1px solid var(--hairline); border-radius: 16px; padding: 32px; }
  .mark { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 20px; letter-spacing: -0.01em; }
  .mark i { width: 22px; height: 22px; border-radius: 5px; background: var(--accent); display: inline-block; }
  h1 { font-size: 22px; line-height: 1.3; margin: 24px 0 8px; font-weight: 600; }
  p { margin: 0; color: var(--mute); }
  .bar { margin-top: 24px; height: 3px; border-radius: 3px; background: var(--hairline); overflow: hidden; }
  .bar span { display: block; height: 100%; width: 30%; background: var(--accent); animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) { .bar span { animation: none; width: 100%; opacity: 0.4; } }
</style>
</head>
<body>
<main>
  <div class="mark"><i></i>bootr</div>
  <h1>bootr is updating</h1>
  <p>a new version is starting. this page reloads by itself in a few seconds.</p>
  <div class="bar" aria-hidden="true"><span></span></div>
</main>
</body>
</html>`;

function updatingResponse(request, origin) {
  const headers = { 'retry-after': String(RETRY_AFTER_SECONDS), 'cache-control': 'no-store' };
  if (wantsPage(request)) {
    return new Response(PAGE, { status: 503, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
  }
  if (origin) return origin;
  return new Response(JSON.stringify({ error: 'updating', retryAfter: RETRY_AFTER_SECONDS }), {
    status: 503,
    headers: { ...headers, 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request) {
    let origin = null;
    try {
      origin = await fetch(request);
    } catch {
      return updatingResponse(request, null);
    }
    return originDown(origin.status) ? updatingResponse(request, origin) : origin;
  },
};
