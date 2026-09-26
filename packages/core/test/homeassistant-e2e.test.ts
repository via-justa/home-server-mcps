import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppContext } from '../src/app.js';
import type { AppContext } from '../src/app.js';
import { setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { createRule } from '../src/catalog/rules.js';
import { loadConfig } from '../src/config/env.js';
import { auditLog, operations, pendingApprovals, registryEntries } from '../src/db/schema.js';
import type { CallerContext } from '../src/gate/pipeline.js';
import { executeCode, searchCode } from '../src/runtime/index.js';
import { FAKE_TOKEN, startFakeHa } from '../../../plugins/homeassistant/test/fake-ha.js';
import type { FakeHa } from '../../../plugins/homeassistant/test/fake-ha.js';

/**
 * The real core running the built Home Assistant plugin (a permission-confined child) against a fake
 * Home Assistant over WebSocket and REST (design §13 phase 19). Skipped until `pnpm build` has
 * produced the plugin bundle.
 */

const PLUGINS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins');
const BUILT = existsSync(path.join(PLUGINS, 'homeassistant/dist/index.js'));

let ctx: AppContext;
let fake: FakeHa;
let dataDir: string;
let instanceId: string;

beforeAll(async () => {
  if (!BUILT) return;
  fake = await startFakeHa();
  dataDir = mkdtempSync(path.join(tmpdir(), 'hsm-ha-'));
  ctx = await createAppContext(
    loadConfig({ DATA_DIR: dataDir, CORE_PLUGINS_DIR: PLUGINS, CORE_PLUGINS_AUTOENABLE: 'true' }),
    { memoryDb: true, supervisor: { initTimeoutMs: 5000, rpcTimeoutMs: 10_000 } },
  );
  instanceId = (
    await ctx.instances.create({
      pluginId: 'homeassistant',
      slug: 'ha',
      connection: { baseUrl: fake.url, token: FAKE_TOKEN },
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

const caller = (decide?: (approvalId: string, message: string) => void): CallerContext => ({
  client: { kind: 'mcp_client', id: 'e2e' },
  principal: { ceiling: 'write' },
  mcpSessionId: 'session-1',
  prompts: decide
    ? {
        url: async (req) => {
          setTimeout(() => decide(req.approvalId, req.message), 10);
          return { action: 'accept' };
        },
      }
    : undefined,
});

const run = (code: string, decide?: (approvalId: string, message: string) => void) =>
  executeCode(ctx.gateDeps(), ctx.instances.runtime(instanceId), caller(decide), code);

describe.skipIf(!BUILT)('Home Assistant plugin end to end (fake Home Assistant)', () => {
  it('syncs the catalog and the registry; every domain starts at Read', () => {
    const rows = ctx.db.select().from(operations).where(eq(operations.instanceId, instanceId)).all();
    expect(rows.find((o) => o.key === 'lock.unlock')).toMatchObject({ locked: true, classification: 'write' });
    expect(rows.find((o) => o.key === 'cover.open_cover#garage')).toMatchObject({ locked: true });
    expect(rows.find((o) => o.key === 'config/automation/config/update')).toMatchObject({
      kind: 'config',
      attestationRequired: true,
    });
    expect(ctx.instances.get(instanceId)).toMatchObject({ upstreamVersion: '2026.9.1', lastSyncStatus: 'ok' });
    const registry = ctx.db.select().from(registryEntries).where(eq(registryEntries.instanceId, instanceId)).all();
    expect(registry.find((e) => e.extId === 'light.ceiling')).toMatchObject({
      kind: 'entity',
      name: 'Living Room Ceiling',
      parentExtId: 'living_room',
    });
  });

  it('reads states with camera tokens redacted, and hides service calls at Read', async () => {
    const states = await run(`return await ha.call('get_states', { domain: 'camera' });`);
    expect(JSON.stringify(states)).not.toContain('cam-secret-token-123');
    expect(states).toMatchObject({
      ok: true,
      value: [{ entity_id: 'camera.driveway', attributes: { access_token: '[REDACTED]' } }],
    });
    await expect(run(`return await ha.call('light.turn_on', { area_id: 'kitchen' });`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_DISABLED' },
    });
  });

  it('asks before lighting a room, naming the entities, and acts on exactly those', async () => {
    setGroupLevel(ctx.db, instanceId, 'light', 'ask');
    const shown: string[] = [];
    const r = await run(
      `await ha.call('light.turn_on', { area_id: 'living_room', brightness: 80 }); return 'done';`,
      (id, message) => {
        shown.push(message);
        ctx.approvals.decide(id, { approve: true, decidedBy: 'admin' });
      },
    );
    expect(r).toMatchObject({ ok: true, value: 'done' });
    expect(shown[0]).toContain('on Living Room Ceiling, Reading Lamp');
    expect(fake.calls.filter((c) => c.type === 'call_service').at(-1)?.payload).toEqual({
      domain: 'light',
      service: 'turn_on',
      service_data: { brightness: 80 },
      target: { entity_id: ['light.ceiling', 'light.reading_lamp'] },
    });
  });

  it('auto-approves under an area rule only when every target is in the area', async () => {
    const rt = ctx.instances.runtime(instanceId);
    createRule(ctx.db, rt.manifest, instanceId, {
      operationId: opId('light.turn_off'),
      match: [{ field: '$targets', areas: ['living_room'] }],
      reason: 'living room lights',
    });
    const inside = await run(`await ha.call('light.turn_off', { area_id: 'living_room' }); return 'off';`);
    expect(inside).toMatchObject({ ok: true, value: 'off' });
    // One kitchen light as well: the rule doesn't cover it, so a human is asked (and here, nobody can be).
    const mixed = await run(
      `return await ha.call('light.turn_off', { area_id: 'living_room', entity_id: 'light.kitchen' });`,
    );
    expect(mixed).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const decisions = ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.operationKey, 'light.turn_off'))
      .all()
      .map((a) => a.decision);
    expect(decisions).toEqual(expect.arrayContaining([expect.stringMatching(/^auto-approved:rule:/), 'denied']));
  });

  it('needs the garage door typed back to open it, and never auto-approves it', async () => {
    setGroupLevel(ctx.db, instanceId, 'cover', 'ask');
    updateOperation(ctx.db, instanceId, opId('cover.open_cover#garage'), { level: 'ask' });
    const attempts: string[] = [];
    const r = await run(`await ha.call('cover.open_cover', { area_id: 'garage' }); return 'open';`, (id) => {
      try {
        ctx.approvals.decide(id, { approve: true, confirm: 'garage', decidedBy: 'admin' });
      } catch (err) {
        attempts.push((err as Error).message);
        ctx.approvals.decide(id, { approve: true, confirm: 'Garage Door', decidedBy: 'admin' });
      }
    });
    expect(attempts[0]).toMatch(/Type "Garage Door" exactly/);
    expect(r).toMatchObject({ ok: true, value: 'open' });
    expect(fake.calls.filter((c) => c.type === 'call_service').at(-1)?.payload).toMatchObject({
      service: 'open_cover',
      target: { entity_id: ['cover.garage_door'] },
    });
  });

  it('edits an automation: guide first, then an approval with the diff, and a conflict if HA changed meanwhile', async () => {
    setGroupLevel(ctx.db, instanceId, 'automation', 'ask');
    const rt = ctx.instances.runtime(instanceId);
    const read = `const { config_hash } = await ha.call('config/automation/config/get', { id: 'morning' });`;
    const patch = `patch: [{ op: 'replace', path: '/alias', value: 'Sunrise lights' }]`;
    // No guide read yet: refused before anything else.
    await expect(
      run(`${read} return await ha.call('config/automation/config/update', { id: 'morning', config_hash, ${patch} });`),
    ).resolves.toMatchObject({ ok: false, error: { code: 'ATTESTATION_REQUIRED' } });
    const guide = await searchCode(
      ctx.gateDeps(),
      rt,
      caller(),
      `return await guides.get('config/automation/config/update');`,
    );
    const key = (guide as { value: { best_practice_key: string } }).value.best_practice_key;
    expect(key).toBeTruthy();

    const shown: { diff?: unknown }[] = [];
    const ok = await run(
      `${read} return await ha.call('config/automation/config/update', { id: 'morning', config_hash, best_practice_key: '${key}', ${patch} });`,
      (id) => {
        shown.push(ctx.db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get()!);
        ctx.approvals.decide(id, { approve: true, decidedBy: 'admin' });
      },
    );
    expect(ok).toMatchObject({ ok: true, value: { id: 'morning' } });
    expect(shown[0]?.diff).toEqual([{ path: '/alias', before: 'Morning lights', after: 'Sunrise lights' }]);
    expect(fake.automations.get('morning')).toMatchObject({ alias: 'Sunrise lights' });

    // Someone edits the automation in the HA UI while the approval is open.
    const conflict = await run(
      `${read} return await ha.call('config/automation/config/update', { id: 'morning', config_hash, best_practice_key: '${key}', patch: [{ op: 'replace', path: '/mode', value: 'restart' }] });`,
      (id) => {
        fake.automations.set('morning', { ...fake.automations.get('morning'), alias: 'Edited in the UI' });
        ctx.approvals.decide(id, { approve: true, decidedBy: 'admin' });
      },
    );
    expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFIG_CONFLICT' } });
    expect(fake.automations.get('morning')).toMatchObject({ alias: 'Edited in the UI', mode: 'single' });
  });

  it('reports a Home Assistant permission denial as UPSTREAM_DENIED', async () => {
    fake.denied.add('history/history_during_period');
    await expect(
      run(
        `return await ha.call('history/history_during_period', { start_time: '2026-09-01T00:00:00Z', entity_ids: ['light.kitchen'] });`,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'UPSTREAM_DENIED' } });
    fake.denied.delete('history/history_during_period');
  });
});
