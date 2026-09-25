import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '@home-server-mcps/plugin-sdk';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../src/approvals/service.js';
import type { ElicitFn, ElicitRequest } from '../src/approvals/service.js';
import { setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { applyCatalogSync } from '../src/catalog/sync.js';
import { openDatabase } from '../src/db/index.js';
import { auditLog, guides, operations, pendingApprovals, preApprovalRules } from '../src/db/schema.js';
import { issueAttestationKey } from '../src/gate/attestation.js';
import type { CallerContext, GateDeps, InstanceRuntime } from '../src/gate/pipeline.js';
import { SlidingWindowLimiter } from '../src/gate/rate-limit.js';
import { createRedactor, GLOBAL_SENSITIVE_KEYS } from '../src/gate/redact.js';
import { parseInstanceSettings } from '../src/instances/settings.js';
import type { InstanceSettings } from '../src/instances/settings.js';
import { PluginProcess } from '../src/plugins/process.js';
import { executeCode, searchCode } from '../src/runtime/index.js';
import { seedInstance } from './helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins/echo');
const manifest = parseManifest(JSON.parse(readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8')));

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(settings: Partial<InstanceSettings> = {}) {
  const { db, instanceId } = seedInstance(openDatabase(':memory:'), 'echo');
  const proc = new PluginProcess({ dir: FIXTURE, entry: manifest.entry, instanceId, defaultTimeoutMs: 5000 });
  proc.start();
  cleanup.push(() => proc.stop(500));
  await proc.call('init', { instanceId, config: {}, secrets: {}, sdkVersion: '1.0.0' });
  applyCatalogSync(db, instanceId, await proc.call('syncCatalog'));

  const approvals = new ApprovalService(db);
  cleanup.push(() => approvals.cancelAll());
  const deps: GateDeps = { db, approvals, limiter: new SlidingWindowLimiter(), attestationKey: randomBytes(32) };
  const rt: InstanceRuntime = {
    instanceId,
    slug: 'echo',
    manifest,
    settings: { ...parseInstanceSettings({}), ...settings },
    redact: createRedactor(GLOBAL_SENSITIVE_KEYS, manifest.sensitiveKeys),
    plugin: () => proc,
  };
  const opId = (key: string) => db.select().from(operations).where(eq(operations.key, key)).get()!.id;
  const openWrites = () =>
    setGroupLevel(db, instanceId, 'echo', 'write', {
      acknowledge: [opId('echo.set'), opId('echo.delete'), opId('echo.nolit'), opId('echo.guided')].filter((id) => {
        const o = db.select().from(operations).where(eq(operations.id, id)).get()!;
        return !o.locked;
      }),
    });
  const caller = (elicit?: ElicitFn): CallerContext => ({ client: { kind: 'mcp_client', id: 'claude-test' }, elicit });
  const exec = (code: string, elicit?: ElicitFn) => executeCode(deps, rt, caller(elicit), code);
  const audits = () => db.select().from(auditLog).where(eq(auditLog.kind, 'call')).all();
  return { db, instanceId, proc, deps, rt, opId, openWrites, exec, audits, approvals, caller };
}

const approveAll: ElicitFn = async (req) => ({
  action: 'accept',
  content: {
    approve: true,
    confirm: /Type "(.*)" to confirm/.exec(req.requestedSchema.properties.confirm?.title ?? '')?.[1],
  },
});

const waitFor = async (pred: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('execute → gate → plugin', () => {
  it('runs reads immediately, redacts results, and audits', async () => {
    const t = await setup();
    const r = await t.exec(`return await echo.call('echo.query', { q: 1 });`);
    expect(r).toMatchObject({ ok: true, value: { key: 'echo.query', params: { q: 1 }, password: '[REDACTED]' } });
    expect(t.audits()).toMatchObject([
      {
        operationKey: 'echo.query',
        classification: 'read',
        decision: 'auto-executed',
        resultStatus: 'ok',
        actorId: 'claude-test',
      },
    ]);
  });

  it('rejects writes in a read-only group with a catchable reason', async () => {
    const t = await setup();
    const r = await t.exec(
      `try { await echo.call('echo.set', { name: 'x' }); } catch (e) { return [e.code, e.message]; }`,
    );
    expect(r).toMatchObject({
      ok: true,
      value: ['OPERATION_DISABLED', 'echo.set is a write, and its group is read-only on this endpoint'],
    });
    expect(t.audits()[0]).toMatchObject({ decision: 'rejected:group_read_only', resultStatus: 'rejected' });
  });

  it('rejects operations the plugin does not know', async () => {
    const t = await setup();
    const r = await t.exec(`await echo.call('echo.nope');`);
    expect(r).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OPERATION' } });
    expect(t.audits()[0]).toMatchObject({ decision: 'rejected:unknown_operation' });
  });

  it('asks a human over elicitation and runs the call once approved', async () => {
    const t = await setup();
    t.openWrites();
    const asked: ElicitRequest[] = [];
    const r = await t.exec(`return await echo.call('echo.set', { name: 'tank/a', password: 'pw' });`, async (req) => {
      asked.push(req);
      return { action: 'accept', content: { approve: true } };
    });
    expect(r).toMatchObject({ ok: true, value: { key: 'echo.set' } });
    expect(asked[0]?.message).toContain('echo.set');
    expect(asked[0]?.message).not.toContain('pw'); // redacted in the prompt
    expect(asked[0]?.requestedSchema.required).toEqual(['approve']);
    expect(t.audits()[0]).toMatchObject({
      decision: 'human-approved',
      decidedVia: 'elicitation',
      classification: 'write',
    });
    const row = t.db.select().from(pendingApprovals).get()!;
    expect(row).toMatchObject({ status: 'approved', paramsDisplay: { name: 'tank/a', password: '[REDACTED]' } });
    expect(row.paramsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('surfaces a denial as a catchable PERMISSION_DENIED', async () => {
    const t = await setup();
    t.openWrites();
    const r = await t.exec(
      `try { await echo.call('echo.set', { name: 'x' }); } catch (e) { return e.code; }`,
      async () => ({
        action: 'decline',
      }),
    );
    expect(r).toMatchObject({ ok: true, value: 'PERMISSION_DENIED' });
    expect(t.audits()[0]).toMatchObject({ decision: 'denied', decidedVia: 'elicitation' });
  });

  it('waits for a portal decision when the client cannot elicit', async () => {
    const t = await setup();
    t.openWrites();
    const run = t.exec(`return await echo.call('echo.set', { name: 'x' });`);
    await waitFor(() => t.approvals.pendingCount === 1);
    const row = t.db.select().from(pendingApprovals).where(eq(pendingApprovals.status, 'pending')).get()!;
    t.approvals.decide(row.id, { approve: true, decidedBy: 'admin', via: 'portal' });
    await expect(run).resolves.toMatchObject({ ok: true });
    expect(t.audits()[0]).toMatchObject({ decision: 'human-approved', decidedBy: 'admin', decidedVia: 'portal' });
  });

  it('denies immediately when there is no approval path', async () => {
    const t = await setup({ allowPortalOnlyApprovals: false });
    t.openWrites();
    const r = await t.exec(`await echo.call('echo.set', { name: 'x' });`);
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('no_approval_path') },
    });
  });

  it('times out unanswered approvals as denials, without spending the sandbox budget', async () => {
    const t = await setup({ approvalTimeoutMs: 300, sandbox: { timeoutMs: 150, memoryMb: 64, maxResultBytes: 65536 } });
    t.openWrites();
    const r = await t.exec(`try { await echo.call('echo.set', { name: 'x' }); } catch (e) { return e.message; }`);
    expect(r).toMatchObject({ ok: true, value: 'Approval for echo.set timed out and was denied' });
    expect(t.audits()[0]).toMatchObject({ decision: 'timed-out' });
    expect(t.db.select().from(pendingApprovals).get()?.status).toBe('timed_out');
  });

  it('serializes calls: a second write waits until the first is decided', async () => {
    const t = await setup();
    t.openWrites();
    const run = t.exec(
      `return await Promise.all([echo.call('echo.set', { name: 'a' }), echo.call('echo.set', { name: 'b' })]);`,
    );
    await waitFor(() => t.approvals.pendingCount === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.approvals.pendingCount).toBe(1);
    const first = t.db.select().from(pendingApprovals).where(eq(pendingApprovals.status, 'pending')).get()!;
    t.approvals.decide(first.id, { approve: true, decidedBy: 'admin', via: 'portal' });
    await waitFor(
      () => t.db.select().from(pendingApprovals).where(eq(pendingApprovals.status, 'pending')).all().length === 1,
    );
    const second = t.db.select().from(pendingApprovals).where(eq(pendingApprovals.status, 'pending')).get()!;
    expect(second.paramsHash).not.toBe(first.paramsHash); // each approval is scoped to its own params
    t.approvals.decide(second.id, { approve: true, decidedBy: 'admin', via: 'portal' });
    await expect(run).resolves.toMatchObject({
      ok: true,
      value: [{ params: { name: 'a' } }, { params: { name: 'b' } }],
    });
  });

  describe('locked operations', () => {
    it('stay unreachable at write level until opted in', async () => {
      const t = await setup();
      t.openWrites();
      const r = await t.exec(`await echo.call('echo.delete', { name: 'tank/x' });`, approveAll);
      expect(r).toMatchObject({ ok: false, error: { code: 'OPERATION_DISABLED' } });
    });

    it('require the typed confirmation literal from the plugin', async () => {
      const t = await setup();
      t.openWrites();
      updateOperation(t.db, t.instanceId, t.opId('echo.delete'), { lockedOptIn: true });

      const asked: ElicitRequest[] = [];
      const wrong = await t.exec(`await echo.call('echo.delete', { name: 'tank/x' });`, async (req) => {
        asked.push(req);
        return { action: 'accept', content: { approve: true, confirm: 'tank/y' } };
      });
      expect(asked[0]?.requestedSchema.required).toEqual(['approve', 'confirm']);
      expect(asked[0]?.requestedSchema.properties.confirm?.title).toBe('Type "tank/x" to confirm');
      expect(wrong).toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('confirmation_mismatch') },
      });

      const right = await t.exec(`return (await echo.call('echo.delete', { name: 'tank/x' })).key;`, approveAll);
      expect(right).toMatchObject({ ok: true, value: 'echo.delete' });
    });

    it('are refused when the plugin gives no confirmation literal', async () => {
      const t = await setup();
      t.openWrites();
      updateOperation(t.db, t.instanceId, t.opId('echo.nolit'), { lockedOptIn: true });
      const r = await t.exec(`await echo.call('echo.nolit', {});`, approveAll);
      expect(r).toMatchObject({ ok: false, error: { code: 'PLUGIN_ERROR' } });
    });

    it('are never pre-approved, even by a rule that slipped into the DB', async () => {
      const t = await setup({ allowPortalOnlyApprovals: false });
      t.openWrites();
      updateOperation(t.db, t.instanceId, t.opId('echo.delete'), { lockedOptIn: true });
      t.db
        .insert(preApprovalRules)
        .values({ id: randomUUID(), instanceId: t.instanceId, operationId: t.opId('echo.delete'), reason: 'x' })
        .run();
      const r = await t.exec(`await echo.call('echo.delete', { name: 'tank/x' });`);
      expect(r).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    });
  });

  describe('pre-approval rules', () => {
    function addRule(t: Awaited<ReturnType<typeof setup>>, extra: Partial<typeof preApprovalRules.$inferInsert> = {}) {
      const id = randomUUID();
      t.db
        .insert(preApprovalRules)
        .values({
          id,
          instanceId: t.instanceId,
          operationId: t.opId('echo.set'),
          match: [{ field: '/name', op: 'prefix', value: 'tank/media/' }],
          reason: 'media datasets',
          ...extra,
        })
        .run();
      return id;
    }

    it('auto-approve matching calls and send the rest to a human', async () => {
      const t = await setup({ allowPortalOnlyApprovals: false });
      t.openWrites();
      const ruleId = addRule(t);
      await expect(
        t.exec(`return (await echo.call('echo.set', { name: 'tank/media/tv' })).key;`),
      ).resolves.toMatchObject({ ok: true });
      await expect(t.exec(`await echo.call('echo.set', { name: 'tank/other' });`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED' },
      });
      expect(t.audits().map((a) => a.decision)).toEqual([`auto-approved:rule:${ruleId}`, 'denied']);
      expect(t.db.select().from(pendingApprovals).all()).toHaveLength(1); // only the non-matching call
    });

    it('fall back to a human once the rate limit is hit', async () => {
      const t = await setup();
      t.openWrites();
      const ruleId = addRule(t, { rateLimit: 1, windowSeconds: 3600 });
      await t.exec(`await echo.call('echo.set', { name: 'tank/media/a' });`);
      const r = await t.exec(`return (await echo.call('echo.set', { name: 'tank/media/b' })).key;`, approveAll);
      expect(r).toMatchObject({ ok: true });
      const [first, second] = t.audits();
      expect(first?.decision).toBe(`auto-approved:rule:${ruleId}`);
      expect(second).toMatchObject({
        decision: 'human-approved',
        detail: expect.objectContaining({ rateLimitedRules: [ruleId] }),
      });
    });

    it('ignore expired and disabled rules', async () => {
      const t = await setup({ allowPortalOnlyApprovals: false });
      t.openWrites();
      addRule(t, { expiresAt: new Date(Date.now() - 1000) });
      addRule(t, { enabled: false });
      await expect(t.exec(`await echo.call('echo.set', { name: 'tank/media/a' });`)).resolves.toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED' },
      });
    });
  });

  it('requires a current best-practice key for attested operations', async () => {
    const t = await setup();
    t.openWrites();
    const opId = t.opId('echo.guided');
    const call = (key?: string) =>
      t.exec(
        `return (await echo.call('echo.guided', ${JSON.stringify(key ? { best_practice_key: key } : {})})).key;`,
        approveAll,
      );

    await expect(call()).resolves.toMatchObject({ ok: false, error: { code: 'ATTESTATION_REQUIRED' } });
    t.db
      .insert(guides)
      .values({
        id: randomUUID(),
        instanceId: t.instanceId,
        operationId: opId,
        version: 'v1',
        content: 'x',
        fetchedAt: new Date(1000),
      })
      .run();
    const v1 = issueAttestationKey(t.deps.attestationKey, t.instanceId, 'echo.guided', 'v1');
    await expect(call('forged')).resolves.toMatchObject({ ok: false, error: { code: 'ATTESTATION_REQUIRED' } });
    await expect(call(v1)).resolves.toMatchObject({ ok: true, value: 'echo.guided' });

    t.db
      .insert(guides)
      .values({
        id: randomUUID(),
        instanceId: t.instanceId,
        operationId: opId,
        version: 'v2',
        content: 'y',
        fetchedAt: new Date(2000),
      })
      .run();
    await expect(call(v1)).resolves.toMatchObject({ ok: false, error: { code: 'ATTESTATION_REQUIRED' } });
  });

  it('enforces the per-instance call rate limit', async () => {
    const t = await setup({ executePerMinute: 2 });
    const r = await t.exec(`
      const out = [];
      for (let i = 0; i < 3; i++) { try { await echo.call('echo.query'); out.push('ok'); } catch (e) { out.push(e.code); } }
      return out;`);
    expect(r).toMatchObject({ ok: true, value: ['ok', 'ok', 'RATE_LIMITED'] });
  });

  it('maps upstream and plugin failures to structured errors', async () => {
    const t = await setup();
    const denied = await t.exec(`await echo.call('echo.query', { action: 'upstream-denied' });`);
    expect(denied).toMatchObject({ ok: false, error: { code: 'UPSTREAM_DENIED', message: 'insufficient permission' } });
    expect(t.audits()[0]).toMatchObject({ decision: 'error:UPSTREAM_DENIED', resultStatus: 'error' });

    await t.proc.stop(500);
    const down = await t.exec(`await echo.call('echo.query');`);
    expect(down).toMatchObject({ ok: false, error: { code: 'PLUGIN_UNAVAILABLE' } });
  });
});

