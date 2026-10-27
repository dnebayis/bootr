/** Liveness probe for the container platform (Docker HEALTHCHECK, Railway healthcheckPath). */
export function GET() {
  return Response.json({ ok: true, service: 'web' });
}
