import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { plugins } from '../src/db/schema.js';
import { discoverPlugins, inspectPluginDir, syncPluginRegistry } from '../src/plugins/discovery.js';
import {
  PluginProcess,
  PluginProtocolError,
  PluginRpcError,
  PluginTimeoutError,
  PluginUnavailableError,
} from '../src/plugins/process.js';
import { PluginSupervisor } from '../src/plugins/supervisor.js';
import type { InstanceStatus } from '../src/plugins/supervisor.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins/echo');
const REPO_PLUGINS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'hsm-plugins-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

async function startEcho(config: Record<string, unknown> = {}, secrets: Record<string, string> = {}) {
  const proc = new PluginProcess({ dir: FIXTURE, entry: 'index.mjs', instanceId: 'inst-1', defaultTimeoutMs: 2000 });
  proc.start();
  cleanup.push(() => proc.stop(500));
  await proc.call('init', { instanceId: 'inst-1', config, secrets, sdkVersion: '1.0.0' });
  return proc;
}

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('PluginProcess', () => {
  it('speaks JSON-RPC over IPC and validates results', async () => {
    const proc = await startEcho();
    await expect(proc.call('getUpstreamVersion')).resolves.toBe('1.0');
    expect((await proc.call('syncCatalog')).operations[0]).toMatchObject({ key: 'echo.query', locked: false });
    await expect(
      proc.call('invoke', { key: 'k', params: { a: 1 }, context: { callId: 'c', deadlineMs: 1000 } }),
    ).resolves.toEqual({ a: 1 });
  });

  it('confines the child: own dir readable, nothing else, no writes, scrubbed env', async () => {
    const proc = await startEcho({}, { apiKey: 'secret' });
    const invoke = (params: object) =>
      proc.call('invoke', { key: 'k', params, context: { callId: 'c', deadlineMs: 1000 } });
    await expect(invoke({ action: 'read-own' })).resolves.toBe('ok');
    await expect(invoke({ action: 'read', path: '/etc/hostname' })).resolves.toBe('ERR_ACCESS_DENIED');
    await expect(invoke({ action: 'read', path: path.resolve(FIXTURE, '../../../../package.json') })).resolves.toBe(
      'ERR_ACCESS_DENIED',
    );
    await expect(invoke({ action: 'write' })).resolves.toBe('ERR_ACCESS_DENIED');
    expect(existsSync(path.join(FIXTURE, 'written.txt'))).toBe(false);
    await expect(invoke({ action: 'env' })).resolves.toEqual(['NODE_ENV', 'PLUGIN_INSTANCE_ID']);
    await expect(invoke({ action: 'secrets' })).resolves.toEqual(['apiKey']);
  });

  it('maps plugin errors, contract violations and timeouts', async () => {
    const proc = await startEcho({ mode: 'bad-output' });
    await expect(proc.call('syncCatalog')).rejects.toBeInstanceOf(PluginProtocolError);
    await expect(proc.call('syncRegistry')).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    await expect(proc.call('syncRegistry')).rejects.toBeInstanceOf(PluginRpcError);
    await expect(
      proc.call('invoke', { key: 'k', params: { action: 'hang' }, context: { callId: 'c', deadlineMs: 50 } }, 50),
    ).rejects.toBeInstanceOf(PluginTimeoutError);
  });

  it('rejects in-flight and later calls when the child dies', async () => {
    const proc = await startEcho();
    const crash = proc.call('invoke', {
      key: 'k',
      params: { action: 'crash' },
      context: { callId: 'c', deadlineMs: 1000 },
    });
    await expect(crash).rejects.toBeInstanceOf(PluginUnavailableError);
    await expect(proc.call('getUpstreamVersion')).rejects.toBeInstanceOf(PluginUnavailableError);
    expect(proc.running).toBe(false);
  });

  it('stops gracefully via shutdown', async () => {
    const proc = await startEcho();
    await proc.stop(1000);
    expect(proc.running).toBe(false);
  });
});

