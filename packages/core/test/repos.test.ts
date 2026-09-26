import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { auditLog, plugins } from '../src/db/schema.js';
import { createAdminApp } from '../src/http/admin-app.js';
import { parsePublicKey, verifySignature } from '../src/plugins/minisign.js';
import { swapDirectory } from '../src/plugins/repos.js';
import { browser } from './admin-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const PASSWORD = 'correct horse battery';
const INDEX_URL = 'https://plugins.example.com/index.json';

describe('minisign', () => {
  const pub = parsePublicKey(readFileSync(path.join(FIXTURES, 'minisign/k.pub'), 'utf8'));
  const data = readFileSync(path.join(FIXTURES, 'minisign/data.txt'));
  const sig = (name: string) => readFileSync(path.join(FIXTURES, 'minisign', name), 'utf8');

  it('verifies signatures made by the reference minisign tool (prehashed and legacy)', () => {
    expect(pub.keyId).toMatch(/^[0-9A-F]{16}$/);
    expect(readFileSync(path.join(FIXTURES, 'minisign/k.pub'), 'utf8')).toContain(pub.keyId);
    expect(verifySignature(data, sig('data.txt.minisig'), pub)).toMatchObject({
      prehashed: true,
      trustedComment: 'fixture',
    });
    expect(verifySignature(data, sig('data.txt.legacy.minisig'), pub)).toMatchObject({ prehashed: false });
  });

  it('rejects tampered files, tampered trusted comments and other keys', () => {
    expect(() => verifySignature(Buffer.concat([data, Buffer.from('x')]), sig('data.txt.minisig'), pub)).toThrow(
      /does not match/,
    );
    expect(() =>
      verifySignature(data, sig('data.txt.minisig').replace('trusted comment: fixture', 'trusted comment: evil'), pub),
    ).toThrow(/Trusted comment/);
    const other = testKey();
    expect(() => verifySignature(data, sig('data.txt.minisig'), parsePublicKey(other.publicKey))).toThrow(
      /Signed by key/,
    );
    expect(() => parsePublicKey('not a key')).toThrow();
  });
});

/** Minisign-format keys and signatures made with Node's Ed25519, for the repository tests. */
function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return {
    publicKey: Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64'),
    sign: (data: Buffer, comment = 'test') => minisign(privateKey, keyId, data, comment),
  };
}

function minisign(privateKey: KeyObject, keyId: Buffer, data: Buffer, comment: string) {
  const digest = createHash('blake2b512').update(data).digest();
  const sig = sign(null, digest, privateKey);
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
  return [
    'untrusted comment: signature from test key',
    Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64'),
    `trusted comment: ${comment}`,
    global.toString('base64'),
    '',
  ].join('\n');
}

// ── repositories & installs ──

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tmp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** npm-pack style tarball of the echo fixture, with the manifest version overridden. */
function echoTarball(version: string, mutate?: (dir: string) => void) {
  const work = tmp('hsm-pkg-');
  const pkg = path.join(work, 'package');
  cpSync(path.join(FIXTURES, 'plugins/echo'), pkg, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(pkg, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ ...manifest, version }));
  mutate?.(pkg);
  const file = path.join(work, 'out.tgz');
  tar.c({ gzip: true, cwd: work, file, sync: true, portable: true }, ['package']);
  return readFileSync(file);
}

/** A hand-built ustar archive, for entries node-tar refuses to create. */
function rawTar(entries: { name: string; type: string; body?: string; link?: string }[]) {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type, 156);
    if (e.link) h.write(e.link, 157);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function setup(opts: { coreDir?: string } = {}) {
  const dataDir = tmp('hsm-repos-');
  const files = new Map<string, Buffer>();
  const fetched: string[] = [];
  const redirects = new Map<string, string>();
  const ctx = await createAppContext(
    loadConfig({
      DATA_DIR: dataDir,
      CORE_PLUGINS_DIR: opts.coreDir ?? tmp('hsm-core-'),
      CORE_PLUGINS_AUTOENABLE: 'true',
    }),
    {
      memoryDb: true,
      supervisor: { backoff: { initialMs: 20, maxMs: 100 }, initTimeoutMs: 3000, rpcTimeoutMs: 5000 },
      repoFetch: async (url, init) => {
        fetched.push(url);
        const to = redirects.get(url);
        if (to) {
          // Real fetch would follow on its own; the service must ask to see redirects itself.
          expect(init?.redirect).toBe('manual');
          return new Response(null, { status: 302, headers: { location: to } });
        }
        const body = files.get(url);
        return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 });
      },
    },
  );
  cleanup.push(() => ctx.stop());
  const app = createAdminApp(ctx);
  const b = await browser(app).init();
  await b.post('/api/setup', { username: 'admin', password: PASSWORD });
  const publish = (index: unknown) => files.set(INDEX_URL, Buffer.from(JSON.stringify(index)));
  return { ctx, b, files, fetched, redirects, publish, dataDir };
}

