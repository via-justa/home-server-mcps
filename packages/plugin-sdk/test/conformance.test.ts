import { describe, expect, it } from 'vitest';
import { checkConformance, ErrorCodes, PluginError } from '../src/index.js';
import type { PluginHandlers } from '../src/index.js';

const manifest = {
  id: 'fake',
  name: 'Fake',
  version: '1.0.0',
  sdk: '^0.2.0',
  entry: 'dist/index.js',
  binding: { namespace: 'fake', functions: ['call'] },
  connection: { schema: { type: 'object', properties: { baseUrl: { type: 'string' } } } },
  matchProfiles: { prefix: [{ field: '/name', label: 'Name', op: 'prefix', widget: 'prefix' }] },
};

const catalog = [
  { key: 'thing.query', kind: 'method', group: 'thing', classification: 'read', classificationReason: 'naming' },
  {
    key: 'thing.delete',
    kind: 'method',
    group: 'thing',
    classification: 'write',
    classificationReason: 'naming',
    locked: true,
    matchProfile: 'prefix',
  },
] as const;

function plugin(overrides: Partial<PluginHandlers> = {}): PluginHandlers {
  return {
    init: () => undefined,
    testConnection: () => ({ ok: true, upstreamVersion: '1.0' }),
    getUpstreamVersion: () => '1.0',
    syncCatalog: () => ({ upstreamVersion: '1.0', operations: [...catalog] }),
    resolveOperation: ({ args }) => {
      const key = String(args[0]);
      if (!catalog.some((o) => o.key === key)) throw new PluginError(ErrorCodes.UnknownOperation, key);
      return { key, params: args[1] ?? {} };
    },
    summarize: ({ key, params }) =>
      key === 'thing.delete'
        ? { text: `Delete ${(params as { name: string }).name}`, confirmLiteral: (params as { name: string }).name }
        : { text: 'Query things' },
    invoke: () => null,
    ...overrides,
  };
}

const run = (handlers: PluginHandlers, extra: object = {}) =>
  checkConformance({
    manifest,
    handlers,
    init: { instanceId: 'i', config: {}, secrets: {} },
    samples: [
      { fn: 'call', args: ['thing.query', {}], expectKey: 'thing.query' },
      { fn: 'call', args: ['thing.delete', { name: 'x' }], expectKey: 'thing.delete' },
    ],
    rejects: [{ fn: 'call', args: ['nope.nope'] }],
    ...extra,
  });

describe('checkConformance', () => {
  it('passes a conforming plugin', async () => {
    await expect(run(plugin())).resolves.toEqual([]);
  });

  it('reports an invalid manifest and stops', async () => {
    await expect(
      checkConformance({
        manifest: { id: 'X' },
        handlers: plugin(),
        init: { instanceId: 'i', config: {}, secrets: {} },
      }),
    ).resolves.toEqual([expect.stringMatching(/^manifest:/)]);
  });

  it('reports capability/handler mismatches', async () => {
    const issues = await run(plugin({ syncRegistry: () => [] }));
    expect(issues).toContain('syncRegistry is implemented but capabilities.registry is not declared');
  });

  it('reports invalid catalog output', async () => {
    const issues = await run(
      plugin({
        syncCatalog: () => ({
          upstreamVersion: '1.0',
          operations: [
            ...catalog,
            { ...catalog[0] },
            { ...catalog[0], key: 'thing.bad', matchProfile: 'missing' },
            { ...catalog[0], key: 'thing.lockedread', locked: true },
          ],
        }),
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        'syncCatalog: duplicate key thing.query',
        'syncCatalog: thing.bad references unknown matchProfile "missing"',
        'syncCatalog: locked thing.lockedread must be classified write',
      ]),
    );
  });

  it('requires a confirm literal for typed-confirmation operations', async () => {
    const issues = await run(plugin({ summarize: () => ({ text: 'x' }) }));
    expect(issues).toContain('summarize(thing.delete): typed-confirmation operations must return a confirmLiteral');
  });

  it('checks resolveOperation keys and rejections', async () => {
    const issues = await run(plugin({ resolveOperation: () => ({ key: 'thing.query', params: {} }) }));
    expect(issues).toEqual(
      expect.arrayContaining([
        'resolveOperation(call ["thing.delete",{"name":"x"}]): resolved to thing.query, expected thing.delete',
        'resolveOperation(call ["nope.nope"]): expected rejection, got a result',
      ]),
    );
  });

  it('reports schema violations with field paths', async () => {
    const issues = await run(plugin({ testConnection: () => ({ ok: 'yes' }) as never }));
    expect(issues).toEqual([expect.stringMatching(/^testConnection: ok:/)]);
  });
});
