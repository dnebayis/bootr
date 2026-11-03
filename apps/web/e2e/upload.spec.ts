import { createHash } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * /api/upload in mock pinning mode (the e2e build has NEXT_PUBLIC_USE_MOCK=1 and no PINATA_JWT):
 * nothing reaches Pinata, the CID is a CIDv1 (raw, sha2-256) of the bytes.
 */

const DRAFT = '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f';
const ORIGIN = 'https://bootr.fun'; // the e2e build's canonical site origin (NEXT_PUBLIC_SITE_URL default)
const GATEWAY = 'https://gateway.pinata.cloud';

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect width="8" height="8" fill="url(#g)"/><use href="#g"/></svg>');

function mockCid(bytes: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const data = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), createHash('sha256').update(bytes).digest()]);
  let out = 'b';
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** Each test uses its own client IP so the 10/min limit of one test does not leak into another. */
function upload(request: APIRequestContext, ip: string, file: { name: string; mimeType: string; buffer: Buffer }, opts: { origin?: string | null; draftId?: string } = {}) {
  const headers: Record<string, string> = { 'x-real-ip': ip };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  return request.post('/api/upload', { headers, multipart: { file, draftId: opts.draftId ?? DRAFT } });
}

test('pins a PNG and an SVG (mock CID, gateway URL, ipfs:// URI)', async ({ request }) => {
  const res = await upload(request, '10.1.0.1', { name: 'coin.png', mimeType: 'image/png', buffer: PNG });
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('no-store');
  const cid = mockCid(PNG);
  expect(await res.json()).toEqual({ cid, ipfsUri: `ipfs://${cid}`, url: `${GATEWAY}/ipfs/${cid}`, mock: true });

  // Deterministic: the same bytes give the same CID.
  const again = await upload(request, '10.1.0.1', { name: 'other-name.png', mimeType: 'image/png', buffer: PNG });
  expect((await again.json()).cid).toBe(cid);

  const svg = await upload(request, '10.1.0.1', { name: 'coin.svg', mimeType: 'image/svg+xml', buffer: SVG });
  expect(svg.status()).toBe(200);
  expect((await svg.json()).cid).toBe(mockCid(SVG));
});

test('rejects an oversized file with 413', async ({ request }) => {
  const big = Buffer.alloc(3 * 1024 * 1024, 0);
  PNG.copy(big, 0, 0, 8); // a real PNG signature: the size check, not the type check, must refuse it
  const res = await upload(request, '10.1.0.2', { name: 'big.png', mimeType: 'image/png', buffer: big });
  expect(res.status()).toBe(413);
  expect((await res.json()).error).toBe('payload_too_large');
});

test('rejects unsupported and disguised types by magic bytes (415)', async ({ request }) => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const r1 = await upload(request, '10.1.0.3', { name: 'coin.gif', mimeType: 'image/gif', buffer: gif });
  expect(r1.status()).toBe(415);
  expect((await r1.json()).error).toBe('unsupported_type');

  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const r2 = await upload(request, '10.1.0.3', { name: 'coin.png', mimeType: 'image/png', buffer: html });
  expect(r2.status()).toBe(415);

  // A PNG declared as WebP: content and declared type disagree.
  const r3 = await upload(request, '10.1.0.3', { name: 'coin.webp', mimeType: 'image/webp', buffer: PNG });
  expect(r3.status()).toBe(415);
});

test('refuses SVGs with scripts, event handlers or external references', async ({ request }) => {
  const bad = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://evil.example/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/p.svg#a)"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>',
  ];
  for (const body of bad) {
    const res = await upload(request, '10.1.0.4', { name: 'coin.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(body) });
    expect(res.status(), body).toBe(415);
  }
});

test('requires same origin, a draft id and a file', async ({ request }) => {
  const file = { name: 'coin.png', mimeType: 'image/png', buffer: PNG };
  expect((await upload(request, '10.1.0.5', file, { origin: 'https://evil.example' })).status()).toBe(403);
  expect((await upload(request, '10.1.0.5', file, { origin: null })).status()).toBe(403);
  expect((await upload(request, '10.1.0.5', file, { draftId: '10388' })).status()).toBe(400);
  const noFile = await request.post('/api/upload', { headers: { origin: ORIGIN, 'x-real-ip': '10.1.0.5' }, multipart: { draftId: DRAFT } });
  expect(noFile.status()).toBe(400);
});

test('rate limits to 10 uploads per minute per IP', async ({ request }) => {
  const file = { name: 'coin.png', mimeType: 'image/png', buffer: PNG };
  for (let i = 0; i < 10; i++) expect((await upload(request, '10.1.0.6', file)).status()).toBe(200);
  const limited = await upload(request, '10.1.0.6', file);
  expect(limited.status()).toBe(429);
  expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);
  expect((await upload(request, '10.1.0.7', file)).status()).toBe(200);
});

test('pins a JSON object with ?kind=json', async ({ request }) => {
  const doc = { type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: 'Quiet Engine agent' };
  const headers = { origin: ORIGIN, 'x-real-ip': '10.1.0.8', 'content-type': 'application/json' };
  const res = await request.post(`/api/upload?kind=json&draftId=${DRAFT}`, { headers, data: doc });
  expect(res.status()).toBe(200);
  const cid = mockCid(Buffer.from(JSON.stringify(doc)));
  expect(await res.json()).toMatchObject({ cid, ipfsUri: `ipfs://${cid}` });
  expect((await request.post(`/api/upload?kind=json&draftId=${DRAFT}`, { headers, data: '[1,2]' })).status()).toBe(400);
  expect((await request.post(`/api/upload?kind=json&draftId=nope`, { headers, data: doc })).status()).toBe(400);
});

