// Container health check for Coolify's command type, which takes no quotes or brackets: `node scripts/healthcheck.mjs`
// asks /health on PORT (process up); `node scripts/healthcheck.mjs /ready` asks whether the backfill is complete.
/* global process, fetch, AbortSignal */
const path = process.argv[2] || '/health';
fetch(`http://127.0.0.1:${process.env.PORT || 42069}${path}`, { signal: AbortSignal.timeout(4000) }).then(
  (r) => process.exit(r.ok ? 0 : 1),
  () => process.exit(1),
);
