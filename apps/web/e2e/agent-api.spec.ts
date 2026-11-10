import { expect, test } from '@playwright/test';
import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';

/** A throwaway key for the e2e build only (its address owns nothing). */
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function sign(request: Parameters<Parameters<typeof test>[2]>[0]['request'], statement: string) {
  const n = await request.post('/api/agent/nonce');
  expect(n.status()).toBe(200);
  const { nonce } = (await n.json()) as { nonce: string };
  // The e2e build's site origin is the default https://bootr.fun (domain and uri must match it).
  const message = new SiweMessage({
    domain: 'bootr.fun',
    address: account.address,
    statement,
    uri: 'https://bootr.fun',
    version: '1',
    chainId: 84532,
    nonce,
    issuedAt: new Date().toISOString(),
  }).prepareMessage();
  const signature = await account.signMessage({ message });
  return { message, signature };
}

test('agent API: launchThrough picks the Clanker launcher, anything else is refused (mock mode)', async ({ request }) => {
  const auth = await sign(request, 'Prepare a Bootr launch.');
  const launch = { name: 'Basewatch', symbol: 'bwatch', identity: 'A patient onchain analyst for small Base coins.', image: { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` } };
  // Its own client IP: the route allows 5 calls per minute per IP and the other tests here share the default one.
  const headers = { 'x-real-ip': '10.7.0.3' };
  const res = await request.post('/api/agent/launch', { headers, data: { ...auth, launch: { ...launch, launchThrough: 'clanker' } } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { launchThrough: string; transactions: { step: string; note: string }[] };
  expect(body.launchThrough).toBe('clanker');
  expect(body.transactions[1].step).toBe('launch');
  expect(body.transactions[1].note).toContain('BootrClankerLauncher.launch');
  const other = await sign(request, 'Prepare a Bootr launch.');
  const bad = await request.post('/api/agent/launch', { headers, data: { ...other, launch: { ...launch, launchThrough: 'pump' } } });
  expect(bad.status()).toBe(400);
  expect(((await bad.json()) as { message: string }).message).toContain('launchThrough');
});

test('agent API: launchThrough clanker-v5 mines the salt so the coin address ends in cccc (mock mode)', async ({ request }) => {
  const auth = await sign(request, 'Prepare a Bootr launch.');
  const launch = { name: 'Gas Station', symbol: 'gas', identity: 'A patient onchain analyst for small Base coins.', image: { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` } };
  const headers = { 'x-real-ip': '10.7.0.5' };
  const res = await request.post('/api/agent/launch', { headers, data: { ...auth, launch: { ...launch, launchThrough: 'clanker-v5' } } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { launchThrough: string; salt: string; predictedToken: string; saltTries: number; metadata: string; transactions: { step: string; data: string; note: string }[] };
  expect(body.launchThrough).toBe('clanker-v5');
  expect(body.predictedToken.toLowerCase()).toMatch(/^0x[0-9a-f]{36}cccc$/);
  expect(body.saltTries).toBeGreaterThan(0);
  expect(body.salt).toMatch(/^0x[0-9a-f]{64}$/);
  const step = body.transactions.find((t) => t.step === 'launch')!;
  expect(step.note).toContain('BootrClankerLauncherV5.launch');
  expect(step.note).toContain('cccc');
  // The mined salt is the one in the calldata.
  expect(step.data.toLowerCase()).toContain(body.salt.slice(2).toLowerCase());
  // Clanker's page reads the coin's metadata as JSON, on v5 as on v4.
  expect(() => JSON.parse(body.metadata)).not.toThrow();
});

test('agent API: a signed request prepares a launch (mock mode) and returns the transactions to send', async ({ request }) => {
  const auth = await sign(request, 'Prepare a Bootr launch.');
  const res = await request.post('/api/agent/launch', {
    data: {
      ...auth,
      launch: {
        name: 'Quiet Engine',
        symbol: 'qeng',
        identity: 'A patient onchain analyst for small Base coins.',
        image: { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
        fuelUsdc: '20',
        gasEth: '0.001',
        links: { website: 'https://quiet.engine', x: '@quietengine' },
      },
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as {
    launchId: string;
    creator: string;
    agentURI: string;
    transactions: { step: string; to: string; data: string; value: string }[];
    mock?: true;
  };
  expect(body.creator.toLowerCase()).toBe(account.address.toLowerCase());
  expect(body.launchId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.agentURI).toBe(`https://bootr.fun/agents/${body.launchId}.json`);
  expect(body.transactions.map((t) => t.step)).toEqual(['approve', 'launch', 'gas']);
  expect(body.transactions[1].value).toBe('500000000000000');
  expect(body.transactions[2].value).toBe('1000000000000000');
  for (const t of body.transactions) expect(t.data).toMatch(/^0x[0-9a-f]+$/);
  // The hosted agent card and contract URI exist right away, with the identity text.
  const card = await request.get(`/agents/${body.launchId}.json`);
  expect(card.status()).toBe(200);
  expect(JSON.stringify(await card.json())).toContain('patient onchain analyst');
  // The coin's links are in the contract URI: the project's X account as an x.com link, the website as external_link.
  const meta = await request.get(`/tokens/${body.launchId}.json`);
  expect(meta.status()).toBe(200);
  const doc = (await meta.json()) as { external_link: string; socialMediaUrls: { platform: string; url: string }[] };
  expect(doc.external_link).toBe('https://quiet.engine');
  expect(doc.socialMediaUrls).toContainEqual({ platform: 'x', url: 'https://x.com/quietengine' });

  // A replayed nonce is refused.
  const replay = await request.post('/api/agent/launch', { data: { ...auth, launch: { name: 'x', symbol: 'xx', identity: 'a'.repeat(30), image: { dataUrl: 'data:image/png;base64,AA==' } } } });
  expect(replay.status()).toBe(401);
});

test('agent API: validation and the wrong statement are rejected', async ({ request }) => {
  const wrong = await sign(request, 'Sign in to the Bootr console.');
  expect((await request.post('/api/agent/launch', { data: { ...wrong, launch: {} } })).status()).toBe(400);
  const auth = await sign(request, 'Prepare a Bootr launch.');
  const bad = await request.post('/api/agent/launch', { data: { ...auth, launch: { name: 'Nope', symbol: 'toolongsymbol', identity: 'short', image: {} } } });
  expect(bad.status()).toBe(400);
  // A project X link that is not an X profile or a handle is refused before anything is stored.
  const badX = await sign(request, 'Prepare a Bootr launch.');
  const link = await request.post('/api/agent/launch', {
    data: { ...badX, launch: { name: 'Quiet Engine', symbol: 'QENG', identity: 'a'.repeat(30), image: { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }, links: { x: 'https://quiet.engine/x' } } },
  });
  expect(link.status()).toBe(400);
  expect(((await link.json()) as { message: string }).message).toContain('x an x.com link or a handle');
});

test('agent API: the creator gets an X connect URL for its agent (mock mode)', async ({ request }) => {
  const auth = await sign(request, 'Connect the X account of Bootr agent #10388 (0x65958c0e8edf8c596120495acdf6f98f85a5bdf3).');
  const res = await request.post('/api/agent/x-connect', { data: auth });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { url: string; expiresIn: number; mock?: true };
  expect(body.url).toContain('agentId=10388');
  expect(body.expiresIn).toBe(300);
});

test('agent API: links refuses a page on another site and takes a script with no Origin', async ({ request }) => {
  const kernel = '0x00000000000000000000000000000000000000aa';
  // A link that fails its check, so nothing is stored: the 400 shows the request got past the Origin check.
  const data = { links: { telegram: 'https://telegram.org/x' } };
  const headers = { 'x-real-ip': '10.7.0.9' };
  for (const origin of ['https://evil.example', 'null']) {
    const refused = await request.put(`/api/agent/${kernel}/links`, { data, headers: { ...headers, origin } });
    expect(refused.status(), origin).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('forbidden');
  }
  const script = await request.put(`/api/agent/${kernel}/links`, { data, headers });
  expect(script.status()).toBe(400);
  expect(((await script.json()) as { field: string }).field).toBe('telegram');
});
