import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  applyBulkLevel,
  listGroups,
  mergeGroups,
  previewBulkLevel,
  renameGroup,
  resolveAccess,
  setGroupLevel,
  updateOperation,
} from '../src/catalog/groups.js';
import { applyCatalogSync } from '../src/catalog/sync.js';
import { createRule, updateRule } from '../src/catalog/rules.js';
import { evaluatePreApproval } from '../src/gate/preapproval.js';
import { auditLog, operationGroupAliases, operations, preApprovalRules } from '../src/db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { catalog, op, seedInstance } from './helpers.js';

function setup() {
  const ctx = seedInstance();
  applyCatalogSync(
    ctx.db,
    ctx.instanceId,
    catalog(
      op('app.query'),
      op('app.upgrade'),
      op('app.stop'),
      op('app.delete', { locked: true }),
      op('pool.query'),
      op('pool.dataset.create'),
    ),
  );
  const id = (key: string) => ctx.db.select().from(operations).where(eq(operations.key, key)).get()!.id;
  return { ...ctx, id };
}

describe('setGroupLevel', () => {
  it('requires acknowledging exactly the writes being exposed', () => {
    const { db, instanceId, id } = setup();
    expect(() => setGroupLevel(db, instanceId, 'app', 'write')).toThrow(ConflictError);
    expect(() => setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [id('app.upgrade')] })).toThrow(
      ConflictError,
    );
    try {
      setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [] });
    } catch (err) {
      expect((err as ConflictError).details).toEqual({
        expected: [
          { id: id('app.stop'), key: 'app.stop' },
          { id: id('app.upgrade'), key: 'app.upgrade' },
        ],
      });
    }

    const group = setGroupLevel(db, instanceId, 'app', 'write', {
      acknowledge: [id('app.upgrade'), id('app.stop')],
      actor: { userId: undefined },
    });
    expect(group).toMatchObject({
      level: 'write',
      counts: { read: 1, write: 2, locked: 1, pendingReview: 0, overridden: 0 },
    });
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toEqual({ reachable: true, mode: 'auto', level: 'write' });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
  });

  it('lowers levels without acknowledgement and audits every change', () => {
    const { db, instanceId } = setup();
    setGroupLevel(db, instanceId, 'app', 'none');
    expect(resolveAccess(db, instanceId, 'app.query')).toEqual({ reachable: false, reason: 'level_none' });
    const audit = db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision === 'group_level_changed');
    expect(audit[0]?.detail).toEqual({ group: 'app', from: 'read', to: 'none', acknowledged: [] });
  });

  it('rejects unknown groups and levels', () => {
    const { db, instanceId } = setup();
    expect(() => setGroupLevel(db, instanceId, 'nope', 'read')).toThrow(NotFoundError);
    expect(() => setGroupLevel(db, instanceId, 'app', 'admin')).toThrow(ValidationError);
  });
});

describe('bulk levels', () => {
  it('previews the non-locked writes each group would expose', () => {
    const { db, instanceId, id } = setup();
    const preview = previewBulkLevel(db, instanceId, 'write');
    expect(preview.groups.map((g) => [g.key, g.exposes.map((o) => o.key)])).toEqual([
      ['app', ['app.stop', 'app.upgrade']],
      ['pool', []],
      ['pool.dataset', ['pool.dataset.create']],
    ]);
    expect(new Set(preview.acknowledge)).toEqual(
      new Set([id('app.stop'), id('app.upgrade'), id('pool.dataset.create')]),
    );
  });

  it('requires the typed slug and a fresh preview for all → write, and leaves locked ops off', () => {
    const { db, instanceId } = setup();
    const { acknowledge } = previewBulkLevel(db, instanceId, 'write');
    expect(() => applyBulkLevel(db, instanceId, 'write', { acknowledge })).toThrow(/Type the endpoint slug/);
    expect(() => applyBulkLevel(db, instanceId, 'write', { confirm: 'wrong', acknowledge })).toThrow(ConflictError);

    // A sync that adds a write between preview and confirm invalidates the preview.
    applyCatalogSync(
      db,
      instanceId,
      catalog(
        op('app.query'),
        op('app.upgrade'),
        op('app.stop'),
        op('app.delete', { locked: true }),
        op('pool.query'),
        op('pool.dataset.create'),
        op('pool.export'),
      ),
    );
    expect(() => applyBulkLevel(db, instanceId, 'write', { confirm: 'truenas', acknowledge })).toThrow(
      /changed; review it again/,
    );

    const fresh = previewBulkLevel(db, instanceId, 'write');
    applyBulkLevel(db, instanceId, 'write', { confirm: 'truenas', acknowledge: fresh.acknowledge });
    expect(listGroups(db, instanceId).every((g) => g.level === 'write')).toBe(true);
    expect(resolveAccess(db, instanceId, 'pool.export')).toMatchObject({ reachable: true, mode: 'auto' });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
    const event = db
      .select()
      .from(auditLog)
      .all()
      .find((a) => a.decision === 'group_level_bulk_changed');
    expect(event?.detail).toMatchObject({ to: 'write', groups: [{ key: 'app', from: 'read', to: 'write' }, {}, {}] });
  });

  it('applies all → none / read / ask without confirmation', () => {
    const { db, instanceId } = setup();
    for (const level of ['none', 'read', 'ask'] as const) {
      applyBulkLevel(db, instanceId, level);
      expect(listGroups(db, instanceId).every((g) => g.level === level)).toBe(true);
    }
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toEqual({ reachable: true, mode: 'approve', level: 'ask' });
  });
});

