/** Runs once per server start: reports missing or weak secrets (H-1) before requests are served. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { configReport } = await import('./lib/server/env');
  const { errors, warnings } = configReport();
  for (const e of errors) console.error(`[web] config error: ${e}`);
  for (const w of warnings) console.warn(`[web] config warning: ${w}`);
}
