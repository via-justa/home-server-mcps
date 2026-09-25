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
import { auditLog, operationGroupAliases, operations } from '../src/db/schema.js';
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
    expect(group).toMatchObject({ level: 'write', counts: { read: 1, write: 2, locked: 1, pendingReview: 0 } });
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toEqual({ reachable: true });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
  });

  it('lowers levels without acknowledgement and audits every change', () => {
    const { db, instanceId } = setup();
    setGroupLevel(db, instanceId, 'app', 'none');
    expect(resolveAccess(db, instanceId, 'app.query')).toEqual({ reachable: false, reason: 'group_none' });
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
    expect(resolveAccess(db, instanceId, 'pool.export')).toEqual({ reachable: true });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
    const event = db
      .select()
      .from(auditLog)
      .all()
      .find((a) => a.decision === 'group_level_bulk_changed');
    expect(event?.detail).toMatchObject({ to: 'write', groups: [{ key: 'app', from: 'read', to: 'write' }, {}, {}] });
  });

  it('applies all → read / none without confirmation', () => {
    const { db, instanceId } = setup();
    applyBulkLevel(db, instanceId, 'none');
    expect(listGroups(db, instanceId).every((g) => g.level === 'none')).toBe(true);
    applyBulkLevel(db, instanceId, 'read');
    expect(listGroups(db, instanceId).every((g) => g.level === 'read')).toBe(true);
  });
});

describe('updateOperation', () => {
  it('excludes an operation below its group level', () => {
    const { db, instanceId, id } = setup();
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [id('app.upgrade'), id('app.stop')] });
    updateOperation(db, instanceId, id('app.stop'), { excluded: true });
    expect(resolveAccess(db, instanceId, 'app.stop')).toEqual({ reachable: false, reason: 'excluded' });
    expect(previewBulkLevel(db, instanceId, 'write').groups[0]?.exposes).toEqual([]);
  });

  it('opts in a locked operation (acknowledging it) only while the group is at write', () => {
    const { db, instanceId, id } = setup();
    updateOperation(db, instanceId, id('app.delete'), { lockedOptIn: true });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'group_read_only' });
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [id('app.upgrade'), id('app.stop')] });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: true });
  });

  it('refuses opt-in on non-locked ops and classification changes on locked ops', () => {
    const { db, instanceId, id } = setup();
    expect(() => updateOperation(db, instanceId, id('app.upgrade'), { lockedOptIn: true })).toThrow(ValidationError);
    expect(() => updateOperation(db, instanceId, id('app.delete'), { classification: 'read' })).toThrow(/locked/);
    expect(() => updateOperation(db, instanceId, 'nope', { excluded: true })).toThrow(NotFoundError);
  });

  it('treats an override to write as acknowledgement', () => {
    const { db, instanceId, id } = setup();
    setGroupLevel(db, instanceId, 'app', 'write', { acknowledge: [id('app.upgrade'), id('app.stop')] });
    updateOperation(db, instanceId, id('app.query'), { classification: 'write' });
    expect(resolveAccess(db, instanceId, 'app.query')).toEqual({ reachable: true });
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