describe('updateOperation', () => {
  it('gives an operation its own level, which wins over its group and survives group changes', () => {
    const { db, instanceId, id } = setup();
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [id('app.upgrade'), id('app.stop')] });
    updateOperation(db, instanceId, id('app.stop'), { level: 'none' });
    expect(resolveAccess(db, instanceId, 'app.stop')).toEqual({ reachable: false, reason: 'level_none' });
    // Overridden operations are not part of what a group change to Write exposes.
    expect(previewBulkLevel(db, instanceId, 'write').groups[0]?.exposes.map((o) => o.key)).toEqual(['app.upgrade']);

    setGroupLevel(db, instanceId, 'app', 'ask');
    expect(resolveAccess(db, instanceId, 'app.stop')).toEqual({ reachable: false, reason: 'level_none' });
    expect(listGroups(db, instanceId).find((g) => g.key === 'app')?.counts.overridden).toBe(1);

    // Upward too: one write can run without asking while the rest of its group asks.
    updateOperation(db, instanceId, id('app.stop'), { level: 'write' });
    expect(resolveAccess(db, instanceId, 'app.stop')).toEqual({ reachable: true, mode: 'auto', level: 'write' });
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toMatchObject({ mode: 'approve', level: 'ask' });

    updateOperation(db, instanceId, id('app.stop'), { level: null });
    expect(resolveAccess(db, instanceId, 'app.stop')).toMatchObject({ mode: 'approve', level: 'ask' });
  });

  it('opens a locked operation only with its own Ask, and never lets it auto-run', () => {
    const { db, instanceId, id } = setup();
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [id('app.upgrade'), id('app.stop')] });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
    expect(() => updateOperation(db, instanceId, id('app.delete'), { level: 'write' })).toThrow(ConflictError);
    updateOperation(db, instanceId, id('app.delete'), { level: 'ask' });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: true, mode: 'approve', level: 'ask' });
    setGroupLevel(db, instanceId, 'app', 'read');
    expect(resolveAccess(db, instanceId, 'app.delete')).toMatchObject({ reachable: true, mode: 'approve' });
  });

  it('refuses classification changes on locked ops, unknown ops and unknown levels', () => {
    const { db, instanceId, id } = setup();
    expect(() => updateOperation(db, instanceId, id('app.delete'), { classification: 'read' })).toThrow(/locked/);
    expect(() => updateOperation(db, instanceId, 'nope', { level: 'none' })).toThrow(NotFoundError);
    expect(() => updateOperation(db, instanceId, id('app.stop'), { level: 'admin' as 'none' })).toThrow(
      ValidationError,
    );
  });

  it('treats an override to write, or its own Write level, as acknowledgement', () => {
    const { db, instanceId, id } = setup();
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [id('app.upgrade'), id('app.stop')] });
    updateOperation(db, instanceId, id('app.query'), { classification: 'write' });
    expect(resolveAccess(db, instanceId, 'app.query')).toMatchObject({ reachable: true, mode: 'auto' });

    updateOperation(db, instanceId, id('pool.dataset.create'), { level: 'write' });
    expect(resolveAccess(db, instanceId, 'pool.dataset.create')).toMatchObject({ mode: 'auto' });
  });

  it('makes writes found by a later sync ask at Write until acknowledged', () => {
    const { db, instanceId, id } = setup();
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [id('app.upgrade'), id('app.stop')] });
    applyCatalogSync(
      db,
      instanceId,
      catalog(
        op('app.query'),
        op('app.upgrade'),
        op('app.stop'),
        op('app.delete', { locked: true }),
        op('app.redeploy'),
        op('pool.query'),
        op('pool.dataset.create'),
      ),
    );
    expect(resolveAccess(db, instanceId, 'app.redeploy')).toEqual({
      reachable: true,
      mode: 'approve',
      level: 'write',
      pendingReview: true,
    });
    expect(listGroups(db, instanceId).find((g) => g.key === 'app')?.counts.pendingReview).toBe(1);
    updateOperation(db, instanceId, id('app.redeploy'), { acknowledged: true });
    expect(resolveAccess(db, instanceId, 'app.redeploy')).toMatchObject({ mode: 'auto' });
  });
});

