import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCodes, HttpJsonClient, queryString } from '../src/index.js';

const SECRET = 'super-secret-token';
const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let server: http.Server;
let base: string;
let sessions = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      const path = req.url!.split('?')[0];
      if (path === '/api/ok') return send(200, { ok: true, echo: body ? JSON.parse(body) : null });
      if (path === '/api/empty') return send(204);
      if (path === '/api/text') return send(200, 'plain');
      if (path === '/api/denied') return send(403, { message: 'no access' });
      if (path === '/api/invalid') return send(422, { message: 'bad field' });
      if (path === '/api/broken') return send(500, 'oops');
      if (path === '/api/redirect') return send(302, '', { location: 'http://evil.example/' });
      if (path === '/api/big') return send(200, 'x'.repeat(2048));
      if (path === '/api/slow') return setTimeout(() => send(200, {}), 500);
      if (path === '/api/session') return req.headers.cookie === 'sid=1' ? send(200, { ok: 1 }) : send(401, {});
      if (path === '/api/login') {
        sessions++;
        return send(200, {}, { 'set-cookie': 'sid=1; HttpOnly' });
      }
      send(404, { message: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => new Promise((r) => server.close(r)));

const client = (opts: Partial<ConstructorParameters<typeof HttpJsonClient>[0]> = {}) =>
  new HttpJsonClient({
    baseUrl: base,
    service: 'Acme',
    headers: () => ({ authorization: `Bearer ${SECRET}` }),
    ...opts,
  });

describe('HttpJsonClient', () => {
  it('sends JSON with auth headers and parses the response', async () => {
    expect(await client().request('POST', '/ok', { body: { a: 1 }, query: { q: ['x', 'y'], n: null } })).toEqual({
      ok: true,
      echo: { a: 1 },
    });
    const req = seen.at(-1)!;
    expect(req.url).toBe('/api/ok?q=x&q=y');
    expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('never sends a body with GET', async () => {
    await client().request('GET', '/ok', { body: { a: 1 } });
    expect(seen.at(-1)!.body).toBe('');
  });

  it('returns null for an empty body and text for non-JSON', async () => {
    expect(await client().request('DELETE', '/empty')).toBeNull();
    expect(await client().request('GET', '/text')).toBe('plain');
  });

  it('maps error statuses without leaking credentials', async () => {
    const errors = await Promise.all(
      ['/denied', '/invalid', '/broken', '/missing'].map((p) =>
        client()
          .request('GET', p)
          .catch((e: unknown) => e),
      ),
    );
    expect(errors.map((e) => (e as { code: string }).code)).toEqual([
      ErrorCodes.UpstreamDenied,
      ErrorCodes.InvalidParams,
      ErrorCodes.UpstreamError,
      ErrorCodes.UpstreamError,
    ]);
    expect((errors[0] as Error).message).toBe('Acme denied GET /denied: insufficient permission (no access)');
    expect((errors[1] as Error).message).toBe('GET /invalid: bad field');
    expect((errors[2] as Error).message).toBe('GET /broken: HTTP 500 (oops)');
    for (const e of errors) expect(JSON.stringify(e) + (e as Error).message).not.toContain(SECRET);
  });

  it('does not follow redirects', async () => {
    await expect(client().request('GET', '/redirect')).rejects.toMatchObject({ code: ErrorCodes.UpstreamError });
    expect(seen.some((r) => r.url?.includes('evil'))).toBe(false);
  });

  it('caps the response size', async () => {
    await expect(client({ maxBytes: 1024 }).request('GET', '/big')).rejects.toThrow('GET /big: response too large');
  });

  it('times out', async () => {
    await expect(client().request('GET', '/slow', { timeoutMs: 50 })).rejects.toThrow('GET /slow: timed out');
  });

  it('reports an unreachable upstream by host only', async () => {
    const c = new HttpJsonClient({ baseUrl: 'http://127.0.0.1:1/api', service: 'Acme' });
    await expect(c.request('GET', '/ok')).rejects.toThrow('Acme is unreachable at 127.0.0.1:1');
  });

  it('refuses paths that leave the base URL', async () => {
    await expect(client().request('GET', '/../../etc')).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
    await expect(client().request('GET', '@evil.example/x')).rejects.toMatchObject({ code: ErrorCodes.InvalidParams });
  });

  it('signs in before the call and again once after a 401', async () => {
    let cookie: string | undefined;
    const c: HttpJsonClient = new HttpJsonClient({
      baseUrl: base,
      service: 'Acme',
      headers: (): Record<string, string> => (cookie ? { cookie } : {}),
      onAuthFailure: async (deadline) => {
        const res = await c.raw('POST', '/login', { deadline });
        cookie = String(res.headers['set-cookie']?.[0]).split(';')[0];
        return true;
      },
    });
    const before = sessions;
    expect(await c.request('GET', '/session')).toEqual({ ok: 1 });
    expect(await c.request('GET', '/session')).toEqual({ ok: 1 });
    expect(sessions - before).toBe(1);
  });
});

describe('queryString', () => {
  it('encodes arrays, objects and drops nulls', () => {
    expect(queryString(undefined)).toBe('');
    expect(queryString({ a: [1, 2], b: { x: 1 }, c: undefined, d: 'é' })).toBe('?a=1&a=2&b=%7B%22x%22%3A1%7D&d=%C3%A9');
  });
});
