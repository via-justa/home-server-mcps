import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildOpenApiCatalog,
  classifyRest,
  compileRules,
  ErrorCodes,
  fetchSpec,
  fillTemplate,
  HttpJsonClient,
  matchPath,
  OperationDescriptorSchema,
  parseOpenApi,
  parsePluginSettings,
  restBinding,
  SpecError,
  staticCatalog,
  staticHttpBinding,
} from '../src/index.js';
import type { OpenApiCatalog } from '../src/index.js';

const SPEC = `
openapi: 3.0.2
components:
  schemas:
    Item: { type: object, properties: { id: { type: number }, child: { $ref: '#/components/schemas/Item' } } }
  parameters:
    itemId: { name: itemId, in: path, required: true, schema: { type: number } }
paths:
  /items:
    get: { summary: List items, tags: [Items], parameters: [{ name: take, in: query, schema: { type: number } }] }
    post:
      summary: Create an item
      tags: [Items]
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Item' } } } }
  /items/{itemId}:
    parameters: [{ $ref: '#/components/parameters/itemId' }]
    get: { summary: Get an item, tags: [Items] }
    delete: { summary: Delete an item, tags: [Items] }
  /items/{itemId}/{action}:
    post: { summary: Act, tags: [Items], parameters: [{ name: itemId, in: path }, { name: action, in: path }] }
  /items/{itemId}/retry:
    post: { summary: Retry, tags: [Items], parameters: [{ name: itemId, in: path }] }
  /cache/flush:
    get: { summary: Flush the cache, tags: [Settings] }
  /status/sync:
    get: { summary: Status of the last sync, tags: [Settings] }
  /internal/debug:
    get: { summary: Debug }
  /../escape:
    get: { summary: nope }
  /bad path:
    get: { summary: nope }
`;

const rules = compileRules(
  parsePluginSettings({
    exclude: ['* /internal/*'],
    rules: [
      { match: 'DELETE /items/{itemId}', locked: true, confirm: { param: '/path/itemId' } },
      { match: 'POST /items/{itemId}/{action}', split: 'other-user' },
      { match: '*#other-user', description: 'Acting for another user: locked.', summaryNote: "(another user's item)" },
      { match: 'GET /status/sync', classification: 'read', reason: 'verb:GET', needsReview: false },
      { match: 'POST /items', matchProfile: 'item' },
    ],
  }),
);

const catalog = buildOpenApiCatalog(SPEC, { service: 'Acme', rules });
const op = (key: string) => catalog.operations.find((o) => o.key === key);

describe('parseOpenApi', () => {
  it('refuses anything but a plausible OpenAPI 3 document', () => {
    expect(() => parseOpenApi('openapi: "2.0"\npaths: {}', 'Acme')).toThrow('The Acme API spec is not OpenAPI 3.0');
    expect(() => parseOpenApi('{{{ not yaml', 'Acme')).toThrow(SpecError);
    expect(() => parseOpenApi('', 'Acme')).toThrow('The Acme API spec is empty');
    expect(() => parseOpenApi('openapi: 3.0.0\n')).toThrow('The API spec has no paths');
    expect(parseOpenApi('{"openapi": "3.1.0", "paths": {}}')).toMatchObject({ openapi: '3.1.0' });
  });

  it('caps YAML alias expansion', () => {
    const bomb = [
      'a: &a [x,x,x,x,x,x,x,x,x]',
      ...Array.from(
        { length: 12 },
        (_, i) =>
          `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)}]`,
      ),
    ].join('\n');
    expect(() => parseOpenApi(`openapi: 3.0.0\npaths: {}\n${bomb}`)).toThrow(SpecError);
  });
});

