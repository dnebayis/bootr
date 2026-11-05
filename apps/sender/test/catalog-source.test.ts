import { describe, expect, it, vi } from 'vitest';
import { CATALOG_RETRY_MS, CATALOG_TTL_MS, CatalogSource } from '../src/catalog-source.js';

const URL_ = 'https://site.test/api/catalog';
const doc = (name: string) => ({
  endpoints: [{ method: 'GET', url: `https://site.test/${name}` }],
});
const ok = (name: string) => new Response(JSON.stringify(doc(name)), { status: 200 });
const firstUrl = (c: { endpoints: { url: string }[] } | null) => c?.endpoints[0]?.url;

function setup(
  impl: typeof fetch,
  over: Partial<ConstructorParameters<typeof CatalogSource>[0]> = {},
) {
  const clock = { t: 1_000 };
  const fetchMock = vi.fn(impl);
  const source = new CatalogSource({ url: URL_, now: () => clock.t, fetch: fetchMock, ...over });
  return { clock, fetchMock, source };
}

/** Lets a refresh that runs behind a reader finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('CatalogSource', () => {
  it('fetches the fixed URL once and serves from memory inside the TTL', async () => {
    const { clock, fetchMock, source } = setup(async () => ok('a'));
    expect(firstUrl(await source.get())).toBe('https://site.test/a');
    clock.t += CATALOG_TTL_MS - 1;
    expect(firstUrl(await source.get())).toBe('https://site.test/a');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('after the TTL answers at once with what it has and refreshes behind the reader', async () => {
    const responses = [ok('old'), ok('new')];
    const { clock, fetchMock, source } = setup(async () => responses.shift()!);
    await source.get();
    clock.t += CATALOG_TTL_MS;
    expect(firstUrl(await source.get())).toBe('https://site.test/old');
    await settle();
    expect(firstUrl(await source.get())).toBe('https://site.test/new');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each<[string, () => Promise<Response>]>([
    ['a network error', () => Promise.reject(new Error('boom'))],
    ['a 500', async () => new Response('oops', { status: 500 })],
    ['a 404', async () => new Response('nope', { status: 404 })],
    ['a body that is not JSON', async () => new Response('<html>', { status: 200 })],
    ['JSON that is not a catalogue', async () => new Response('{"endpoints":[]}', { status: 200 })],
  ])('serves stale data after %s', async (_name, failure) => {
    const responses: (() => Promise<Response>)[] = [async () => ok('kept'), failure];
    const { clock, fetchMock, source } = setup(() => responses.shift()!());
    await source.get();
    clock.t += CATALOG_TTL_MS;
    expect(firstUrl(await source.get())).toBe('https://site.test/kept');
    await settle();
    expect(firstUrl(await source.get())).toBe('https://site.test/kept');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers null when nothing was ever fetched, without rejecting', async () => {
    const { source } = setup(() => Promise.reject(new Error('boom')));
    await expect(source.get()).resolves.toBeNull();
  });

  it('waits out a failure before trying again, then recovers', async () => {
    const { clock, fetchMock, source } = setup(() => Promise.reject(new Error('boom')));
    await source.get();
    await source.get();
    clock.t += CATALOG_RETRY_MS - 1;
    await source.get();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => ok('back'));
    clock.t += 1;
    expect(firstUrl(await source.get())).toBe('https://site.test/back');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one fetch between readers arriving together', async () => {
    let release!: (r: Response) => void;
    const { fetchMock, source } = setup(() => new Promise((resolve) => (release = resolve)));
    const readers = [source.get(), source.get(), source.get()];
    release(ok('a'));
    const results = await Promise.all(readers);
    expect(results.map(firstUrl)).toEqual(Array(3).fill('https://site.test/a'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on a fetch that hangs when the timeout fires', async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const { source } = setup(hang, { timeoutMs: 20 });
    const started = Date.now();
    await expect(source.get()).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('gives up on a body that never ends when the timeout fires', async () => {
    const hang: typeof fetch = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"endpoints":'));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200 });
    };
    const { source } = setup(hang, { timeoutMs: 20 });
    await expect(source.get()).resolves.toBeNull();
  });

  it('refuses a body over the size limit', async () => {
    const { source } = setup(async () => ok('a'), { maxBytes: 10 });
    await expect(source.get()).resolves.toBeNull();
  });
});
