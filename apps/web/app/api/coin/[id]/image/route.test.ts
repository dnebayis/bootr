import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { mock, mockStore } from '@/lib/mock';
import { coinImageStatement } from '@/lib/coin-image';
import { GET as images } from '@/app/api/coin-images/route';
import { DELETE, IMAGE_STATEMENT, PUT } from './route';

// `connection()` needs a request scope, which a direct handler call does not have.
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), connection: async () => {} }));

const ORIGIN = 'http://localhost:3000';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
type Ctx = RouteContext<'/api/coin/[id]/image'>;

let ip = 0;
function request(id: string, method: 'PUT' | 'DELETE', body: BodyInit, headers: Record<string, string> = {}) {
  // A new address per request: the route's limit is per IP.
  ip += 1;
  return new NextRequest(`${ORIGIN}/api/coin/${id}/image`, { method, body, headers: { origin: ORIGIN, host: 'localhost:3000', 'x-forwarded-for': `203.0.113.${ip}`, ...headers } });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as unknown as Ctx;

function form(file: File | null, fields: Record<string, string> = {}) {
  const f = new FormData();
  if (file) f.set('file', file);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const png = () => new File([PNG], 'coin.png', { type: 'image/png' });

describe('the signed statement', () => {
  it('is what the page signs', () => {
    const coin = `0x${'a'.repeat(40)}`;
    expect(IMAGE_STATEMENT.exec(coinImageStatement('BOOTR', coin))?.slice(1)).toEqual(['BOOTR', coin]);
    expect(IMAGE_STATEMENT.test(`Update the links of Bootr coin $BOOTR (${coin}).`)).toBe(false);
  });
});

describe('PUT /api/coin/[id]/image (mock mode)', () => {
  const coin = mockStore().tokens[5]!;

  it('refuses other origins and a bad address', async () => {
    expect(env.useMock).toBe(true);
    const foreign = await PUT(request(coin.id, 'PUT', form(png()), { origin: 'https://evil.example' }), ctx(coin.id));
    expect(foreign.status).toBe(403);
    expect((await PUT(request('nope', 'PUT', form(png())), ctx('nope'))).status).toBe(400);
  });

  it('checks the file by its bytes', async () => {
    const res = (file: File | null) => PUT(request(coin.id, 'PUT', form(file)), ctx(coin.id));
    expect((await res(null)).status).toBe(400);
    expect(((await (await res(new File(['just text'], 'a.png', { type: 'image/png' }))).json()) as { error: string }).error).toBe('unsupported_type');
    expect((await res(new File([PNG], 'a.jpg', { type: 'image/jpeg' }))).status).toBe(415);
    const svg = await res(new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'], 'a.svg', { type: 'image/svg+xml' }));
    expect(((await svg.json()) as { error: string }).error).toBe('unsafe_svg');
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await res(new File([big], 'big.png', { type: 'image/png' }))).status).toBe(413);
  });

  it('answers 404 for a coin nobody launched', async () => {
    const id = `0x${'9'.repeat(40)}`;
    expect((await PUT(request(id, 'PUT', form(png())), ctx(id))).status).toBe(404);
  });

  it('shows the new image, and the original again after DELETE', async () => {
    const saved = await PUT(request(coin.id, 'PUT', form(png())), ctx(coin.id));
    expect(saved.status).toBe(200);
    const { image } = (await saved.json()) as { image: string };
    expect(image).toMatch(/^data:image\/png;base64,/);
    expect(mock.coinImages()[coin.id.toLowerCase()]).toBe(image);
    expect(((await (await images()).json()) as { images: Record<string, string> }).images[coin.id.toLowerCase()]).toBe(image);
    // The coin's own row is the on-chain image: untouched.
    expect(mockStore().tokens[5]!.image).toBe(coin.image);
    const gone = await DELETE(request(coin.id, 'DELETE', '{}', { 'content-type': 'application/json' }), ctx(coin.id));
    expect(gone.status).toBe(200);
    expect(mock.coinImages()[coin.id.toLowerCase()]).toBeUndefined();
  });
});

describe('real mode', () => {
  const coin = `0x${'c'.repeat(40)}`;
  const creator = `0x${'1'.repeat(40)}`;
  const other = `0x${'2'.repeat(40)}`;
  const verify = vi.hoisted(() => vi.fn());
  const pin = vi.hoisted(() => vi.fn());
  const creatorOf = vi.hoisted(() => vi.fn());
  const store = vi.hoisted(() => ({ set: vi.fn(), clear: vi.fn() }));

  vi.mock('@/lib/server/siwe-verify', () => ({ verifySiwe: verify }));
  vi.mock('@/lib/server/sender', async (original) => ({ ...(await original<object>()), fetchCoinCreator: creatorOf }));
  vi.mock('@/lib/server/coin-images', async (original) => ({ ...(await original<object>()), setCoinImage: store.set, clearCoinImage: store.clear }));
  vi.mock('@/lib/server/ipfs', async (original) => ({ ...(await original<object>()), pinFile: pin }));

  const signedBy = (address: string, token = coin) => ({ ok: true, address, msg: { statement: coinImageStatement('COIN', token) } });

  beforeEach(() => {
    vi.spyOn(env, 'useMock', 'get').mockReturnValue(false);
    vi.stubEnv('PINATA_JWT', 'test-jwt');
    verify.mockReset();
    pin.mockReset();
    creatorOf.mockReset();
    store.set.mockReset();
    store.clear.mockReset();
    creatorOf.mockResolvedValue({ creator, agentId: '7', symbol: 'COIN', metadata: null, xHandle: null });
    pin.mockResolvedValue({ cid: 'bafkqaaa', mock: false });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const put = () => PUT(request(coin, 'PUT', form(png(), { message: 'm', signature: '0xs' })), ctx(coin));

  it('the creator signs: the file is pinned and stored as ipfs://', async () => {
    verify.mockResolvedValue(signedBy(creator));
    const res = await put();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { image: string }).image).toBe('ipfs://bafkqaaa');
    expect(pin).toHaveBeenCalledOnce();
    expect(store.set).toHaveBeenCalledWith(coin, 'ipfs://bafkqaaa', creator);
  });

  it('anyone else is refused before anything is pinned', async () => {
    verify.mockResolvedValue(signedBy(other));
    const res = await put();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('not_creator');
    expect(pin).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('a signature for another coin does not carry over', async () => {
    verify.mockResolvedValue(signedBy(creator, `0x${'d'.repeat(40)}`));
    const res = await put();
    expect(res.status).toBe(400);
    expect(((await res.json()) as { field: string }).field).toBe('statement');
    expect(pin).not.toHaveBeenCalled();
  });

  it('a bad signature is refused with its reason', async () => {
    verify.mockResolvedValue({ ok: false, status: 401, reason: 'bad_signature', error: 'Bad signature.' });
    const res = await put();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'siwe_rejected', reason: 'bad_signature' });
  });

  it('an unknown coin answers 404, an indexer failure 502', async () => {
    verify.mockResolvedValue(signedBy(creator));
    creatorOf.mockResolvedValueOnce(null);
    expect((await put()).status).toBe(404);
    creatorOf.mockRejectedValueOnce(new Error('down'));
    expect((await put()).status).toBe(502);
  });

  it('a bad file never reaches the signature, so the nonce is not spent', async () => {
    const res = await PUT(request(coin, 'PUT', form(new File(['text'], 'a.png', { type: 'image/png' }), { message: 'm', signature: '0xs' })), ctx(coin));
    expect(res.status).toBe(415);
    expect(verify).not.toHaveBeenCalled();
  });

  it('going back to the original takes the same signature', async () => {
    const del = () => DELETE(request(coin, 'DELETE', JSON.stringify({ message: 'm', signature: '0xs' }), { 'content-type': 'application/json' }), ctx(coin));
    verify.mockResolvedValue(signedBy(other));
    expect((await del()).status).toBe(403);
    expect(store.clear).not.toHaveBeenCalled();
    verify.mockResolvedValue(signedBy(creator));
    expect((await del()).status).toBe(200);
    expect(store.clear).toHaveBeenCalledWith(coin);
  });
});
