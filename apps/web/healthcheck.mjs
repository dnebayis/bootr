// Container health check for Coolify's command type, which takes no quotes or brackets: `node healthcheck.mjs`
// asks /api/health on PORT.
/* global process, fetch, AbortSignal */
fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`, { signal: AbortSignal.timeout(4000) }).then(
  (r) => process.exit(r.ok ? 0 : 1),
  () => process.exit(1),
);