describe('classifyRest', () => {
  it('reads GETs, writes everything else and flags action-shaped GETs', () => {
    expect(classifyRest('GET /x', 'List things')).toEqual({
      classification: 'read',
      classificationReason: 'verb:GET',
      needsReview: false,
    });
    expect(classifyRest('PUT /x', '')).toMatchObject({ classification: 'write', classificationReason: 'verb:PUT' });
    expect(classifyRest('GET /x', 'Reset everything')).toMatchObject({ classification: 'write', needsReview: true });
    expect(classifyRest('GET /x', 'Reset everything', null)).toMatchObject({ classification: 'read' });
  });
});

describe('buildOpenApiCatalog', () => {
  it('builds valid descriptors, skipping excluded and unsafe paths', () => {
    expect(catalog.operations.map((o) => o.key)).toEqual([
      'DELETE /items/{itemId}',
      'GET /cache/flush',
      'GET /items',
      'GET /items/{itemId}',
      'GET /status/sync',
      'POST /items',
      'POST /items/{itemId}/{action}',
      'POST /items/{itemId}/{action}#other-user',
      'POST /items/{itemId}/retry',
    ]);
    for (const d of catalog.operations) expect(() => OperationDescriptorSchema.parse(d), d.key).not.toThrow();
  });

  it('groups by tag, resolves refs and carries docs', () => {
    expect(op('GET /items')).toMatchObject({
      kind: 'rest',
      group: 'items',
      classification: 'read',
      docs: { summary: 'List items' },
      paramsSchema: { properties: { query: { properties: { take: { type: 'number' } } } } },
    });
    expect(op('GET /items/{itemId}')).toMatchObject({
      paramsSchema: { properties: { path: { properties: { itemId: { type: 'number' } }, required: ['itemId'] } } },
    });
    expect(op('POST /items')).toMatchObject({
      matchProfile: 'item',
      paramsSchema: {
        properties: { body: { properties: { child: { description: 'See #/components/schemas/Item' } } } },
      },
    });
    expect(op('GET /cache/flush')).toMatchObject({ group: 'settings', classification: 'write', needsReview: true });
    expect(op('GET /status/sync')).toMatchObject({ classification: 'read', needsReview: false });
    expect(op('DELETE /items/{itemId}')).toMatchObject({ locked: true, typedConfirmation: true });
    expect(op('POST /items/{itemId}/{action}#other-user')).toMatchObject({
      locked: true,
      docs: { summary: 'Act', description: 'Acting for another user: locked.' },
    });
  });

  it('refuses a partial catalog', () => {
    expect(() => buildOpenApiCatalog(SPEC, { service: 'Acme', rules, minOperations: 50 })).toThrow(/only 9 operations/);
  });
});

describe('matchPath and fillTemplate', () => {
  it.each([
    ['POST', '/items/5/retry', 'POST /items/{itemId}/retry', { itemId: '5' }],
    ['POST', '/api/v1/items/5/close', 'POST /items/{itemId}/{action}', { itemId: '5', action: 'close' }],
    ['get', '/items/7/', 'GET /items/{itemId}', { itemId: '7' }],
  ])('%s %s → %s', (method, path, key, pathParams) => {
    expect(matchPath(catalog, method, path, '/api/v1')).toMatchObject({ op: { key }, pathParams });
  });

  it.each([['/items/../cache/flush'], ['/items/./7'], ['/items//7'], ['/items/a%2Fb'], ['/nope'], ['/items/%E0%A4%A']])(
    'rejects GET %s',
    (path) => {
      expect(matchPath(catalog, 'GET', path)).toBeUndefined();
    },
  );

  it('does not match a path param named like a prototype key into the prototype', () => {
    const m = matchPath(catalog, 'GET', '/items/__proto__');
    expect(Object.getPrototypeOf(m!.pathParams)).toBe(Object.prototype);
  });

  it('fills templates with encoded values', () => {
    expect(fillTemplate('/u/{id}/x', { id: 'a b/c' })).toBe('/u/a%20b%2Fc/x');
    expect(() => fillTemplate('/u/{id}', {})).toThrow(/id/);
    expect(() => fillTemplate('/u/{constructor}', {})).toThrow(/constructor/);
  });
});

