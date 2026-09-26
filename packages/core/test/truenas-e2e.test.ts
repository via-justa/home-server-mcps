import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppContext } from '../src/app.js';
import type { AppContext } from '../src/app.js';
import type { ClientPrompts } from '../src/approvals/service.js';
import { setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { createRule } from '../src/catalog/rules.js';
import { loadConfig } from '../src/config/env.js';
import { auditLog, operations } from '../src/db/schema.js';
import type { CallerContext } from '../src/gate/pipeline.js';
import { executeCode } from '../src/runtime/index.js';
import { FAKE_API_KEY, startFakeTrueNas } from '../../../plugins/truenas/test/fake-truenas.js';
import type { FakeTrueNas } from '../../../plugins/truenas/test/fake-truenas.js';

/**
 * The real core running the built TrueNAS plugin (a permission-confined child) against a fake TrueNAS
 * over WebSocket (design §13 phase 17). Skipped until `pnpm build` has produced the plugin bundle.
 */

const PLUGINS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins');
const BUILT = existsSync(path.join(PLUGINS, 'truenas/dist/index.js'));

let ctx: AppContext;
let fake: FakeTrueNas;
let dataDir: string;
let instanceId: string;

beforeAll(async () => {
  if (!BUILT) return;
  fake = await startFakeTrueNas();
  dataDir = mkdtempSync(path.join(tmpdir(), 'hsm-truenas-'));
  ctx = await createAppContext(
    loadConfig({ DATA_DIR: dataDir, CORE_PLUGINS_DIR: PLUGINS, CORE_PLUGINS_AUTOENABLE: 'true' }),
    { memoryDb: true, supervisor: { initTimeoutMs: 5000, rpcTimeoutMs: 10_000 } },
  );
  instanceId = (
    await ctx.instances.create({
      pluginId: 'truenas',
      slug: 'nas',
      connection: { baseUrl: fake.url, apiKey: FAKE_API_KEY },
    })
  ).id;
  await ctx.instances.syncNow(instanceId);
}, 30_000);

afterAll(async () => {
  await ctx?.stop();
  await fake?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const opId = (key: string) =>
  ctx.db
    .select()
    .from(operations)
    .where(and(eq(operations.instanceId, instanceId), eq(operations.key, key)))
    .get()!.id;

/** Runs `execute` code as an MCP client whose user decides approvals with `decide`. */
function run(code: string, decide?: (approvalId: string, message: string) => void) {
  const prompts: ClientPrompts | undefined = decide
    ? {
        url: async (req) => {
          setTimeout(() => decide(req.approvalId, req.message), 10);
          return { action: 'accept' };
        },
      }
    : undefined;
  const caller: CallerContext = { client: { kind: 'mcp_client', id: 'e2e' }, principal: { ceiling: 'write' }, prompts };
  return executeCode(ctx.gateDeps(), ctx.instances.runtime(instanceId), caller, code);
}

describe.skipIf(!BUILT)('TrueNAS plugin end to end (fake TrueNAS)', () => {
  it('syncs core.get_methods into groups that start at Read', () => {
    const rows = ctx.db.select().from(operations).where(eq(operations.instanceId, instanceId)).all();
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.find((o) => o.key === 'pool.dataset.delete')).toMatchObject({ locked: true, typedConfirmation: true });
    expect(rows.find((o) => o.key === 'filesystem.setacl#pool-root')).toMatchObject({ locked: true });
    expect(ctx.instances.get(instanceId)).toMatchObject({ upstreamVersion: 'TrueNAS-25.04.2', lastSyncStatus: 'ok' });
  });

  it('runs reads at Read, redacts secrets in results, and hides writes', async () => {
    await expect(run(`return (await truenas.call('pool.query', [])).map((p) => p.name);`)).resolves.toMatchObject({
      ok: true,
      value: ['tank'],
    });
    const shares = await run(`return await truenas.call('sharing.smb.query');`);
    expect(JSON.stringify(shares)).not.toContain('share-secret-123');
    expect(shares).toMatchObject({ ok: true, value: [{ name: 'media', password: '[REDACTED]' }] });
    await expect(run(`return await truenas.call('pool.dataset.create', { name: 'tank/x' });`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_DISABLED' },
    });
  });

  it('asks for a write at Ask and runs it once a human approves', async () => {
    setGroupLevel(ctx.db, instanceId, 'pool.dataset', 'ask');
    const shown: string[] = [];
    const r = await run(
      `return (await truenas.call('pool.dataset.create', { name: 'tank/apps' })).name;`,
      (id, message) => {
        shown.push(message);
        ctx.approvals.decide(id, { approve: true, decidedBy: 'admin' });
      },
    );
    expect(r).toMatchObject({ ok: true, value: 'tank/apps' });
    expect(shown[0]).toContain('TrueNAS pool.dataset.create({"name":"tank/apps"})');
    expect(fake.datasets.has('tank/apps')).toBe(true);
  });

  it('auto-approves a call a strict rule covers on its positional params', async () => {
    const rt = ctx.instances.runtime(instanceId);
    createRule(ctx.db, rt.manifest, instanceId, {
      operationId: opId('pool.dataset.create'),
      match: [{ field: '/0/name', op: 'prefix', value: 'tank/media' }],
      reason: 'media datasets',
    });
    const covered = await run(`return (await truenas.call('pool.dataset.create', { name: 'tank/media/music' })).name;`);
    expect(covered).toMatchObject({ ok: true, value: 'tank/media/music' });
    // An extra option isn't covered by the strict rule, so a human is asked (and here, nobody can be).
    const extra = await run(`return await truenas.call('pool.dataset.create', { name: 'tank/media/tv', quota: 1 });`);
    expect(extra).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const audit = ctx.db.select().from(auditLog).where(eq(auditLog.operationKey, 'pool.dataset.create')).all();
    expect(audit.map((a) => a.decision)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^auto-approved:rule:/), 'human-approved', 'denied']),
    );
  });

  it('needs the typed dataset name to delete a dataset (locked)', async () => {
    updateOperation(ctx.db, instanceId, opId('pool.dataset.delete'), { level: 'ask' });
    const attempts: string[] = [];
    const r = await run(`return await truenas.call('pool.dataset.delete', 'tank/apps', { recursive: true });`, (id) => {
      try {
        ctx.approvals.decide(id, { approve: true, confirm: 'tank', decidedBy: 'admin' });
      } catch (err) {
        attempts.push((err as Error).message);
        ctx.approvals.decide(id, { approve: true, confirm: 'tank/apps', decidedBy: 'admin' });
      }
    });
    expect(attempts[0]).toMatch(/Type "tank\/apps" exactly/);
    expect(r).toMatchObject({ ok: true, value: true });
    expect(fake.datasets.has('tank/apps')).toBe(false);
  });

  it('reports a TrueNAS permission denial as UPSTREAM_DENIED', async () => {
    fake.denied.add('user.query');
    await expect(run(`return await truenas.call('user.query');`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('user.query');
  });
});
