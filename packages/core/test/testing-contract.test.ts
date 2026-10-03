import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPluginContract, startFakeHttp, startPluginHarness } from '../src/testing/index.js';
import type { PluginHarness } from '../src/testing/index.js';

/** The plugin contract checks and the fake HTTP upstream of `@synoikia/core/testing`, on the echo fixture. */

const ECHO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins/echo');

let h: PluginHarness;

beforeAll(async () => {
  h = await startPluginHarness({ pluginDir: ECHO, connection: { token: 'tok-secret' }, slug: 'echo-contract' });
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe('checkPluginContract', () => {
  it('passes for a plugin that keeps the contract', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'echo.query', code: `return await echo.call('echo.query', { n: 1 });` },
        write: { key: 'echo.set', code: `return await echo.call('echo.set', { name: 'a' });` },
        locked: { key: 'echo.delete', code: `return await echo.call('echo.delete', { name: 'box' });`, confirm: 'box' },
        secrets: { code: `return await echo.call('echo.query', {});`, values: ['tok-secret'] },
      }),
    ).toEqual([]);
  });

  it('reports what breaks the contract', async () => {
    const issues = await checkPluginContract(h, {
      read: { key: 'echo.set', code: `return await echo.call('echo.set', {});` },
      write: { key: 'echo.query', code: `return await echo.call('echo.query', {});` },
      locked: { key: 'echo.delete', code: `return await echo.call('echo.delete', { name: 'box' });`, confirm: 'other' },
      secrets: { code: `return { leaked: 'echo-' + 'leak' };`, values: ['echo-leak'] },
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'echo.set: expected a read',
        'echo.query: expected a write',
        expect.stringMatching(/^write echo.query: expected OPERATION_DISABLED/),
        expect.stringMatching(/^locked echo.delete: confirmation literal is "box"/),
        expect.stringMatching(/^secrets: "echo"… reached the sandbox/),
      ]),
    );
  });

  it('reports an unknown operation', async () => {
    expect(
      await checkPluginContract(h, {
        read: { key: 'echo.nope', code: '' },
        write: { key: 'echo.set', code: '' },
      }),
    ).toEqual(['read: No operation echo.nope in the synced catalog']);
  });
});

describe('startFakeHttp', () => {
  it('routes by method and path params, records requests and answers 404 otherwise', async () => {
    const fake = await startFakeHttp({
      routes: {
        'GET /items/{id}': (req) => ({ body: { id: req.params.id, q: req.query.get('q') } }),
        'POST /items': (req) => ({ status: 201, body: req.body }),
        'GET /text': () => ({ body: 'plain' }),
        'GET /boom': () => {
          throw new Error('kaput');
        },
      },
      guard: (req) => (req.headers.authorization === 'Bearer t' ? undefined : { status: 401, body: { message: 'no' } }),
    });
    try {
      const get = (p: string, init: RequestInit = {}) =>
        fetch(`${fake.url}${p}`, { ...init, headers: { authorization: 'Bearer t', ...init.headers } });
      expect(await (await get('/items/a%20b?q=1')).json()).toEqual({ id: 'a b', q: '1' });
      const created = await get('/items', { method: 'POST', body: '{"x":1}' });
      expect([created.status, await created.json()]).toEqual([201, { x: 1 }]);
      expect(await (await get('/text')).text()).toBe('plain');
      expect((await get('/boom')).status).toBe(500);
      expect((await get('/nope')).status).toBe(404);
      expect((await fetch(`${fake.url}/items/1`)).status).toBe(401);
      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /items/a%20b',
        'POST /items',
        'GET /text',
        'GET /boom',
        'GET /nope',
        'GET /items/1',
      ]);
      expect(fake.requests[1]!.body).toEqual({ x: 1 });
    } finally {
      await fake.close();
    }
  });
});