describe('ApprovalService', () => {
  it('denies approvals left pending by a previous process', async () => {
    const t = await setup();
    t.openWrites();
    const run = t.exec(`await echo.call('echo.set', { name: 'x' });`);
    await waitFor(() => t.approvals.pendingCount === 1);
    // Simulate a restart: a fresh process sees the row but has none of the in-memory state.
    expect(ApprovalService.denyOrphans(t.db)).toBe(1);
    expect(t.db.select().from(pendingApprovals).get()?.status).toBe('denied');
    const row = t.db.select().from(pendingApprovals).get()!;
    expect(() => new ApprovalService(t.db).decide(row.id, { approve: true, decidedBy: 'a', via: 'portal' })).toThrow(
      /already denied/,
    );
    t.approvals.cancelAll();
    await run;
  });

  it('rejects a wrong portal confirmation but lets the admin retry', async () => {
    const t = await setup();
    t.openWrites();
    updateOperation(t.db, t.instanceId, t.opId('echo.delete'), { lockedOptIn: true });
    const run = t.exec(`return (await echo.call('echo.delete', { name: 'tank/x' })).key;`);
    await waitFor(() => t.approvals.pendingCount === 1);
    const row = t.db
      .select()
      .from(pendingApprovals)
      .where(and(eq(pendingApprovals.status, 'pending')))
      .get()!;
    expect(() =>
      t.approvals.decide(row.id, { approve: true, confirm: 'nope', decidedBy: 'admin', via: 'portal' }),
    ).toThrow(/Type "tank\/x" exactly/);
    t.approvals.decide(row.id, { approve: true, confirm: 'tank/x', decidedBy: 'admin', via: 'portal' });
    await expect(run).resolves.toMatchObject({ ok: true, value: 'echo.delete' });
    expect(() => t.approvals.decide(row.id, { approve: false, decidedBy: 'admin', via: 'portal' })).toThrow(
      /already approved/,
    );
  });
});