test('launch form uploads the image to IPFS and launches with it (mock mode)', async ({ page }) => {
  await page.goto('/launch');
  const status = page.getByTestId('image-status');
  await expect(status).toContainText('pinned to IPFS');
  await expect(page.locator('#image-url')).toHaveCount(0); // no URL / data: URI field any more

  // Client-side type check: nothing is sent.
  await page.locator('#image-file').setInputFiles({ name: 'coin.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await expect(status).toContainText('Use a PNG, JPG, WebP or SVG image.');

  // Server-side refusal is shown inline.
  await page.locator('#image-file').setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>') });
  await expect(status).toContainText('SVG refused: scripts are not allowed.');

  await page.getByLabel('Name').fill('Quiet Engine');
  await page.getByLabel('Symbol').fill('QENG');
  await page.getByLabel('Instructions').fill('A patient onchain analyst for small Base coins.');
  // 03 Kind: presets show their powers and cadence read-only; Custom makes them editable and computes its own hash.
  const summary = page.getByTestId('launch-summary');
  await expect(summary).toContainText('Community');
  await expect(page.getByRole('switch', { name: 'Web research' })).toBeDisabled();
  await page.locator('label', { has: page.getByRole('radio', { name: 'Custom' }) }).click();
  await expect(summary).toContainText('Custom');
  const research = page.getByRole('switch', { name: 'Web research' });
  await expect(research).toBeEnabled();
  await expect(research).toHaveAttribute('aria-checked', 'true');
  await research.click();
  await expect(research).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByLabel('Cadence', { exact: true })).toHaveAttribute('value', '7200000');
  await page.getByLabel('Job line 1', { exact: true }).fill('Your job is the weather on Base, as dated facts.');
  await expect(page.getByTestId('kind-cards')).toContainText(/v1 · 0x[0-9a-f]{8}…/);
  await expect(summary).toContainText('The agent can make bad decisions and lose money.');
  await expect(summary.getByTestId('cost-line')).toContainText('0 ETH + 0.001 ETH + 20 USDC');
  // No X account connected: the form says the agent launches silent and asks for an explicit confirmation.
  await expect(page.getByTestId('no-x-notice')).toContainText('the agent launches silent');
  await page.getByLabel('Launch without an X account; I will connect one later from the coin page.').check();
  const launch = page.getByRole('button', { name: 'Launch', exact: true });
  await expect(launch).toBeDisabled();
  await expect(page.getByText('Upload an image.')).toBeVisible();

  const uploaded = page.waitForResponse((r) => r.url().endsWith('/api/upload') && r.request().method() === 'POST');
  const drafted = page.waitForRequest((r) => r.url().endsWith('/api/launch/draft') && r.method() === 'POST');
  await page.locator('#image-file').setInputFiles({ name: 'coin.png', mimeType: 'image/png', buffer: PNG });
  expect((await uploaded).status()).toBe(200);
  const cid = mockCid(PNG);
  await expect(status).toContainText(`ipfs://${cid}`);
  await expect(status.getByRole('link')).toHaveAttribute('href', `${GATEWAY}/ipfs/${cid}`);
  await expect(page.getByAltText('Coin image preview')).toHaveAttribute('src', /^blob:/);

  // The agent's first gas: 0.001 ETH by default (a second tx after the launch), 0 is allowed, anything under the
  // form minimum is not.
  const gas = page.getByLabel('Gas', { exact: true });
  await expect(gas).toHaveValue('0.001');
  await expect(page.getByText('The agent’s first gas, a second transaction after the launch. It refills from its own fees.')).toBeVisible();
  await gas.fill('0.00001');
  await expect(page.getByText('Gas must be 0 or at least 0.0001 ETH.')).toBeVisible();
  await expect(launch).toBeDisabled();
  await gas.fill('0');
  await expect(page.getByText('Without gas the agent waits; anyone can add gas on the token page.')).toBeVisible();
  await gas.fill('0.002');

  await expect(launch).toBeEnabled();
  await launch.click();
  // The draft carries the custom worker: the preset the on-chain hash commits to, published in the agent card.
  expect((await drafted).postDataJSON()).toMatchObject({
    identity: 'A patient onchain analyst for small Base coins.',
    worker: {
      kind: 'custom',
      preset: { capabilities: { xRead: true, xReply: true, xPublish: true, research: false, memory: true, treasury: true, images: true }, postIntervalMs: 7_200_000, identity: ['Your job is the weather on Base, as dated facts.'] },
    },
  });
  await expect(page.getByText(/Mock: \$QENG launched with 0.002 ETH of gas/)).toBeVisible();
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}/);

  // Launched without an X account: the coin page opens with the creator's connect banner above the stats, keeps
  // the creator-only Fuel and Add gas actions, and shows the agent's wallet to everyone.
  await expect(page.getByTestId('creator-x-banner')).toContainText('waiting for an X account');
  await expect(page.getByTestId('connect-agent-x')).toBeVisible();
  await expect(page.getByTestId('connect-agent-x').getByRole('button', { name: /Connect X/ })).toBeVisible();
  await expect(page.getByTestId('agent-wallet')).toContainText(/0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}/);
  await expect(page.getByRole('button', { name: 'Fuel the agent' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add gas' })).toBeVisible();
  await page.getByTestId('connect-agent-x').getByRole('button', { name: /Connect X/ }).click();
  await expect(page.getByText(/connected\. The agent starts shortly/)).toBeVisible();
});
