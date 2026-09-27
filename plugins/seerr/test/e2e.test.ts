import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPluginHarness } from '@synoikia/core/testing';
import { describe, expect, it } from 'vitest';

/** The skeleton's built bundle loads in core under the permission model (the real plugin replaces this). */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Seerr plugin skeleton end to end', () => {
  it('loads under the permission model and answers NOT_IMPLEMENTED', async () => {
    const h = await startPluginHarness({
      pluginDir: PLUGIN_DIR,
      sync: false,
      connection: { baseUrl: 'http://127.0.0.1:1', authMethod: 'apiKey', apiKey: 'k' },
    });
    try {
      await expect(
        h.testConnection({ baseUrl: 'http://127.0.0.1:1', authMethod: 'apiKey', apiKey: 'k' }),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringMatching(/not implemented/i),
      });
    } finally {
      await h.stop();
    }
  }, 30_000);
});