function indexFor(
  key: ReturnType<typeof testKey> | null,
  versions: { version: string; tarball: Buffer; signature?: string | null; sha256?: string }[],
) {
  return {
    schema: 1,
    name: 'Test repo',
    ...(key ? { publicKey: key.publicKey } : {}),
    plugins: [
      {
        id: 'echo',
        name: 'Echo',
        versions: versions.map((v) => ({
          version: v.version,
          sdk: '^1.0.0',
          url: `echo-${v.version}.tgz`, // relative to the index URL
          sha256: v.sha256 ?? sha(v.tarball),
          ...(v.signature !== null && key ? { signature: v.signature ?? key.sign(v.tarball) } : {}),
        })),
      },
    ],
  };
}

describe('plugin repositories', () => {
  it('adds a signed repo only after the key id is confirmed, and installs verified plugins', async () => {
    const t = await setup();
    const key = testKey();
    const v1 = echoTarball('1.0.0');
    t.files.set('https://plugins.example.com/echo-1.0.0.tgz', v1);
    t.publish(indexFor(key, [{ version: '1.0.0', tarball: v1 }]));

    const first = await t.b.post('/api/plugin-repos', { url: INDEX_URL, signingMode: 'signed' });
    expect(first.status).toBe(409);
    const { details } = (await first.json()) as { details: { keyId: string; publicKey: string } };
    expect(details).toMatchObject({ keyId: parsePublicKey(key.publicKey).keyId, publicKey: key.publicKey });
    expect(((await (await t.b.get('/api/plugin-repos')).json()) as unknown[]).length).toBe(0);
    const wrong = await t.b.post('/api/plugin-repos', {
      url: INDEX_URL,
      signingMode: 'signed',
      confirmPublicKey: testKey().publicKey,
    });
    expect(wrong.status).toBe(409);
    const added = await t.b.post('/api/plugin-repos', {
      url: INDEX_URL,
      signingMode: 'signed',
      // As published in a .pub file, comment line included.
      confirmPublicKey: `untrusted comment: minisign public key ${details.keyId}\n${key.publicKey}\n`,
    });
    expect(added.status).toBe(201);
    const repo = (await added.json()) as { id: string; keyId: string; pluginCount: number };
    expect(repo).toMatchObject({ keyId: details.keyId, pluginCount: 1 });

    expect(await (await t.b.get('/api/plugin-repos/available')).json()).toMatchObject([
      { pluginId: 'echo', latest: '1.0.0', installed: null, blocked: null },
    ]);
    const installed = await t.b.post('/api/plugins/install', { repoId: repo.id, pluginId: 'echo', version: '1.0.0' });
    expect(installed.status).toBe(201);
    expect(await installed.json()).toMatchObject({
      pluginId: 'echo',
      source: 'repo',
      repoId: repo.id,
      signatureVerified: true,
      sha256: sha(v1),
      // A new install waits for the admin to review and enable it (review L7).
      enabled: false,
      status: 'ok',
    });
    expect(existsSync(path.join(t.dataDir, 'plugins/echo/manifest.json'))).toBe(true);
    expect(t.fetched).toContain('https://plugins.example.com/echo-1.0.0.tgz');
    const pluginRow = t.ctx.db.select().from(plugins).where(eq(plugins.pluginId, 'echo')).get()!;
    expect((await t.b.patch(`/api/plugins/${pluginRow.id}`, { enabled: true })).status).toBe(200);

    // The installed plugin actually runs.
    const inst = await t.ctx.instances.create({ pluginId: 'echo', slug: 'echo', connection: {} });
    await t.ctx.instances.syncNow(inst.id);

    // Update to 1.1.0: instances restart on the new files.
    const v11 = echoTarball('1.1.0');
    t.files.set('https://plugins.example.com/echo-1.1.0.tgz', v11);
    t.publish(
      indexFor(key, [
        { version: '1.0.0', tarball: v1 },
        { version: '1.1.0', tarball: v11 },
      ]),
    );
    await t.b.post(`/api/plugin-repos/${repo.id}/refresh`);
    expect(await (await t.b.get('/api/plugin-repos/available')).json()).toMatchObject([
      { latest: '1.1.0', installed: { version: '1.0.0', fromThisRepo: true }, updateAvailable: true },
    ]);
    expect(
      await (await t.b.post('/api/plugins/install', { repoId: repo.id, pluginId: 'echo', version: '1.1.0' })).json(),
    ).toMatchObject({ version: '1.1.0', enabled: true });
    expect(t.ctx.instances.status(inst.id)).toBe('ready');

    // 1.2.0 asks for more network hosts: it installs disabled until the admin reviews it (review L7).
    const v12 = echoTarball('1.2.0', (dir) => {
      const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...m, network: { hosts: ['*.example.net'] } }));
    });
    t.files.set('https://plugins.example.com/echo-1.2.0.tgz', v12);
    t.publish(
      indexFor(key, [
        { version: '1.0.0', tarball: v1 },
        { version: '1.1.0', tarball: v11 },
        { version: '1.2.0', tarball: v12 },
      ]),
    );
    await t.b.post(`/api/plugin-repos/${repo.id}/refresh`);
    expect(
      await (await t.b.post('/api/plugins/install', { repoId: repo.id, pluginId: 'echo', version: '1.2.0' })).json(),
    ).toMatchObject({ version: '1.2.0', enabled: false });
    expect(t.ctx.instances.status(inst.id)).toBe('stopped');
    const held = t.ctx.db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision === 'plugin_updated')
      .at(-1);
    expect(held?.detail).toMatchObject({ version: '1.2.0', enabled: false, needsReview: ['network.hosts'] });

    // Uninstall is blocked while endpoints use the plugin, and the repo while plugins come from it.
    expect(await (await t.b.del('/api/plugins/echo')).json()).toMatchObject({ error: 'plugin_has_instances' });
    expect(await (await t.b.del(`/api/plugin-repos/${repo.id}`)).json()).toMatchObject({ error: 'repo_in_use' });
    await t.ctx.instances.remove(inst.id, 'echo');
    expect((await t.b.del('/api/plugins/echo')).status).toBe(204);
    expect(existsSync(path.join(t.dataDir, 'plugins/echo'))).toBe(false);
    expect((await t.b.del(`/api/plugin-repos/${repo.id}`)).status).toBe(204);

    const decisions = t.ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.kind, 'config'))
      .all()
      .map((a) => a.decision)
      .filter((d) => d?.startsWith('plugin_'));
    expect(decisions).toEqual([
      'plugin_repo_added',
      'plugin_installed',
      'plugin_enabled',
      'plugin_updated',
      'plugin_updated',
      'plugin_uninstalled',
      'plugin_repo_removed',
    ]);
  });

  it('refuses bad checksums, bad or missing signatures, and blocks installs after a key change', async () => {
    const t = await setup();
    const key = testKey();
    const good = echoTarball('1.0.0');
    const evil = echoTarball('1.0.1', (dir) => writeFileSync(path.join(dir, 'extra.js'), 'evil'));
    t.files.set('https://plugins.example.com/echo-1.0.0.tgz', good);
    t.files.set('https://plugins.example.com/echo-1.0.1.tgz', evil);
    t.files.set('https://plugins.example.com/echo-1.0.2.tgz', evil);
    t.files.set('https://plugins.example.com/echo-1.0.3.tgz', evil);
    t.publish(
      indexFor(key, [
        { version: '1.0.0', tarball: good },
        { version: '1.0.1', tarball: evil, sha256: sha(good) },
        { version: '1.0.2', tarball: evil, signature: key.sign(good) },
        { version: '1.0.3', tarball: evil, signature: null },
      ]),
    );
    const repo = await t.ctx.repos.add({
      url: INDEX_URL,
      signingMode: 'signed',
      confirmPublicKey: key.publicKey,
    });
    const install = (version: string) =>
      t.b.post('/api/plugins/install', { repoId: repo.id, pluginId: 'echo', version });
    expect(await (await install('1.0.1')).json()).toMatchObject({ error: 'checksum_mismatch' });
    expect(await (await install('1.0.2')).json()).toMatchObject({ error: 'signature_invalid' });
    expect(await (await install('1.0.3')).json()).toMatchObject({ error: 'signature_missing' });
    expect(await (await install('9.9.9')).json()).toMatchObject({ error: 'version_not_found' });
    expect(t.ctx.db.select().from(plugins).all()).toHaveLength(0);

    // The publisher's key changes: installs stop until the admin confirms the new key id.
    const rotated = testKey();
    t.publish(indexFor(rotated, [{ version: '1.0.0', tarball: good }]));
    expect(await (await t.b.post(`/api/plugin-repos/${repo.id}/refresh`)).json()).toMatchObject({
      keyStatus: 'key_changed',
      offeredKey: { publicKey: rotated.publicKey },
    });
    expect(await (await install('1.0.0')).json()).toMatchObject({ error: 'key_changed' });
    expect((await t.b.post(`/api/plugin-repos/${repo.id}/confirm-key`, { publicKey: key.publicKey })).status).toBe(409);
    expect(
      await (await t.b.post(`/api/plugin-repos/${repo.id}/confirm-key`, { publicKey: rotated.publicKey })).json(),
    ).toMatchObject({ keyStatus: 'ok' });
    expect((await install('1.0.0')).status).toBe(201);
  });

  it('detects a new key that reuses the pinned key id', async () => {
    const t = await setup();
    const key = testKey();
    t.publish({ schema: 1, name: 'Keyed', publicKey: key.publicKey, plugins: [] });
    const repo = await t.ctx.repos.add({ url: INDEX_URL, signingMode: 'signed', confirmPublicKey: key.publicKey });
    const impostor = testKey();
    const raw = Buffer.from(impostor.publicKey, 'base64');
    Buffer.from(key.publicKey, 'base64').copy(raw, 2, 2, 10); // same key id, different key
    t.publish({ schema: 1, name: 'Keyed', publicKey: raw.toString('base64'), plugins: [] });
    expect(await t.ctx.repos.refresh(repo.id)).toMatchObject({ keyStatus: 'key_changed', keyId: repo.keyId });
    expect(() => t.ctx.repos.confirmKey(repo.id, key.publicKey)).toThrow(/Confirm the repository public key/);
  });

  it('requires typing the plugin id for unsigned repos and never lets a repo shadow a core plugin', async () => {
    const t = await setup({ coreDir: path.join(FIXTURES, 'plugins') });
    const tarball = echoTarball('2.0.0');
    t.files.set('https://plugins.example.com/echo-2.0.0.tgz', tarball);
    t.publish(indexFor(null, [{ version: '2.0.0', tarball }]));
    const repo = await t.ctx.repos.add({ url: INDEX_URL, signingMode: 'unsigned' });
    expect(await (await t.b.get('/api/plugin-repos/available')).json()).toMatchObject([{ blocked: 'core_plugin_id' }]);
    expect(
      await (
        await t.b.post('/api/plugins/install', { repoId: repo.id, pluginId: 'echo', version: '2.0.0', confirm: 'echo' })
      ).json(),
    ).toMatchObject({ error: 'core_plugin_id' });
    expect(await (await t.b.del('/api/plugins/echo')).json()).toMatchObject({ error: 'core_plugin' });

    const t2 = await setup();
    t2.files.set('https://plugins.example.com/echo-2.0.0.tgz', tarball);
    t2.publish(indexFor(null, [{ version: '2.0.0', tarball }]));
    const repo2 = await t2.ctx.repos.add({ url: INDEX_URL, signingMode: 'unsigned' });
    const body = { repoId: repo2.id, pluginId: 'echo', version: '2.0.0' };
    expect(await (await t2.b.post('/api/plugins/install', body)).json()).toMatchObject({ error: 'confirm_required' });
    expect(await (await t2.b.post('/api/plugins/install', { ...body, confirm: 'echo' })).json()).toMatchObject({
      version: '2.0.0',
      signatureVerified: false,
    });
  });

  it('checks every redirect hop: https → https is followed, a downgrade to http is refused (review L4)', async () => {
    const t = await setup();
    t.files.set(INDEX_URL, Buffer.from(JSON.stringify({ schema: 1, name: 'Moved', plugins: [] })));
    t.redirects.set('https://old.example.com/index.json', INDEX_URL);
    const moved = await t.b.post('/api/plugin-repos', {
      url: 'https://old.example.com/index.json',
      signingMode: 'unsigned',
    });
    expect(moved.status).toBe(201);

    t.redirects.set('https://evil.example.com/index.json', 'http://10.0.0.1:8080/admin');
    const res = await t.b.post('/api/plugin-repos', {
      url: 'https://evil.example.com/index.json',
      signingMode: 'unsigned',
    });
    expect(await res.json()).toMatchObject({ error: 'insecure_url' });
    expect(t.fetched).not.toContain('http://10.0.0.1:8080/admin');

    for (let i = 0; i < 7; i++) t.redirects.set(`https://loop.example.com/${i}`, `https://loop.example.com/${i + 1}`);
    const loop = await t.b.post('/api/plugin-repos', { url: 'https://loop.example.com/0', signingMode: 'unsigned' });
    expect(await loop.json()).toMatchObject({ error: 'fetch_failed' });
  });

  it('rejects archives with links, escaping paths, a wrong manifest, and insecure or invalid indexes', async () => {
    const t = await setup();
    const manifest = readFileSync(path.join(FIXTURES, 'plugins/echo/manifest.json'), 'utf8');
    const cases: [string, Buffer, string][] = [
      [
        '1.0.0',
        rawTar([
          { name: 'manifest.json', type: '0', body: manifest },
          { name: 'index.mjs', type: '2', link: '/etc/passwd' },
        ]),
        'invalid_archive',
      ],
      [
        '1.0.1',
        rawTar([
          { name: 'manifest.json', type: '0', body: manifest },
          { name: '../escape.txt', type: '0', body: 'x' },
        ]),
        'invalid_archive',
      ],
      ['1.0.2', rawTar([{ name: 'readme.txt', type: '0', body: 'no manifest' }]), 'invalid_archive'],
      ['1.0.3', echoTarball('9.0.0'), 'manifest_mismatch'],
    ];
    for (const [v, tb] of cases) t.files.set(`https://plugins.example.com/echo-${v}.tgz`, tb);
    t.publish(
      indexFor(
        null,
        cases.map(([version, tarball]) => ({ version, tarball })),
      ),
    );
    const repo = await t.ctx.repos.add({ url: INDEX_URL, signingMode: 'unsigned' });
    for (const [version, , error] of cases) {
      const res = await t.b.post('/api/plugins/install', {
        repoId: repo.id,
        pluginId: 'echo',
        version,
        confirm: 'echo',
      });
      expect({ version, body: await res.json() }).toMatchObject({ version, body: { error } });
    }
    expect(existsSync(path.join(t.dataDir, 'escape.txt'))).toBe(false);
    expect(existsSync(path.join(t.dataDir, 'plugins-staging/escape.txt'))).toBe(false);
    expect(existsSync(path.join(t.dataDir, 'plugins/echo'))).toBe(false);

    expect(
      await (
        await t.b.post('/api/plugin-repos', { url: 'http://plugins.example.com/x.json', signingMode: 'unsigned' })
      ).json(),
    ).toMatchObject({
      error: 'insecure_url',
    });
    t.files.set('https://plugins.example.com/bad.json', Buffer.from('{"schema":2}'));
    expect(
      await (
        await t.b.post('/api/plugin-repos', { url: 'https://plugins.example.com/bad.json', signingMode: 'unsigned' })
      ).json(),
    ).toMatchObject({
      error: 'invalid_index',
    });
    t.files.set(
      'https://plugins.example.com/nokey.json',
      Buffer.from(JSON.stringify({ schema: 1, name: 'No key', plugins: [] })),
    );
    expect(
      await (
        await t.b.post('/api/plugin-repos', { url: 'https://plugins.example.com/nokey.json', signingMode: 'signed' })
      ).json(),
    ).toMatchObject({
      error: 'no_public_key',
    });
    expect(
      await (
        await t.b.post('/api/plugin-repos', { url: 'https://plugins.example.com/gone.json', signingMode: 'unsigned' })
      ).json(),
    ).toMatchObject({
      error: 'fetch_failed',
    });
  });
});

describe('swapDirectory (review L5)', () => {
  it('replaces the directory, or puts the old one back when the new one cannot be moved in', () => {
    const root = tmp('hsm-swap-');
    const target = path.join(root, 'plugins/echo');
    const next = path.join(root, 'staging/new');
    mkdirSync(target, { recursive: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(path.join(target, 'v'), '1');
    writeFileSync(path.join(next, 'v'), '2');

    const failing = (from: string, to: string) => {
      if (from === next) throw new Error('disk full');
      renameSync(from, to);
    };
    expect(() => swapDirectory(next, target, path.join(root, 'staging/old-1'), failing)).toThrow('disk full');
    expect(readFileSync(path.join(target, 'v'), 'utf8')).toBe('1');
    expect(existsSync(path.join(root, 'staging/old-1'))).toBe(false);

    swapDirectory(next, target, path.join(root, 'staging/old-2'));
    expect(readFileSync(path.join(target, 'v'), 'utf8')).toBe('2');
    expect(existsSync(path.join(root, 'staging/old-2'))).toBe(false);
  });
});
