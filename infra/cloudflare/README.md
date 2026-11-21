# Cloudflare: the "updating" page

`maintenance-worker.js` is a Cloudflare Worker in front of bootr.fun. While Coolify redeploys the stack (about a
minute in which every container is stopped and started again), the origin answers 502 to 504, and visitors used to
see Coolify's "503 Service Unavailable / Are you the site owner?" page. With the Worker they see a small Bootr page
that says the site is updating and reloads itself every 15 seconds. When the origin is up, every request passes
through untouched. The API keeps the origin's answer (or gets a JSON 503 with `Retry-After`), and a POST is never
answered with the page.

Tests: `node --test infra/cloudflare/maintenance-worker.test.mjs`.

## Deploy (Cloudflare dashboard, once)

1. **Workers & Pages → Create → Create Worker.** Name it `bootr-updating`, deploy the hello-world, then **Edit code**:
   replace everything with the contents of `maintenance-worker.js` and **Deploy**.
2. **The Worker → Settings → Domains & Routes → Add → Route.**
   - Zone `bootr.fun`, route `bootr.fun/*`.
   - Failure mode: **Fail open (proceed)**, so that if the Worker is ever over its limit or fails, requests go
     straight to the site as they do today.
3. **Leave static files out** (saves Worker requests; the free plan allows 100,000 a day). Add a second route with
   **no Worker**: `bootr.fun/_next/*`.
4. Do not add a route for `indexer.bootr.fun`: its clients are programs, not people.

Check: bootr.fun loads as before. The page itself shows at the next redeploy.

To change the page: edit the file here, run the test, and paste it into the Worker again.
