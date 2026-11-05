import { expect, test } from '@playwright/test';

const TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
// Base Sepolia ERC-8004 IdentityRegistry (packages/shared/src/addresses.ts); e2e runs on 84532.
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

test('token page links the hosted agent card, which carries the registry binding (mock mode)', async ({ page, request }) => {
  await page.goto('/');
  // Last card: seeded fixtures only (the mock simulator prepends tokens the server does not know).
  const href = await page.locator('main a[href^="/token/0x"]').last().getAttribute('href');
  await page.goto(href!);
  await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();

  const card = page.getByRole('link', { name: 'ERC-8004 JSON' });
  await expect(card).toBeVisible();
  const cardUrl = new URL((await card.getAttribute('href'))!);
  expect(cardUrl.pathname).toMatch(/^\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/);

  const agentId = page.getByRole('link', { name: /^#\d+$/ });
  await expect(agentId).toHaveAttribute('href', new RegExp(`^https://sepolia\\.basescan\\.org/nft/${IDENTITY_REGISTRY}/\\d+$`));

  const res = await request.get(cardUrl.pathname);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(res.headers()['cache-control']).toContain('max-age=60');
  const doc = await res.json();
  expect(doc.type).toBe(TYPE);
  expect(doc.name).toMatch(/ agent$/);
  expect(doc.description).toContain('$');
  const tokenAddress = href!.split('/').pop()!;
  expect(doc.services).toContainEqual({ name: 'web', endpoint: expect.stringMatching(new RegExp(`/token/${tokenAddress}$`, 'i')) });
  expect(doc.registrations).toEqual([
    { agentRegistry: `eip155:84532:${IDENTITY_REGISTRY}`, agentId: Number((await agentId.textContent())!.slice(1)) },
  ]);
});

test('agent card for a launch not indexed yet is a minimal, valid document', async ({ request }) => {
  const res = await request.get('/agents/3b241101-e2bb-4255-8caf-4136c566a962.json');
  expect(res.status()).toBe(200);
  const doc = await res.json();
  expect(doc.type).toBe(TYPE);
  expect(doc.registrations).toEqual([]);
});

test('agent card with a malformed id is a JSON 404', async ({ request }) => {
  const res = await request.get('/agents/not-a-launch-id.json');
  expect(res.status()).toBe(404);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(await res.json()).toEqual({ error: 'Unknown agent' });
});

test('the creator identity saved for a draft id is served by its agent card (mock mode)', async ({ request, playwright, baseURL }) => {
  const draftId = crypto.randomUUID();
  const identity = 'A patient onchain analyst for small Base coins.\nShort, plain, no hype.';
  const origin = 'https://bootr.fun'; // NEXT_PUBLIC_SITE_URL default; the route is same-origin only

  const cross = await request.post('/api/launch/draft', { data: { draftId, identity }, headers: { origin: 'https://evil.example' } });
  expect(cross.status()).toBe(403);
  const short = await request.post('/api/launch/draft', { data: { draftId, identity: 'too short' }, headers: { origin } });
  expect(short.status()).toBe(400);
  const badId = await request.post('/api/launch/draft', { data: { draftId: '10388', identity }, headers: { origin } });
  expect(badId.status()).toBe(400);

  const saved = await request.post('/api/launch/draft', { data: { draftId, identity: `  ${identity}  ` }, headers: { origin } });
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toEqual({ ok: true, identity });
  expect(saved.headers()['set-cookie']).toContain('bootr_launch_drafts=');

  const card = await request.get(`/agents/${draftId}.json`);
  expect(card.status()).toBe(200);
  const doc = await card.json();
  expect(doc.type).toBe(TYPE);
  expect(doc.registrations).toEqual([]);
  expect(doc.bootr).toEqual({ identity });
  expect(doc.description.startsWith(identity)).toBe(true);

  // Another browser (a fresh cookie jar) cannot replace the text; the owner (this jar) can.
  const stranger = await playwright.request.newContext({ baseURL });
  try {
    const refused = await stranger.post('/api/launch/draft', { data: { draftId, identity: 'Someone else trying to replace this persona text.' }, headers: { origin } });
    expect(refused.status()).toBe(409);
  } finally {
    await stranger.dispose();
  }
  const changed = await request.post('/api/launch/draft', { data: { draftId, identity: 'The owner changed their mind about the persona.' }, headers: { origin } });
  expect(changed.status()).toBe(200);
  expect((await (await request.get(`/agents/${draftId}.json`)).json()).bootr).toEqual({ identity: 'The owner changed their mind about the persona.' });
});
