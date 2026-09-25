import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config/env.js';
import { plugins } from '../src/db/schema.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins/echo');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('bootstrap', () => {
  it('creates the key and DB in DATA_DIR and registers discovered plugins', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hsm-boot-'));
    dirs.push(root);
    const coreDir = path.join(root, 'core-plugins');
    mkdirSync(coreDir);
    cpSync(FIXTURE, path.join(coreDir, 'echo'), { recursive: true });

    const config = loadConfig({
      DATA_DIR: path.join(root, 'data'),
      CORE_PLUGINS_DIR: coreDir,
      CORE_PLUGINS_AUTOENABLE: 'true',
    });
    const core = bootstrap(config);
    expect(core.warnings).toEqual([expect.stringMatching(/Set MASTER_KEY/)]);
    expect(core.plugins.added).toEqual(['echo']);
    expect(core.db.select().from(plugins).get()).toMatchObject({ pluginId: 'echo', enabled: true });
    core.db.$client.close();

    const again = bootstrap(config);
    expect(again.plugins).toMatchObject({ added: [], updated: ['echo'] });
    again.db.$client.close();
  });
});