describe('restBinding against an HTTP upstream', () => {
  let server: http.Server;
  let client: HttpJsonClient;
  const calls: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    client = new HttpJsonClient({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`,
      service: 'Acme',
    });
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const others = new Set(['9']);
  const binding = restBinding({
    namespace: 'acme',
    service: 'Acme',
    rules,
    catalog: async () => catalog as OpenApiCatalog,
    client: () => client,
    stripPrefix: '/api/v1',
    adjust: (call) =>
      call.key === 'POST /items'
        ? { ...call.params, body: { ...(call.params.body as object), draft: false } }
        : call.params,
    splitWhen: { 'other-user': (call) => others.has(call.params.path!.itemId!) },
  });
  const resolve = (req: unknown, fn = 'request') => binding.resolveOperation({ fn, args: [req] });

  it('validates calls', async () => {
    await expect(resolve({}, 'call')).rejects.toMatchObject({ code: ErrorCodes.UnknownOperation });
    await expect(resolve('x')).rejects.toThrow('acme.request({ method, path, query, body }) takes one object');
    await expect(resolve({ method: 'TRACE', path: '/items' })).rejects.toThrow('Unsupported HTTP method TRACE');
    await expect(resolve({ path: 'items' })).rejects.toThrow('path must be a string starting with /');
    await expect(resolve({ path: '/items?take=1' })).rejects.toThrow(/query/);
    await expect(resolve({ path: '/items', query: 'x' })).rejects.toThrow('query must be an object');
    await expect(resolve({ path: '/nope' })).rejects.toThrow('GET /nope is not a Acme API operation');
  });

  it('resolves keys, params, adjustments and split twins', async () => {
    expect(await resolve({ path: '/items', query: { take: 2 }, body: { ignored: true } })).toEqual({
      key: 'GET /items',
      params: { query: { take: 2 } },
    });
    expect(await resolve({ method: 'post', path: '/items', body: { id: 1 } })).toEqual({
      key: 'POST /items',
      params: { body: { id: 1, draft: false } },
    });
    expect((await resolve({ method: 'POST', path: '/items/1/close' })).key).toBe('POST /items/{itemId}/{action}');
    expect((await resolve({ method: 'POST', path: '/items/9/close' })).key).toBe(
      'POST /items/{itemId}/{action}#other-user',
    );
  });

  it('summarizes with notes and confirm literals', async () => {
    expect(
      await binding.summarize({ key: 'DELETE /items/{itemId}', params: { path: { itemId: '3' } }, targets: [] }),
    ).toEqual({
      text: 'Acme DELETE /items/3',
      confirmLiteral: '3',
    });
    const s = await binding.summarize({
      key: 'POST /items/{itemId}/{action}#other-user',
      params: { path: { itemId: '9', action: 'close' }, query: { a: 1 }, body: { x: 'y'.repeat(500) } },
      targets: [],
    });
    expect(s.text).toMatch(/^Acme POST \/items\/9\/close\?a=1 \{"x":"y+…  ?\(another user's item\)$/);
  });

  it('invokes the matching request', async () => {
    const ctx = { callId: 'c', deadlineMs: 5000 };
    expect(
      await binding.invoke({ key: 'GET /items/{itemId}', params: { path: { itemId: 'a b' } }, context: ctx }),
    ).toEqual({
      ok: true,
      url: '/api/v1/items/a%20b',
    });
    await expect(binding.invoke({ key: 'GET /nope', params: {}, context: ctx })).rejects.toMatchObject({
      code: ErrorCodes.UnknownOperation,
    });
    await expect(binding.invoke({ key: 'GET /items/{itemId}', params: {}, context: ctx })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });
});

describe('static catalogs', () => {
  const srules = compileRules(
    parsePluginSettings({
      operations: [
        {
          key: 'items.list',
          group: 'items',
          classification: 'read',
          summary: 'List items',
          http: { method: 'GET', path: '/items' },
        },
        {
          key: 'items.delete',
          group: 'items',
          classification: 'write',
          summary: 'Delete',
          http: { method: 'DELETE', path: '/items/{id}' },
        },
        {
          key: 'reload',
          kind: 'ws_command',
          group: 'system',
          classification: 'write',
          summary: 'Reload',
          attestation: true,
          reason: 'shape:write',
        },
      ],
      rules: [{ match: 'items.delete', locked: true, confirm: { param: '/path/id' } }],
    }),
  );

  it('describes declared operations with rules applied', () => {
    expect(staticCatalog(srules, { reasonPrefix: 'command-shape' })).toEqual([
      expect.objectContaining({
        key: 'items.list',
        kind: 'command',
        classification: 'read',
        classificationReason: 'command-shape:read',
        attestationRequired: false,
        docs: { summary: 'List items' },
      }),
      expect.objectContaining({
        key: 'items.delete',
        locked: true,
        classification: 'write',
        classificationReason: 'locked:destructive',
      }),
      expect.objectContaining({
        key: 'reload',
        kind: 'ws_command',
        classificationReason: 'shape:write',
        attestationRequired: true,
      }),
    ]);
  });

  it('binds http operations', async () => {
    const requests: unknown[] = [];
    const fakeClient = {
      request: async (...args: unknown[]) => (requests.push(args), { done: true }),
    } as unknown as HttpJsonClient;
    const b = staticHttpBinding({ namespace: 'acme', service: 'Acme', rules: srules, client: () => fakeClient });
    await expect(b.resolveOperation({ fn: 'call', args: ['reload'] })).rejects.toMatchObject({
      code: ErrorCodes.UnknownOperation,
    });
    await expect(b.resolveOperation({ fn: 'call', args: ['items.list', 'x'] })).rejects.toThrow(
      'params must be an object',
    );
    expect(await b.resolveOperation({ fn: 'call', args: ['items.list', { body: 1, query: { q: 1 } }] })).toEqual({
      key: 'items.list',
      params: { query: { q: 1 } },
    });
    expect(await b.summarize({ key: 'items.delete', params: { path: { id: '4' } }, targets: [] })).toEqual({
      text: 'Acme items.delete: DELETE /items/4',
      confirmLiteral: '4',
    });
    expect(
      await b.invoke({ key: 'items.delete', params: { path: { id: '4' } }, context: { callId: 'c', deadlineMs: 10 } }),
    ).toEqual({ done: true });
    expect(requests).toEqual([['DELETE', '/items/4', { query: undefined, body: undefined, timeoutMs: 1000 }]]);
  });
});

describe('fetchSpec', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.headers.authorization) res.writeHead(400).end();
      else if (req.url === '/develop/spec.yml') res.writeHead(200).end('openapi: 3.0.0');
      else if (req.url === '/v9/spec.yml') res.writeHead(500).end();
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('falls back on 404 and stops on other errors', async () => {
    const c = (ref: string) => ({ url: `${base}/${ref}/spec.yml`, ref });
    expect(await fetchSpec({ service: 'Acme', candidates: [c('v1'), c('develop')] })).toEqual({
      text: 'openapi: 3.0.0',
      ref: 'develop',
    });
    await expect(fetchSpec({ service: 'Acme', candidates: [c('v9'), c('develop')] })).rejects.toThrow(
      'Fetching the Acme API spec failed: HTTP 500',
    );
    await expect(fetchSpec({ service: 'Acme', candidates: [c('v1'), c('v2')] })).rejects.toThrow(
      'No Acme API spec found for v1 or v2',
    );
    await expect(fetchSpec({ service: 'Acme', candidates: [c('develop')], maxBytes: 3 })).rejects.toThrow('too large');
    await expect(
      fetchSpec({ service: 'Acme', candidates: [{ url: 'http://127.0.0.1:1/x', ref: 'x' }] }),
    ).rejects.toThrow('Could not fetch the Acme API spec from 127.0.0.1:1');
  });
});
