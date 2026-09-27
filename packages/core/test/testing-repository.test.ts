import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLUGIN_REPO } from '../src/plugins/default-repo.js';
import { parsePublicKey } from '../src/plugins/minisign.js';
import { verifyPluginRepository } from '../src/testing/index.js';
import { testKey } from './minisign-keys.js';

/** `verifyPluginRepository`: the check a plugin repository runs before publishing. */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repository with the echo fixture as a flat tarball, the layout a release publishes. */
function buildRepo(key: ReturnType<typeof testKey>, opts: { tamper?: boolean; url?: string; entry?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'synoikia-repo-'));
  dirs.push(dir);
  const src = path.join(dir, 'src');
  cpSync(path.join(FIXTURES, 'echo'), src, { recursive: true });
  if (opts.entry !== undefined) writeFileSync(path.join(src, 'index.mjs'), opts.entry);
  const file = path.join(dir, 'echo-1.0.0.tgz');
  tar.c({ gzip: true, cwd: src, file, sync: true, portable: true }, ['manifest.json', 'index.mjs']);
  const tarball = readFileSync(file);
  const signature = key.sign(tarball);
  if (opts.tamper) writeFileSync(file, Buffer.concat([tarball, Buffer.alloc(512)]));
  const index = {
    schema: 1,
    name: 'Test repo',
    publicKey: key.publicKey,
    plugins: [
      {
        id: 'echo',
        name: 'Echo',
        versions: [
          {
            version: '1.0.0',
            sdk: '^0.2.0',
            url: opts.url ?? 'https://example.com/releases/download/echo-v1.0.0/echo-1.0.0.tgz',
            sha256: createHash('sha256').update(tarball).digest('hex'),
            signature,
          },
        ],
      },
    ],
  };
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  return { index: path.join(dir, 'index.json'), assets: dir };
}

describe('verifyPluginRepository', () => {
  it('installs and loads every plugin, signature checked against the pinned key', async () => {
    const key = testKey();
    await expect(verifyPluginRepository({ ...buildRepo(key), publicKey: key.publicKey })).resolves.toEqual([
      { id: 'echo', version: '1.0.0', signatureVerified: true },
    ]);
    // Relative URLs resolve next to the index, as in a real repository.
    await expect(
      verifyPluginRepository({ ...buildRepo(key, { url: 'echo-1.0.0.tgz' }), publicKey: key.publicKey }),
    ).resolves.toHaveLength(1);
  });

  it('fails on another key, a changed tarball or a missing one', async () => {
    const key = testKey();
    await expect(verifyPluginRepository({ ...buildRepo(key), publicKey: testKey().publicKey })).rejects.toThrow(
      /Confirm the repository public key/,
    );
    await expect(
      verifyPluginRepository({ ...buildRepo(key, { tamper: true }), publicKey: key.publicKey }),
    ).rejects.toThrow(/echo@1.0.0: .*sha256/);
    await expect(
      verifyPluginRepository({ ...buildRepo(key, { url: 'nope.tgz' }), publicKey: key.publicKey }),
    ).rejects.toThrow(/echo@1.0.0/);
  });

  it('starts each plugin: a bundle that fails on import, or never answers, fails the check', async () => {
    const key = testKey();
    await expect(
      verifyPluginRepository({ ...buildRepo(key, { entry: "throw new Error('boom');\n" }), publicKey: key.publicKey }),
    ).rejects.toThrow(/echo@1.0.0 does not start[\s\S]*boom/);
    await expect(
      verifyPluginRepository({
        ...buildRepo(key, { entry: 'setInterval(() => {}, 1000);\n' }),
        publicKey: key.publicKey,
      }),
    ).rejects.toThrow(/echo@1.0.0 does not start/);
  }, 30_000);

  it('ships a valid pre-configured repository key', () => {
    expect(parsePublicKey(DEFAULT_PLUGIN_REPO.publicKey).keyId).toBe('89B25CCABB076D83');
  });
});
