import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalLinkService } from '../src/approvals/links.js';
import { ApprovalService } from '../src/approvals/service.js';
import { setGroupLevel } from '../src/catalog/groups.js';
import { SecretBox } from '../src/crypto/index.js';
import { openDatabase } from '../src/db/index.js';
import { auditLog, operations, pluginInstances, plugins } from '../src/db/schema.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import { CoreEvents } from '../src/events.js';
import { SlidingWindowLimiter } from '../src/gate/rate-limit.js';
import { InstanceManager } from '../src/instances/manager.js';
import { discoverPlugins, syncPluginRegistry } from '../src/plugins/discovery.js';
import { executeCode, searchCode } from '../src/runtime/index.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function setup() {
  const db = openDatabase(':memory:');
  syncPluginRegistry(db, discoverPlugins([{ dir: PLUGINS, source: 'core' }]), { autoEnableCore: true });
  const events = new CoreEvents();
  const seen: { name: string; payload: unknown }[] = [];
  for (const name of ['instance.status', 'sync.completed', 'sync.failed', 'plugin.crashed'] as const) {
    events.on(name, (payload: unknown) => seen.push({ name, payload }));
  }
  const secrets = SecretBox.fromKey(randomBytes(32));
  const manager = new InstanceManager({
    db,
    secrets,
    events,
    supervisor: { backoff: { initialMs: 20, maxMs: 100 }, initTimeoutMs: 2000, rpcTimeoutMs: 5000 },
    versionCheckIntervalMs: 0,
  });
  cleanup.push(() => manager.stopAll());
  return { db, manager, events, seen, secrets };
}

const create = (
  manager: InstanceManager,
  connection: Record<string, unknown> = { token: 'super-secret-token-1234' },
  slug = 'echo',
) => manager.create({ pluginId: 'echo', slug, connection });

