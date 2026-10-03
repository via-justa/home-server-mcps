import { readFileSync } from 'node:fs';
import { checkConformance, ErrorCodes } from '@synoikia/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create{{Pascal}}Plugin, settings } from '../src/plugin.js';
import { CREDENTIALS } from './fake-auth.js';
import { startFake{{Pascal}} } from './fake-upstream.js';
import type { Fake{{Pascal}} } from './fake-upstream.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

let fake: Fake{{Pascal}};
const plugin = create{{Pascal}}Plugin();

beforeAll(async () => {
  fake = await startFake{{Pascal}}();
});
afterAll(async () => {
  await plugin.shutdown?.();
  await fake?.close();
});

const connection = () => {
  const { username, ...secrets } = CREDENTIALS as Record<string, string>;
  return { instanceId: '{{id}}', config: { baseUrl: fake.url, ...(username ? { username } : {}) }, secrets };
};

describe('{{name}} plugin', () => {
  it('passes the SDK conformance checks against the fake', async () => {
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: plugin,
      init: connection(),
      samples: [
        { fn: 'call', args: ['items.list'], expectKey: 'items.list' },
        { fn: 'call', args: ['items.delete', { path: { itemId: '1' } }], expectKey: 'items.delete' },
      ],
      rejects: [{ fn: 'call', args: ['items.nope'] }, { fn: 'other', args: [] }],
    });
    expect(issues).toEqual([]);
  });

  it('locks deletes and names the item in the confirmation', async () => {
    await plugin.init({ ...connection(), sdkVersion: '1' });
    const { operations } = await plugin.syncCatalog();
    expect(operations.find((o) => o.key === 'items.delete')).toMatchObject({ locked: true });
    expect(await plugin.summarize({ key: 'items.delete', params: { path: { itemId: '1' } }, targets: [] })).toEqual({
      text: '{{name}} items.delete: DELETE /items/1',
      confirmLiteral: 'First item',
    });
  });

  it('reports rejected credentials without throwing', async () => {
    const wrong = Object.fromEntries(Object.keys(connection().secrets).map((k) => [k, 'wrong']));
    if (!Object.keys(wrong).length) return; // nothing to reject without authentication
    const bad = create{{Pascal}}Plugin();
    await bad.init({ ...connection(), secrets: wrong, sdkVersion: '1' });
    expect(await bad.testConnection()).toMatchObject({ ok: false, message: expect.stringContaining('denied') });
    await bad.shutdown?.();
  });

  it('refuses a connection without a base URL', async () => {
    await expect(create{{Pascal}}Plugin().init({ ...connection(), config: {}, sdkVersion: '1' })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
    });
  });
});
