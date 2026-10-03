import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { applyCatalogSync } from '../src/catalog/sync.js';
import { listGroups, mergeGroups, resolveAccess, setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { auditLog, operationGroups, operations, pluginInstances, preApprovalRules } from '../src/db/schema.js';
import { catalog, op, seedInstance } from './helpers.js';

const opRow = (db: ReturnType<typeof seedInstance>['db'], key: string) =>
  db.select().from(operations).where(eq(operations.key, key)).get()!;

describe('applyCatalogSync', () => {
  it('creates groups at ask, classifies, and quarantines new writes', () => {
    const { db, instanceId } = seedInstance();
    const summary = applyCatalogSync(
      db,
      instanceId,
      catalog(op('app.query'), op('app.upgrade'), op('app.delete', { locked: true }), op('store.query')),
    );

    expect(summary).toMatchObject({
      added: 4,
      newGroups: ['app', 'store'],
      pendingReview: ['app.upgrade', 'app.delete'],
    });
    expect(listGroups(db, instanceId).map((g) => [g.key, g.level])).toEqual([
      ['app', 'ask'],
      ['store', 'ask'],
    ]);
    // Operations in a brand-new group follow it.
    expect(opRow(db, 'app.upgrade').levelOverride).toBeNull();
    expect(opRow(db, 'app.delete')).toMatchObject({
      classification: 'write',
      classificationSource: 'locked',
      typedConfirmation: true,
    });
    expect(resolveAccess(db, instanceId, 'app.query')).toEqual({ reachable: true, mode: 'run', level: 'read' });
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toEqual({ reachable: true, mode: 'approve', level: 'ask' });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });

    const instance = db.select().from(pluginInstances).where(eq(pluginInstances.id, instanceId)).get();
    expect(instance).toMatchObject({ upstreamVersion: '25.10.7', lastSyncStatus: 'ok' });
    expect(
      db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.decision),
    ).toEqual(['catalog_synced']);
  });

  it('adds a new write to an open group switched off, as its own level, until an admin opens it', () => {
    const { db, instanceId } = seedInstance();
    applyCatalogSync(db, instanceId, catalog(op('app.query'), op('app.upgrade')));
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [opRow(db, 'app.upgrade').id] });
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toEqual({ reachable: true, mode: 'auto', level: 'write' });

    const summary = applyCatalogSync(db, instanceId, catalog(op('app.query'), op('app.upgrade'), op('app.rollback')));
    expect(summary.pendingReview).toEqual(['app.rollback']);
    expect(opRow(db, 'app.rollback').levelOverride).toBe('none');
    expect(resolveAccess(db, instanceId, 'app.rollback')).toEqual({ reachable: false, reason: 'level_none' });
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toEqual({ reachable: true, mode: 'auto', level: 'write' });
    expect(listGroups(db, instanceId)[0]?.counts).toMatchObject({ overridden: 1, pendingReview: 0 });

    // Opening it at Write is the admin's acknowledgement.
    updateOperation(db, instanceId, opRow(db, 'app.rollback').id, { level: 'write' });
    expect(resolveAccess(db, instanceId, 'app.rollback')).toEqual({ reachable: true, mode: 'auto', level: 'write' });
  });

  it('lets a new operation in a group at None follow the group', () => {
    const { db, instanceId } = seedInstance();
    applyCatalogSync(db, instanceId, catalog(op('app.query')));
    setGroupLevel(db, instanceId, 'app', 'none');
    applyCatalogSync(db, instanceId, catalog(op('app.query'), op('app.config'), op('app.upgrade')));
    expect(opRow(db, 'app.config').levelOverride).toBeNull();
    expect(opRow(db, 'app.upgrade').levelOverride).toBeNull();
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toEqual({ reachable: false, reason: 'level_none' });
  });

  it('makes new reads reachable immediately, at their own Read', () => {
    const { db, instanceId } = seedInstance();
    applyCatalogSync(db, instanceId, catalog(op('app.query')));
    applyCatalogSync(db, instanceId, catalog(op('app.query'), op('app.config')));
    expect(opRow(db, 'app.config').levelOverride).toBe('read');
    expect(resolveAccess(db, instanceId, 'app.config')).toEqual({ reachable: true, mode: 'run', level: 'read' });
  });

  it('resets acknowledgement when a read is reclassified as a write', () => {
    const { db, instanceId } = seedInstance();
    applyCatalogSync(db, instanceId, catalog(op('app.status', { classification: 'read' }), op('app.upgrade')));
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [opRow(db, 'app.upgrade').id] });
    updateOperation(db, instanceId, opRow(db, 'app.status').id, { acknowledged: true });

    const summary = applyCatalogSync(
      db,
      instanceId,
      catalog(op('app.status', { classification: 'write' }), op('app.upgrade')),
    );
    expect(summary.pendingReview).toEqual(['app.status']);
    expect(resolveAccess(db, instanceId, 'app.status')).toEqual({
      reachable: true,
      mode: 'approve',
      level: 'write',
      pendingReview: true,
    });
  });

  it('always takes read or write from the plugin, narrowing own levels that no longer fit', () => {
    const { db, instanceId } = seedInstance();
    applyCatalogSync(
      db,
      instanceId,
      catalog(op('app.status', { classification: 'read' }), op('app.info', { classification: 'read' })),
    );
    updateOperation(db, instanceId, opRow(db, 'app.status').id, { level: 'read' });
    updateOperation(db, instanceId, opRow(db, 'app.info').id, { level: 'ask' });

    applyCatalogSync(
      db,
      instanceId,
      catalog(op('app.status', { classification: 'write' }), op('app.info', { classification: 'write' })),
    );
    expect(opRow(db, 'app.status')).toMatchObject({
      classification: 'write',
      classificationSource: 'inferred',
      levelOverride: 'none',
    });
    expect(opRow(db, 'app.info')).toMatchObject({ classification: 'write', levelOverride: 'ask' });

    applyCatalogSync(
      db,
      instanceId,
      catalog(op('app.status', { locked: true }), op('app.info', { classification: 'write' })),
    );
    expect(opRow(db, 'app.status')).toMatchObject({ classification: 'write', classificationSource: 'locked' });
  });

  it('disables pre-approval rules on operations that become locked', () => {
    const { db, instanceId } = seedInstance();
    applyCatalogSync(db, instanceId, catalog(op('store.volume.create')));
    db.insert(preApprovalRules)
      .values({ id: randomUUID(), instanceId, operationId: opRow(db, 'store.volume.create').id, reason: 'media' })
      .run();

    const summary = applyCatalogSync(db, instanceId, catalog(op('store.volume.create', { locked: true })));
    expect(summary).toMatchObject({ newlyLocked: ['store.volume.create'], rulesDisabled: 1 });
    expect(db.select().from(preApprovalRules).get()?.enabled).toBe(false);
    expect(
      db
        .select()
        .from(auditLog)
        .all()
        .map((a) => a.decision),
    ).toContain('rules_disabled_operation_locked');
  });

  it('marks missing operations and empty groups stale, and restores them', () => {
    const { db, instanceId } = seedInstance();
    applyCatalogSync(db, instanceId, catalog(op('app.query'), op('vm.query')));
    setGroupLevel(db, instanceId, 'vm', 'none');

    const s1 = applyCatalogSync(db, instanceId, catalog(op('app.query')));
    expect(s1.staled).toBe(1);
    expect(opRow(db, 'vm.query').stale).toBe(true);
    expect(listGroups(db, instanceId).find((g) => g.key === 'vm')).toMatchObject({ stale: true, level: 'none' });
    expect(resolveAccess(db, instanceId, 'vm.query')).toEqual({ reachable: false, reason: 'unknown_operation' });

    const s2 = applyCatalogSync(db, instanceId, catalog(op('app.query'), op('vm.query')));
    expect(s2.restored).toBe(1);
    expect(listGroups(db, instanceId).find((g) => g.key === 'vm')).toMatchObject({ stale: false, level: 'none' });
  });

  it('applies admin group aliases on every sync', () => {
    const { db, instanceId } = seedInstance();
    applyCatalogSync(db, instanceId, catalog(op('app.query'), op('app.image.query')));
    mergeGroups(db, instanceId, { from: ['app.image'], into: 'app' });
    applyCatalogSync(db, instanceId, catalog(op('app.query'), op('app.image.query'), op('app.image.pull')));
    expect(listGroups(db, instanceId).map((g) => g.key)).toEqual(['app']);
    const appGroup = db.select().from(operationGroups).get()!;
    expect(opRow(db, 'app.image.pull').groupId).toBe(appGroup.id);
  });

  it('rejects invalid plugin output without touching the database', () => {
    const { db, instanceId } = seedInstance();
    expect(() => applyCatalogSync(db, instanceId, catalog(op('a.query'), op('a.query')))).toThrow(/Duplicate/);
    expect(() => applyCatalogSync(db, instanceId, { upstreamVersion: 'x', operations: [{ key: 'x' }] })).toThrow();
    expect(db.select().from(operations).all()).toEqual([]);
  });
});