describe('re-sync of changed operations (review M14)', () => {
  const profiles = { byName: [{ field: '/name', label: 'Name', widget: 'text' as const, op: 'eq' as const }] };
  const all = (extra: Parameters<typeof op>[1] = {}, drop = false) =>
    catalog(
      op('app.query'),
      op('app.upgrade', { matchProfile: 'byName', paramsSchema: { type: 'object' }, ...extra }),
      op('app.stop'),
      op('app.delete', { locked: true }),
      op('pool.query'),
      ...(drop ? [] : [op('pool.dataset.create')]),
    );

  it('asks again when an acknowledged write changes or returns from stale, not on a plain re-sync', () => {
    const { db, instanceId, id } = setup();
    applyCatalogSync(db, instanceId, all());
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [id('app.upgrade'), id('app.stop')] });
    setGroupLevel(db, instanceId, 'pool.dataset', 'write', { acknowledge: [id('pool.dataset.create')] });

    expect(applyCatalogSync(db, instanceId, all()).pendingReview).toEqual([]);
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toMatchObject({ mode: 'auto' });

    const changed = applyCatalogSync(db, instanceId, all({ paramsSchema: { type: 'object', required: ['force'] } }));
    expect(changed.pendingReview).toEqual(['app.upgrade']);
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toMatchObject({ mode: 'approve', pendingReview: true });
    expect(resolveAccess(db, instanceId, 'app.stop')).toMatchObject({ mode: 'auto' });

    updateOperation(db, instanceId, id('app.upgrade'), { acknowledged: true });
    expect(applyCatalogSync(db, instanceId, all({ kind: 'endpoint' })).pendingReview).toEqual(['app.upgrade']);

    applyCatalogSync(db, instanceId, all({ kind: 'endpoint' }, true));
    const back = applyCatalogSync(db, instanceId, all({ kind: 'endpoint' }));
    expect(back.pendingReview).toContain('pool.dataset.create');
    expect(resolveAccess(db, instanceId, 'pool.dataset.create')).toMatchObject({
      mode: 'approve',
      pendingReview: true,
    });
  });

  it('lets an admin turn the attestation requirement off, and remembers it across syncs (review L13)', () => {
    const { db, instanceId, id } = setup();
    const guided = () => catalog(op('app.query'), op('app.upgrade', { attestationRequired: true }));
    applyCatalogSync(db, instanceId, guided());
    const row = () => db.select().from(operations).where(eq(operations.key, 'app.upgrade')).get()!;
    expect(row().attestationRequired).toBe(true);

    updateOperation(db, instanceId, id('app.upgrade'), { attestationRequired: false }, { actor: { userId: 'u1' } });
    applyCatalogSync(db, instanceId, guided());
    expect(row().attestationRequired).toBe(false);
    const audit = db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision === 'operation_updated')
      .at(-1);
    expect(audit).toMatchObject({ actorId: 'u1', detail: { after: { attestationRequired: false } } });

    updateOperation(db, instanceId, id('app.upgrade'), { attestationRequired: true });
    applyCatalogSync(db, instanceId, guided());
    expect(row().attestationRequired).toBe(true);
  });

  it('always requires typed confirmation on locked operations (review M15)', () => {
    const { db, instanceId } = setup();
    applyCatalogSync(
      db,
      instanceId,
      catalog(op('app.delete', { locked: true, typedConfirmation: false }), op('app.stop')),
    );
    const row = (key: string) => db.select().from(operations).where(eq(operations.key, key)).get()!;
    expect(row('app.delete').typedConfirmation).toBe(true);
    expect(row('app.stop').typedConfirmation).toBe(false);
  });

  it('disables rules whose match no longer fits the operation, and audits it', () => {
    const { db, instanceId, id } = setup();
    applyCatalogSync(db, instanceId, all(), new Date(), { matchProfiles: profiles });
    const manifest = { matchProfiles: profiles } as never;
    const fits = createRule(db, manifest, instanceId, {
      operationId: id('app.upgrade'),
      match: [{ field: '/name', op: 'eq', value: 'web' }],
      reason: 'routine upgrades',
    });
    const anyOnly = createRule(db, manifest, instanceId, {
      operationId: id('app.upgrade'),
      match: [{ field: '', op: 'any' }],
      reason: 'any upgrade',
    });

    // Same profile: nothing changes.
    expect(applyCatalogSync(db, instanceId, all(), new Date(), { matchProfiles: profiles }).rulesDisabled).toBe(0);

    // The plugin dropped the profile: the field-based rule is disabled, the "any" rule still fits.
    const summary = applyCatalogSync(db, instanceId, all({ matchProfile: undefined }), new Date(), {
      matchProfiles: profiles,
    });
    expect(summary.rulesDisabled).toBe(1);
    const enabled = (ruleId: string) =>
      db.select().from(preApprovalRules).where(eq(preApprovalRules.id, ruleId)).get()!.enabled;
    expect(enabled(fits.id)).toBe(false);
    expect(enabled(anyOnly.id)).toBe(true);
    const audit = db
      .select()
      .from(auditLog)
      .all()
      .find((a) => a.decision === 'rules_disabled_operation_changed');
    expect(audit?.detail).toMatchObject({ rules: [{ ruleId: fits.id, operationKey: 'app.upgrade' }] });
  });
});