describe('search', () => {
  it('lists reachable operations by default and explains hidden ones on request', async () => {
    const t = await setup();
    const search = (code: string) => searchCode(t.deps, t.rt, t.caller(), code);

    await expect(search(`return (await catalog.find()).map((o) => o.key);`)).resolves.toMatchObject({
      value: ['echo.query'],
    });
    const all = await search(
      `return (await catalog.find({ includeDisabled: true })).map((o) => [o.key, o.classification, o.reason ?? null]);`,
    );
    expect(all).toMatchObject({
      value: [
        ['echo.delete', 'locked', 'group_read_only'],
        ['echo.guided', 'write', 'group_read_only'],
        ['echo.nolit', 'locked', 'group_read_only'],
        ['echo.query', 'read', null],
        ['echo.set', 'write', 'group_read_only'],
      ],
    });
    await expect(search(`return (await catalog.get('echo.set')).needsApproval;`)).resolves.toMatchObject({
      value: true,
    });
    await expect(
      search(`return (await catalog.groups()).map((g) => [g.key, g.level, g.counts]);`),
    ).resolves.toMatchObject({
      value: [['echo', 'read', { read: 1, write: 2, locked: 2, pendingReview: 2 }]],
    });
    await expect(search(`return typeof echo;`)).resolves.toMatchObject({ value: 'undefined' }); // no upstream access from search
    expect(t.db.select().from(auditLog).where(eq(auditLog.kind, 'search')).all()).toHaveLength(5);
  });
});
