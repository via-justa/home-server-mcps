import { describe, expect, it, vi } from 'vitest';
import {
  baseKey,
  clip,
  definePlugin,
  ErrorCodes,
  isPlainObject,
  joinApiPath,
  lazy,
  parseBaseUrl,
  PendingRequests,
  PluginError,
  requireString,
  singleFlight,
  splitSuffix,
  statusKind,
  stringOr,
  toGroup,
  truncate,
  tryOr,
  upstreamError,
  withSplit,
} from '../src/index.js';

describe('base URLs', () => {
  it('parses http(s) and strips the trailing slash', () => {
    expect(parseBaseUrl('https://nas.lan/sub/').path).toBe('/sub');
    expect(parseBaseUrl('http://nas.lan').path).toBe('');
  });

  it('rejects malformed URLs and other schemes', () => {
    expect(() => parseBaseUrl('not a url')).toThrow('baseUrl is not a valid URL');
    expect(() => parseBaseUrl('ftp://nas.lan')).toThrow('Unsupported URL scheme ftp:');
  });

  it('joins API paths, switching to ws(s) for websockets', () => {
    expect(joinApiPath('https://seerr.lan/', '/api/v1')).toBe('https://seerr.lan/api/v1');
    expect(joinApiPath('https://u:p@nas.lan:8443/x/?q=1#f', '/api')).toBe('https://nas.lan:8443/x/api');
    expect(joinApiPath('https://ha.lan:8123/', '/api/websocket', { websocket: true })).toBe(
      'wss://ha.lan:8123/api/websocket',
    );
    expect(joinApiPath('http://nas.lan', '/api/current', { websocket: true })).toBe('ws://nas.lan/api/current');
    expect(joinApiPath('wss://nas.lan', '/api/current', { websocket: true })).toBe('wss://nas.lan/api/current');
    expect(() => joinApiPath('ws://nas.lan', '/api')).toThrow('Unsupported URL scheme ws:');
  });
});

describe('upstream errors', () => {
  it('maps HTTP statuses to kinds', () => {
    expect([401, 403, 400, 422, 404, 500].map(statusKind)).toEqual([
      'denied',
      'denied',
      'invalid',
      'invalid',
      'failed',
      'failed',
    ]);
  });

  it('builds the standard messages and codes', () => {
    const denied = upstreamError('Acme', 'denied', 'GET /x', 'nope');
    expect(denied).toMatchObject({
      code: ErrorCodes.UpstreamDenied,
      message: 'Acme denied GET /x: insufficient permission (nope)',
    });
    expect(upstreamError('Acme', 'invalid', 'GET /x', 'bad', { status: 400 })).toMatchObject({
      code: ErrorCodes.InvalidParams,
      message: 'GET /x: bad',
      data: { status: 400 },
    });
    expect(upstreamError('Acme', 'failed', 'GET /x', 'boom').code).toBe(ErrorCodes.UpstreamError);
  });

  it('clips long upstream messages', () => {
    expect(clip('a'.repeat(400))).toHaveLength(301);
    expect(upstreamError('Acme', 'failed', 'op', 'x'.repeat(1000)).message.length).toBeLessThan(320);
  });
});