describe('PluginSupervisor', () => {
  function supervise(config: { mode?: string }, initTimeoutMs = 300) {
    const statuses: [InstanceStatus, string | undefined][] = [];
    const sup = new PluginSupervisor({
      dir: FIXTURE,
      entry: 'index.mjs',
      instanceId: 'inst-1',
      defaultTimeoutMs: 2000,
      initTimeoutMs,
      backoff: { initialMs: 20, maxMs: 100 },
      loadInit: () => ({ config: { ...config }, secrets: {} }),
      onStatus: (s, e) => statuses.push([s, e]),
    });
    cleanup.push(() => sup.stop());
    return { sup, statuses };
  }

  it('starts, reports ready, and restarts after a crash', async () => {
    const { sup, statuses } = supervise({});
    await sup.start();
    expect(sup.status).toBe('ready');
    const firstPid = sup.client.pid;

    await sup.client
      .call('invoke', { key: 'k', params: { action: 'crash' }, context: { callId: 'c', deadlineMs: 100 } })
      .catch(() => undefined);
    expect(() => sup.client).toThrow(PluginUnavailableError);
    await waitFor(() => sup.status === 'ready');
    expect(sup.client.pid).not.toBe(firstPid);
    expect(statuses.map(([s]) => s)).toEqual(['starting', 'ready', 'error', 'starting', 'ready']);
    expect(statuses[2]?.[1]).toMatch(/exited unexpectedly/);
  });

  it('backs off on init failures and recovers once the config is fixed', async () => {
    const config: { mode?: string } = { mode: 'fail-init' };
    const { sup, statuses } = supervise(config);
    await sup.start();
    expect(sup.status).toBe('error');
    await waitFor(() => statuses.filter(([s]) => s === 'error').length >= 3);
    expect(statuses.find(([s]) => s === 'error')?.[1]).toMatch(/init failed: cannot reach upstream/);

    delete config.mode;
    await waitFor(() => sup.status === 'ready');
  });

  it('treats a hanging or crashing init as a failure', async () => {
    for (const mode of ['hang-init', 'crash-init']) {
      const { sup, statuses } = supervise({ mode });
      await sup.start();
      await waitFor(() => statuses.some(([s]) => s === 'error'));
      await sup.stop();
      expect(sup.status).toBe('stopped');
    }
  });

  /** Records every child the supervisor forks, so a test can check none is left behind. */
  function trackChildren() {
    const spawned: PluginProcess[] = [];
    const start = PluginProcess.prototype.start;
    const spy = vi.spyOn(PluginProcess.prototype, 'start').mockImplementation(function (this: PluginProcess) {
      spawned.push(this);
      start.call(this);
    });
    cleanup.push(() => spy.mockRestore());
    return () => spawned.filter((p) => p.running).length;
  }

  it('serializes concurrent restarts: exactly one child survives', async () => {
    const live = trackChildren();
    const { sup, statuses } = supervise({});
    await sup.start();
    await Promise.all([sup.restart(), sup.restart(), sup.start(), sup.restart()]);
    expect(sup.status).toBe('ready');
    await waitFor(() => live() === 1);
    expect(sup.client.running).toBe(true);
    expect(statuses.map(([s]) => s)).not.toContain('error');
  });

  it('stops promptly during init and kills the child being initialized', async () => {
    const live = trackChildren();
    const { sup } = supervise({ mode: 'hang-init' }, 10_000);
    const starting = sup.start();
    await waitFor(() => sup.status === 'starting' && live() === 1);
    const t0 = Date.now();
    await sup.stop();
    await starting;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(sup.status).toBe('stopped');
    await waitFor(() => live() === 0);
  });

  it('does not restart after an explicit stop', async () => {
    const { sup, statuses } = supervise({});
    await sup.start();
    await sup.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(statuses.at(-1)?.[0]).toBe('stopped');
    expect(statuses.map(([s]) => s)).not.toContain('error');
  });
});