describe('rules on $targets (design §3.4)', () => {
  const profiles = {
    targets: [
      { field: '$targets', label: 'Targets', widget: 'registry-picker' as const, covers: '/selector' },
      { field: '/level', label: 'Level', widget: 'range' as const, op: 'range' as const },
    ],
  };
  const manifest = { matchProfiles: profiles } as never;
  const target = (id: string, area: string) => ({ kind: 'entity', id, name: id, scopes: { area, domain: 'widget' } });
  const inZoneA = [target('widget.one', 'zone-a')];

  function withRules() {
    const ctx = setup();
    applyCatalogSync(
      ctx.db,
      ctx.instanceId,
      catalog(op('app.upgrade', { matchProfile: 'targets' }), op('app.stop', { matchProfile: 'targets' })),
      new Date(),
      { matchProfiles: profiles },
    );
    const areaRule = createRule(ctx.db, manifest, ctx.instanceId, {
      operationId: ctx.id('app.upgrade'),
      match: [{ field: '$targets', areas: ['zone-a'] }],
      reason: 'widgets in zone A',
    });
    const anyTarget = createRule(ctx.db, manifest, ctx.instanceId, {
      operationId: ctx.id('app.stop'),
      match: [
        { field: '/selector', op: 'any' },
        { field: '/level', op: 'range', value: { max: 50 } },
      ],
      reason: 'low level on anything',
    });
    const evaluate = (key: string, params: unknown, targets: ReturnType<typeof target>[], targetCovers?: string) =>
      evaluatePreApproval(ctx.db, {
        instanceId: ctx.instanceId,
        operationId: ctx.id(key),
        params,
        targets,
        targetCovers,
      });
    return { ...ctx, areaRule, anyTarget, evaluate };
  }

  it('stores a rule exactly as written, with no hidden conditions', () => {
    const { areaRule, anyTarget, db, instanceId } = withRules();
    expect(areaRule.match).toEqual([{ field: '$targets', areas: ['zone-a'] }]);
    // An explicit "any target" without a $targets condition is the admin's choice, and is kept.
    expect(anyTarget.match).toEqual([
      { field: '/selector', op: 'any' },
      { field: '/level', op: 'range', value: { max: 50 } },
    ]);
    const updated = updateRule(db, manifest, instanceId, areaRule.id, {
      match: [{ field: '$targets', areas: ['zone-b'] }],
    });
    expect(updated.match).toEqual([{ field: '$targets', areas: ['zone-b'] }]);
  });

  it('lets a $targets condition cover the raw selector at match time, never widening the target check', () => {
    const { evaluate } = withRules();
    const params = { selector: { zone: ['zone-a'] } };
    expect(evaluate('app.upgrade', params, inZoneA, '/selector')).toMatchObject({ kind: 'auto_approved' });
    // Without the profile's covers pointer, the raw selector is an uncovered param under strict matching.
    expect(evaluate('app.upgrade', params, inZoneA)).toEqual({ kind: 'no_match' });
    // One target outside the area still asks.
    expect(evaluate('app.upgrade', params, [...inZoneA, target('widget.two', 'zone-b')], '/selector')).toEqual({
      kind: 'no_match',
    });
    // Other params still need their own condition.
    expect(evaluate('app.upgrade', { ...params, level: 10 }, inZoneA, '/selector')).toEqual({ kind: 'no_match' });
  });

  it('applies an explicit "any target" rule on its own terms', () => {
    const { evaluate } = withRules();
    expect(
      evaluate(
        'app.stop',
        { selector: { zone: ['zone-b'] }, level: 40 },
        [target('widget.two', 'zone-b')],
        '/selector',
      ),
    ).toMatchObject({ kind: 'auto_approved' });
    expect(
      evaluate(
        'app.stop',
        { selector: { zone: ['zone-b'] }, level: 90 },
        [target('widget.two', 'zone-b')],
        '/selector',
      ),
    ).toEqual({ kind: 'no_match' });
  });
});

