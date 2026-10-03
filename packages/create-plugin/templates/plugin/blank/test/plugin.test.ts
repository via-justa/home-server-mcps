import { readFileSync } from 'node:fs';
import { checkConformance } from '@synoikia/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { create{{Pascal}}Plugin, settings } from '../src/plugin.js';

const manifest: unknown = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

// Fill in a connection for your auth, and point baseUrl at a fake upstream (see @synoikia/core/testing's
// startFakeHttp) once the plugin talks to one.
const init = {
  instanceId: '{{id}}',
  config: { baseUrl: 'http://127.0.0.1:1', username: 'synoikia' },
  secrets: { token: 't', apiKey: 'k', password: 'p' },
};

describe('{{name}} plugin', () => {
  it('passes the SDK conformance checks', async () => {
    const plugin = create{{Pascal}}Plugin();
    const issues = await checkConformance({
      manifest,
      settings,
      handlers: plugin,
      init,
      samples: [
        { fn: 'call', args: ['example.read'], expectKey: 'example.read' },
        { fn: 'call', args: ['example.delete', { name: 'thing' }], expectKey: 'example.delete' },
      ],
      rejects: [{ fn: 'call', args: ['example.nope'] }],
    });
    expect(issues).toEqual([]);
    await plugin.shutdown?.();
  });
});