describe('discovery', () => {
  it('finds the fixture and the repo core plugins (once built) and validates manifests', () => {
    const root = tmp();
    cpSync(FIXTURE, path.join(root, 'echo'), { recursive: true });
    mkdirSync(path.join(root, 'broken'));
    writeFileSync(path.join(root, 'broken', 'manifest.json'), '{"id": "Broken"}');
    mkdirSync(path.join(root, 'newer'));
    cpSync(path.join(FIXTURE, 'index.mjs'), path.join(root, 'newer', 'index.mjs'));
    writeFileSync(
      path.join(root, 'newer', 'manifest.json'),
      JSON.stringify({
        ...JSON.parse('{}'),
        id: 'newer',
        name: 'n',
        version: '1.0.0',
        sdk: '^2.0.0',
        entry: 'index.mjs',
        binding: { namespace: 'n', functions: ['call'] },
        connection: { schema: {} },
      }),
    );

    const found = discoverPlugins([{ dir: root, source: 'repo' }]);
    expect(found.map((p) => [p.status, p.status === 'ok' ? p.manifest.id : p.pluginId])).toEqual([
      ['invalid', 'broken'],
      ['ok', 'echo'],
      ['incompatible', 'newer'],
    ]);
  });

  it('rejects an entry that escapes the plugin dir via symlink, or is missing', () => {
    const root = tmp();
    const dir = path.join(root, 'evil');
    mkdirSync(dir);
    cpSync(path.join(FIXTURE, 'manifest.json'), path.join(dir, 'manifest.json'));
    expect(inspectPluginDir(dir, 'repo')).toMatchObject({
      status: 'invalid',
      error: expect.stringMatching(/not found/),
    });
    symlinkSync(path.join(FIXTURE, 'index.mjs'), path.join(dir, 'index.mjs'));
    expect(inspectPluginDir(dir, 'repo')).toMatchObject({ status: 'invalid', error: expect.stringMatching(/outside/) });
  });

  it('upserts the registry: core auto-enable, no shadowing of core ids, missing plugins kept', () => {
    const db = openDatabase(':memory:');
    const coreRoot = tmp();
    const repoRoot = tmp();
    cpSync(FIXTURE, path.join(coreRoot, 'echo'), { recursive: true });
    cpSync(FIXTURE, path.join(repoRoot, 'echo'), { recursive: true });

    const first = syncPluginRegistry(
      db,
      discoverPlugins([
        { dir: coreRoot, source: 'core' },
        { dir: repoRoot, source: 'repo' },
      ]),
      { autoEnableCore: true },
    );
    expect(first).toMatchObject({ added: ['echo'], rejected: ['echo'] });
    expect(db.select().from(plugins).get()).toMatchObject({
      pluginId: 'echo',
      source: 'core',
      enabled: true,
      status: 'ok',
    });

    const second = syncPluginRegistry(db, discoverPlugins([{ dir: repoRoot, source: 'repo' }]), {
      autoEnableCore: false,
    });
    expect(second.updated).toEqual(['echo']);

    const third = syncPluginRegistry(db, [], { autoEnableCore: false });
    expect(third.missing).toEqual(['echo']);
    expect(db.select().from(plugins).get()).toMatchObject({ status: 'invalid', enabled: true });
  });

  it('keeps a repo plugin row when a later core release claims its id (review L6)', () => {
    const db = openDatabase(':memory:');
    const repoRoot = tmp();
    cpSync(FIXTURE, path.join(repoRoot, 'echo'), { recursive: true });
    syncPluginRegistry(db, discoverPlugins([{ dir: repoRoot, source: 'repo' }]), { autoEnableCore: true });
    const before = db.select().from(plugins).get()!;
    expect(before).toMatchObject({ source: 'repo', status: 'ok' });

    const coreRoot = tmp();
    cpSync(FIXTURE, path.join(coreRoot, 'echo'), { recursive: true });
    const found = discoverPlugins([
      { dir: coreRoot, source: 'core' },
      { dir: repoRoot, source: 'repo' },
    ]);
    const out = syncPluginRegistry(db, found, { autoEnableCore: true });
    expect(out.rejected).toContain('echo');
    const after = db.select().from(plugins).get()!;
    expect(after).toMatchObject({ id: before.id, source: 'repo', path: before.path, status: 'invalid' });
    expect(after.statusError).toMatch(/core plugin now uses/);
    // Re-running discovery doesn't flip it either.
    syncPluginRegistry(db, found, { autoEnableCore: true });
    expect(db.select().from(plugins).all()).toHaveLength(1);
    expect(db.select().from(plugins).get()).toMatchObject({ source: 'repo', status: 'invalid' });
  });

  it.skipIf(!existsSync(path.join(REPO_PLUGINS, 'truenas', 'dist', 'index.js')))(
    'discovers the built core plugins and runs their bundles under the permission model',
    async () => {
      const found = discoverPlugins([{ dir: REPO_PLUGINS, source: 'core' }]);
      expect(found.map((p) => [p.status, p.status === 'ok' ? p.manifest.id : p.pluginId])).toEqual([
        ['ok', 'homeassistant'],
        ['ok', 'seerr'],
        ['ok', 'truenas'],
      ]);
      for (const p of found) {
        if (p.status !== 'ok') continue;
        const proc = new PluginProcess({
          dir: p.dir,
          entry: p.manifest.entry,
          instanceId: 'i',
          defaultTimeoutMs: 5000,
        });
        proc.start();
        cleanup.push(() => proc.stop(500));
        if (p.manifest.id === 'truenas') {
          // A real plugin: it loads, takes its config and reports an unreachable upstream cleanly
          // (its bundled WebSocket client works with no access outside its own directory).
          await proc.call('init', {
            instanceId: 'i',
            config: { baseUrl: 'http://127.0.0.1:1' },
            secrets: { apiKey: 'k' },
            sdkVersion: '1.0.0',
          });
          await expect(proc.call('testConnection')).resolves.toMatchObject({ ok: false });
          continue;
        }
        if (p.manifest.id === 'seerr') {
          // Same for Seerr's bundled YAML parser and global fetch.
          await proc.call('init', {
            instanceId: 'i',
            config: { baseUrl: 'http://127.0.0.1:1', authMethod: 'apiKey' },
            secrets: { apiKey: 'k' },
            sdkVersion: '1.0.0',
          });
          await expect(proc.call('testConnection')).resolves.toMatchObject({ ok: false });
          continue;
        }
        // The skeleton plugins answer NOT_IMPLEMENTED — which proves the bundle loaded with no
        // access outside its own directory.
        await expect(proc.call('getUpstreamVersion')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
      }
    },
  );
});