describe('InstanceManager', () => {
  it('creates an instance, encrypts its secrets and starts the plugin', async () => {
    const t = setup();
    const inst = await create(t.manager);
    expect(inst).toMatchObject({ slug: 'echo', displayName: 'Echo (test fixture)', enabled: true, status: 'ready' });
    expect(t.manager.status(inst.id)).toBe('ready');

    const row = t.db.select().from(pluginInstances).get()!;
    expect(row.config).toEqual({});
    expect(row.secretsEnc?.toString('latin1')).not.toContain('super-secret');
    expect(t.manager.getConnection(inst.id).secrets).toEqual({ token: { set: true, hint: '…1234' } });

    const secretsSeen = await t.manager
      .runtime(inst.id)
      .plugin()
      .call('invoke', {
        key: 'k',
        params: { action: 'secrets' },
        context: { callId: 'c', deadlineMs: 1000 },
      });
    expect(secretsSeen).toEqual(['token']);
    expect(
      t.seen.filter((e) => e.name === 'instance.status').map((e) => (e.payload as { status: string }).status),
    ).toEqual(['starting', 'ready']);
  });

  it('validates slugs, uniqueness and connection settings', async () => {
    const t = setup();
    await expect(t.manager.create({ pluginId: 'echo', slug: 'api', connection: {} })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(t.manager.create({ pluginId: 'echo', slug: 'e', connection: { mode: 5 } })).rejects.toThrow(/invalid/);
    await create(t.manager);
    await expect(create(t.manager)).rejects.toBeInstanceOf(ConflictError);
    await expect(t.manager.create({ pluginId: 'nope', slug: 'x', connection: {} })).rejects.toThrow(/No plugin/);
  });

  it('updates connection secrets by merge rules and restarts the child', async () => {
    const t = setup();
    const inst = await create(t.manager);
    const pid = t.manager.runtime(inst.id).plugin().pid;

    await t.manager.updateConnection(inst.id, { config: { mode: 'x' } });
    expect(t.manager.getConnection(inst.id)).toMatchObject({
      config: { mode: 'x' },
      secrets: { token: { set: true } },
    });
    expect(t.manager.runtime(inst.id).plugin().pid).not.toBe(pid);

    await t.manager.updateConnection(inst.id, { config: {}, secrets: { token: null } });
    expect(t.manager.getConnection(inst.id).secrets).toEqual({ token: { set: false } });
    await expect(t.manager.updateConnection(inst.id, { config: {}, secrets: { nope: 'x' } })).rejects.toThrow(
      /not a secret field/,
    );
  });

  it('tests a candidate connection in a throwaway process', async () => {
    const t = setup();
    const inst = await create(t.manager);
    await expect(t.manager.testConnection(inst.id)).resolves.toMatchObject({ ok: true });
    await expect(t.manager.testConnection(inst.id, { config: { mode: 'fail-init' } })).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/cannot reach upstream/),
    });
    expect(t.manager.status(inst.id)).toBe('ready'); // the live instance was untouched
  });

  it('starts and stops with instance and plugin toggles, and deletes with confirmation', async () => {
    const t = setup();
    const inst = await create(t.manager);
    await t.manager.update(inst.id, { enabled: false });
    expect(t.manager.status(inst.id)).toBe('stopped');
    await t.manager.update(inst.id, { enabled: true });
    expect(t.manager.status(inst.id)).toBe('ready');

    const plugin = t.db.select().from(plugins).get()!;
    await t.manager.setPluginEnabled(plugin.id, false);
    expect(t.manager.status(inst.id)).toBe('stopped');
    await t.manager.setPluginEnabled('echo', true);
    expect(t.manager.status(inst.id)).toBe('ready');

    await expect(t.manager.update(inst.id, { slug: 'Bad Slug' })).rejects.toBeInstanceOf(ValidationError);
    await expect(t.manager.remove(inst.id, 'wrong')).rejects.toBeInstanceOf(ConflictError);
    await t.manager.remove(inst.id, 'echo');
    expect(t.db.select().from(pluginInstances).all()).toEqual([]);
  });

  it('syncs on first use, on version change, and records failures', async () => {
    const t = setup();
    const inst = await create(t.manager, { version: '1.0' });
    await t.manager.ensureFresh(inst.id, { forceVersionCheck: true });
    expect(t.db.select().from(operations).all()).toHaveLength(5);
    expect(t.manager.get(inst.id)).toMatchObject({ upstreamVersion: '1.0', lastSyncStatus: 'ok' });

    await t.manager.updateConnection(inst.id, { config: { version: '2.0' } });
    await t.manager.ensureFresh(inst.id);
    expect(t.manager.get(inst.id).upstreamVersion).toBe('2.0');

    await t.manager.updateConnection(inst.id, { config: { mode: 'bad-output' } });
    await expect(t.manager.syncNow(inst.id)).rejects.toThrow(/Invalid syncCatalog result/);
    expect(t.manager.get(inst.id).lastSyncStatus).toMatch(/^error:/);
    expect(t.seen.map((e) => e.name)).toContain('sync.failed');
  });

  it('shares one sync between concurrent callers', async () => {
    const t = setup();
    const inst = await create(t.manager);
    const [a, b] = await Promise.all([t.manager.syncNow(inst.id), t.manager.syncNow(inst.id)]);
    expect(a).toBe(b);
  });

  it('reports crashes and recovers', async () => {
    const t = setup();
    const inst = await create(t.manager);
    await t.manager
      .runtime(inst.id)
      .plugin()
      .call('invoke', { key: 'k', params: { action: 'crash' }, context: { callId: 'c', deadlineMs: 100 } })
      .catch(() => undefined);
    const until = Date.now() + 3000;
    while (t.manager.status(inst.id) !== 'ready' || !t.seen.some((e) => e.name === 'plugin.crashed')) {
      if (Date.now() > until) throw new Error('did not recover');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(t.db.select().from(pluginInstances).where(eq(pluginInstances.id, inst.id)).get()?.status).toBe('ready');
  });

  it('runs search (catalog, guides) and execute through the manager runtime', async () => {
    const t = setup();
    const inst = await create(t.manager);
    await t.manager.syncNow(inst.id);
    const opIds = t.db
      .select()
      .from(operations)
      .all()
      .filter((o) => o.classification === 'write' && !o.locked)
      .map((o) => o.id);
    setGroupLevel(t.db, inst.id, 'echo', 'write', { acknowledge: opIds });

    const approvals = new ApprovalService(t.db, new ApprovalLinkService(t.db));
    cleanup.push(() => approvals.cancelAll());
    const deps = { db: t.db, approvals, limiter: new SlidingWindowLimiter(), attestationKey: randomBytes(32) };
    const rt = t.manager.runtime(inst.id);
    // Level Write with every write acknowledged: echo.guided runs without anyone approving it.
    const caller = { client: { kind: 'mcp_client' as const, id: 'c' }, principal: { ceiling: 'write' as const } };

    const guide = await searchCode(deps, rt, caller, `return await guides.get('echo.guided');`);
    expect(guide).toMatchObject({ ok: true, value: { required: true, version: 'v1', content: 'Read me first.' } });
    const key = (guide as { value: { best_practice_key: string } }).value.best_practice_key;

    const r = await executeCode(
      deps,
      rt,
      caller,
      `return (await ha_or_echo()).key; async function ha_or_echo() { return echo.call('echo.guided', { best_practice_key: ${JSON.stringify(key)} }); }`,
    );
    expect(r).toMatchObject({ ok: true, value: 'echo.guided' });
    // Reading the guide is audited (review M17).
    expect(
      t.db
        .select()
        .from(auditLog)
        .all()
        .find((a) => a.decision === 'guide_read'),
    ).toMatchObject({
      kind: 'search',
      operationKey: 'echo.guided',
      actorId: 'c',
      detail: { guideVersion: 'v1' },
    });
    await expect(searchCode(deps, rt, caller, `return typeof registry`)).resolves.toMatchObject({ value: 'undefined' });
  });
});
