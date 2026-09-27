import { describe, expect, it } from 'vitest';
import { createDispatcher, ErrorCodes, PluginError } from '../src/index.js';
import type { PluginHandlers } from '../src/index.js';

const handlers: PluginHandlers = {
  init: () => undefined,
  testConnection: () => ({ ok: true }),
  getUpstreamVersion: () => '25.10.1',
  syncCatalog: () => ({ upstreamVersion: '25.10.1', operations: [] }),
  resolveOperation: ({ args }) => {
    if (args[0] === 'nope') throw new PluginError(ErrorCodes.UnknownOperation, 'unknown operation: nope');
    return { key: String(args[0]), params: args[1] };
  },
  summarize: () => ({ text: 'summary' }),
  invoke: () => {
    throw new Error('boom');
  },
};

const dispatch = createDispatcher(handlers);
const req = (method: string, params?: unknown) => ({ jsonrpc: '2.0' as const, id: 7, method, params });

describe('createDispatcher', () => {
  it('returns handler results', async () => {
    await expect(dispatch(req('getUpstreamVersion'))).resolves.toEqual({ jsonrpc: '2.0', id: 7, result: '25.10.1' });
    await expect(dispatch(req('resolveOperation', { fn: 'call', args: ['store.query', {}] }))).resolves.toMatchObject({
      result: { key: 'store.query', params: {} },
    });
  });

  it('maps void results to null', async () => {
    await expect(dispatch(req('init', {}))).resolves.toEqual({ jsonrpc: '2.0', id: 7, result: null });
  });

  it('rejects unknown and unimplemented optional methods', async () => {
    for (const method of ['doesNotExist', 'syncRegistry', 'constructor', 'toString']) {
      const res = await dispatch(req(method));
      expect(res).toMatchObject({ error: { code: ErrorCodes.MethodNotFound } });
    }
  });

  it('preserves PluginError codes', async () => {
    const res = await dispatch(req('resolveOperation', { fn: 'call', args: ['nope'] }));
    expect(res).toMatchObject({ error: { code: ErrorCodes.UnknownOperation, message: 'unknown operation: nope' } });
  });

  it('maps unexpected errors to INTERNAL', async () => {
    const res = await dispatch(req('invoke', { key: 'x', params: {} }));
    expect(res).toMatchObject({ error: { code: ErrorCodes.Internal, message: 'boom' } });
  });
});