describe('regrouping', () => {
  it('merges into the lowest level, keeps aliases, and survives re-sync', () => {
    const { db, instanceId, id } = setup();
    setGroupLevel(db, instanceId, 'pool', 'none');
    setGroupLevel(db, instanceId, 'pool.dataset', 'write', { acknowledge: [id('pool.dataset.create')] });

    const merged = mergeGroups(db, instanceId, { from: ['pool.dataset'], into: 'pool', label: 'Storage' });
    expect(merged).toMatchObject({ key: 'pool', label: 'Storage', level: 'none' });
    expect(db.select().from(operationGroupAliases).all()).toEqual([
      { instanceId, pluginGroup: 'pool.dataset', groupKey: 'pool' },
    ]);
    expect(listGroups(db, instanceId).map((g) => g.key)).toEqual(['app', 'pool']);
  });

  it('merges into a brand-new group and repoints existing aliases', () => {
    const { db, instanceId } = setup();
    mergeGroups(db, instanceId, { from: ['pool.dataset'], into: 'pool' });
    mergeGroups(db, instanceId, { from: ['pool'], into: 'storage' });
    expect(
      new Set(
        db
          .select()
          .from(operationGroupAliases)
          .all()
          .map((a) => `${a.pluginGroup}->${a.groupKey}`),
      ),
    ).toEqual(new Set(['pool.dataset->storage', 'pool->storage']));
    applyCatalogSync(db, instanceId, catalog(op('pool.query'), op('pool.dataset.create'), op('app.query')));
    expect(listGroups(db, instanceId).map((g) => g.key)).toEqual(['app', 'storage']);
  });

  it('validates merge input and renames labels', () => {
    const { db, instanceId } = setup();
    expect(() => mergeGroups(db, instanceId, { from: ['app'], into: 'app' })).toThrow(ValidationError);
    expect(() => mergeGroups(db, instanceId, { from: ['app'], into: 'Bad Key' })).toThrow(ValidationError);
    renameGroup(db, instanceId, 'app', 'Apps');
    expect(listGroups(db, instanceId).find((g) => g.key === 'app')?.label).toBe('Apps');
    expect(() => renameGroup(db, instanceId, 'app', '  ')).toThrow(ValidationError);
  });
});