describe('PendingRequests', () => {
  it('settles requests by id and ignores unknown ids', async () => {
    const pending = new PendingRequests();
    const { id, promise } = pending.start('pool.query', 1000);
    expect(pending.take('nope')).toBeUndefined();
    const settler = pending.take(id)!;
    expect(settler.label).toBe('pool.query');
    settler.resolve(42);
    await expect(promise).resolves.toBe(42);
    expect(pending.take(id)).toBeUndefined();
    expect(pending.size).toBe(0);
  });

  it('times out with the given error', async () => {
    vi.useFakeTimers();
    try {
      const pending = new PendingRequests((label, ms) => new Error(`${label} after ${ms}`));
      const { promise } = pending.start('slow', 50);
      const caught = promise.catch((e: Error) => e.message);
      vi.advanceTimersByTime(60);
      await expect(caught).resolves.toBe('slow after 50');
      expect(pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails everything pending', async () => {
    const pending = new PendingRequests();
    const a = pending.start('a', 1000).promise;
    const b = pending.start('b', 1000);
    expect(pending.fail(b.id, new Error('send failed'))).toBe(true);
    pending.failAll(new Error('closed'));
    await expect(a).rejects.toThrow('closed');
    await expect(b.promise).rejects.toThrow('send failed');
    expect(pending.fail(b.id, new Error('again'))).toBe(false);
  });

  it('defaults to a timed-out upstream error', async () => {
    const { promise } = new PendingRequests().start('x', 1);
    await expect(promise).rejects.toMatchObject({ code: ErrorCodes.UpstreamError, message: 'x: timed out' });
  });
});

describe('singleFlight', () => {
  it('shares the in-flight call and starts anew once it settles', async () => {
    let calls = 0;
    const connect = singleFlight(async (n: number) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return n;
    });
    const [a, b] = await Promise.all([connect(1), connect(2)]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(await connect(3)).toBe(3);
    expect(calls).toBe(2);
  });
});

describe('catalog helpers', () => {
  it('makes valid group names', () => {
    expect(toGroup('Pool.Dataset')).toBe('pool.dataset');
    expect(toGroup('Media Requests!')).toBe('media_requests_');
    expect(toGroup('__x')).toBe('x');
    expect(toGroup('!!!', 'other')).toBe('other');
  });

  it('handles split keys', () => {
    expect(baseKey('cover.open_cover#garage')).toBe('cover.open_cover');
    expect(splitSuffix('cover.open_cover#garage')).toBe('garage');
    expect(splitSuffix('cover.open_cover')).toBeUndefined();
    expect(withSplit('a.b#x', 'y')).toBe('a.b#y');
  });
});

describe('small helpers', () => {
  it('works', async () => {
    expect(requireString({ a: 'x' }, 'a')).toBe('x');
    expect(() => requireString({ a: '' }, 'a')).toThrow('a is required');
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('abc', 3)).toBe('abc');
    expect(await tryOr(() => Promise.reject(new Error('x')))).toBeUndefined();
    expect(await tryOr(() => 1)).toBe(1);
    expect([isPlainObject({}), isPlainObject([]), isPlainObject(null)]).toEqual([true, false, false]);
    expect([stringOr('a'), stringOr(3), stringOr(''), stringOr({})]).toEqual(['a', '3', undefined, undefined]);
  });
});

describe('lazy', () => {
  it('loads once, shares concurrent loads, and reloads after reset', async () => {
    let n = 0;
    const l = lazy(async () => ++n);
    expect(l.peek()).toBeUndefined();
    expect(await Promise.all([l.get(), l.get()])).toEqual([1, 1]);
    expect(l.peek()).toBe(1);
    l.reset();
    expect(await l.get()).toBe(2);
    expect(await l.reload()).toBe(3);
  });

  it('does not cache a failed load', async () => {
    let fail = true;
    const l = lazy(async () => {
      if (fail) throw new Error('down');
      return 'ok';
    });
    await expect(l.get()).rejects.toThrow('down');
    fail = false;
    expect(await l.get()).toBe('ok');
  });

  it('drops a load that finishes after a reset', async () => {
    let release!: () => void;
    const l = lazy(() => new Promise<string>((r) => (release = () => r('stale'))));
    const pending = l.get();
    l.reset();
    release();
    await pending;
    expect(l.peek()).toBeUndefined();
  });
});

describe('definePlugin', () => {
  const init = (config: Record<string, unknown> = { baseUrl: 'https://x' }) => ({
    instanceId: 'i',
    config,
    secrets: { token: 't' },
    sdkVersion: '1',
  });

  function make(opts: { probe?: () => Promise<void>; version?: () => Promise<string> } = {}) {
    const closed: string[] = [];
    let loads = 0;
    const inits: number[] = [];
    const handlers = definePlugin({
      connect: ({ config }) => ({ url: requireString(config, 'baseUrl') }),
      close: (c) => void closed.push(c.url),
      probe: opts.probe,
      version: opts.version ?? (async () => '1.2.3'),
      handlers: (kit) => {
        const catalog = kit.lazy(async () => ++loads);
        kit.onInit(() => inits.push(loads));
        return {
          syncCatalog: async () => ({ upstreamVersion: String(await catalog.get()), operations: [] }),
          resolveOperation: () => ({ key: kit.client().url, params: kit.init().secrets.token }),
          summarize: () => ({ text: 'x' }),
          invoke: async ({ context }) => (context.callId === 'v' ? kit.version() : kit.timeout(context)),
        };
      },
    });
    return { handlers, closed, inits };
  }

  it('refuses calls before init', async () => {
    const { handlers } = make();
    expect(() => handlers.resolveOperation({ fn: 'call', args: [] })).toThrow(PluginError);
  });

  it('builds the client, resets caches and closes the old client on re-init', async () => {
    const { handlers, closed, inits } = make();
    await handlers.init(init({ baseUrl: 'https://a' }));
    expect(await handlers.syncCatalog()).toMatchObject({ upstreamVersion: '1' });
    expect(await handlers.syncCatalog()).toMatchObject({ upstreamVersion: '1' });
    await handlers.init(init({ baseUrl: 'https://b' }));
    expect(closed).toEqual(['https://a']);
    expect(await handlers.syncCatalog()).toMatchObject({ upstreamVersion: '2' });
    expect(handlers.resolveOperation({ fn: 'call', args: [] })).toEqual({ key: 'https://b', params: 't' });
    expect(inits).toEqual([0, 1]);
    await handlers.shutdown!();
    expect(closed).toEqual(['https://a', 'https://b']);
  });

  it('keeps the old client when the new connection is invalid', async () => {
    const { handlers, closed } = make();
    await handlers.init(init({ baseUrl: 'https://a' }));
    await expect(handlers.init(init({}))).rejects.toThrow('baseUrl is required');
    expect(closed).toEqual([]);
  });

  it('reports connection tests without throwing', async () => {
    const ok = make();
    await ok.handlers.init(init());
    expect(await ok.handlers.testConnection()).toEqual({ ok: true, upstreamVersion: '1.2.3' });
    expect(await ok.handlers.getUpstreamVersion()).toBe('1.2.3');
    const bad = make({ probe: () => Promise.reject(new Error('denied')) });
    await bad.handlers.init(init());
    expect(await bad.handlers.testConnection()).toEqual({ ok: false, message: 'denied' });
  });

  it('gives invoke at least a second', async () => {
    const { handlers } = make();
    await handlers.init(init());
    expect(await handlers.invoke({ key: 'k', params: {}, context: { callId: 'c', deadlineMs: 5 } })).toBe(1000);
    expect(await handlers.invoke({ key: 'k', params: {}, context: { callId: 'c', deadlineMs: 5000 } })).toBe(5000);
    expect(await handlers.invoke({ key: 'k', params: {}, context: { callId: 'v', deadlineMs: 5000 } })).toBe('1.2.3');
  });
});
