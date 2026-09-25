import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import type { Db, DbLike } from '../db/index.js';
import { operationGroupAliases, operationGroups, operations, pluginInstances } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { ACCESS_LEVELS, effectiveAccess } from '../gate/access.js';
import type { AccessDecision, AccessLevel } from '../gate/access.js';

/**
 * Group-level access management (design §5.2.1). All mutations are audited `config` events.
 * Levels only change through these functions; nothing here is reachable from sandboxed code.
 */

type GroupRow = typeof operationGroups.$inferSelect;
type OperationRow = typeof operations.$inferSelect;

export interface Actor {
  userId?: string;
}

const LEVEL_RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };
const lowerLevel = (a: AccessLevel, b: AccessLevel) => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b);

function assertLevel(level: string): asserts level is AccessLevel {
  if (!(ACCESS_LEVELS as readonly string[]).includes(level)) {
    throw new ValidationError('invalid_level', `Level must be one of ${ACCESS_LEVELS.join(', ')}`);
  }
}

const accessInput = (op: OperationRow) => ({
  classification: op.classification,
  locked: op.locked,
  excluded: op.excluded,
  lockedOptIn: op.lockedOptIn,
  writeAcknowledged: op.writeAcknowledged,
});

/** Writes a move to `write` would expose that nobody has acknowledged yet (locked ops excluded: they need opt-in). */
function isPendingWrite(op: OperationRow): boolean {
  return !op.stale && !op.excluded && !op.locked && op.classification === 'write' && !op.writeAcknowledged;
}

const sameSet = (a: readonly string[] = [], b: readonly string[]) =>
  a.length === b.length && new Set(a).size === b.length && b.every((x) => a.includes(x));

function getGroup(db: DbLike, instanceId: string, key: string): GroupRow {
  const group = db
    .select()
    .from(operationGroups)
    .where(and(eq(operationGroups.instanceId, instanceId), eq(operationGroups.key, key)))
    .get();
  if (!group) throw new NotFoundError('group_not_found', `No group "${key}" on this instance`);
  return group;
}

function opsInGroups(db: DbLike, groupIds: string[]): OperationRow[] {
  if (groupIds.length === 0) return [];
  return db.select().from(operations).where(inArray(operations.groupId, groupIds)).orderBy(asc(operations.key)).all();
}

function acknowledge(db: DbLike, opIds: string[], actor: Actor, now: Date) {
  if (opIds.length === 0) return;
  db.update(operations)
    .set({ writeAcknowledged: true, acknowledgedAt: now, acknowledgedBy: actor.userId ?? null })
    .where(inArray(operations.id, opIds))
    .run();
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────────

export interface GroupSummary {
  key: string;
  label: string;
  level: AccessLevel;
  stale: boolean;
  counts: { read: number; write: number; locked: number; pendingReview: number };
}

export function listGroups(db: DbLike, instanceId: string): GroupSummary[] {
  const groups = db
    .select()
    .from(operationGroups)
    .where(eq(operationGroups.instanceId, instanceId))
    .orderBy(asc(operationGroups.key))
    .all();
  const ops = opsInGroups(
    db,
    groups.map((g) => g.id),
  ).filter((o) => !o.stale);
  return groups.map((g) => {
    const mine = ops.filter((o) => o.groupId === g.id);
    return {
      key: g.key,
      label: g.label,
      level: g.level,
      stale: g.stale,
      counts: {
        read: mine.filter((o) => !o.locked && o.classification === 'read').length,
        write: mine.filter((o) => !o.locked && o.classification === 'write').length,
        locked: mine.filter((o) => o.locked).length,
        pendingReview: mine.filter(isPendingWrite).length,
      },
    };
  });
}

/** Access decision for one operation key; unknown or stale operations are unreachable. */
export function resolveAccess(
  db: DbLike,
  instanceId: string,
  key: string,
): AccessDecision | { reachable: false; reason: 'unknown_operation' } {
  const op = db
    .select()
    .from(operations)
    .where(and(eq(operations.instanceId, instanceId), eq(operations.key, key)))
    .get();
  if (!op || op.stale) return { reachable: false, reason: 'unknown_operation' };
  const group = db.select().from(operationGroups).where(eq(operationGroups.id, op.groupId)).get();
  return effectiveAccess(accessInput(op), group);
}

// ── group level ──────────────────────────────────────────────────────────────────────────────────

/**
 * Sets one group's level. Raising to `write` must carry `acknowledge` = exactly the pending writes
 * the admin was shown; if a sync changed that list in between, this fails with 409 and the fresh list.
 */
export function setGroupLevel(
  db: Db,
  instanceId: string,
  key: string,
  level: string,
  opts: { acknowledge?: string[]; actor?: Actor; now?: Date } = {},
): GroupSummary {
  assertLevel(level);
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? {};
  db.transaction((tx) => {
    const group = getGroup(tx, instanceId, key);
    let acknowledged: string[] = [];
    if (level === 'write') {
      const pending = opsInGroups(tx, [group.id]).filter(isPendingWrite);
      const expected = pending.map((o) => o.id);
      if (!sameSet(opts.acknowledge, expected)) {
        throw new ConflictError('acknowledgement_mismatch', 'Acknowledge exactly the writes this change exposes', {
          expected: pending.map((o) => ({ id: o.id, key: o.key })),
        });
      }
      acknowledge(tx, expected, actor, now);
      acknowledged = pending.map((o) => o.key);
    }
    if (group.level === level && acknowledged.length === 0) return;
    tx.update(operationGroups)
      .set({ level, levelChangedAt: now, levelChangedBy: actor.userId ?? null })
      .where(eq(operationGroups.id, group.id))
      .run();
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        decision: 'group_level_changed',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { group: key, from: group.level, to: level, acknowledged },
      },
      now,
    );
  });
  return listGroups(db, instanceId).find((g) => g.key === key)!;
}

export interface BulkPreview {
  level: AccessLevel;
  groups: { key: string; label: string; from: AccessLevel; exposes: { id: string; key: string }[] }[];
  /** Pass back unchanged as `acknowledge` when applying a bulk `write`. */
  acknowledge: string[];
}

export function previewBulkLevel(db: DbLike, instanceId: string, level: string): BulkPreview {
  assertLevel(level);
  const groups = db
    .select()
    .from(operationGroups)
    .where(eq(operationGroups.instanceId, instanceId))
    .orderBy(asc(operationGroups.key))
    .all();
  const pending =
    level === 'write'
      ? opsInGroups(
          db,
          groups.map((g) => g.id),
        ).filter(isPendingWrite)
      : [];
  const preview = groups.map((g) => ({
    key: g.key,
    label: g.label,
    from: g.level,
    exposes: pending.filter((o) => o.groupId === g.id).map((o) => ({ id: o.id, key: o.key })),
  }));
  return { level, groups: preview, acknowledge: pending.map((o) => o.id) };
}

/**
 * Sets every group of an instance to one level. `none`/`read` only reduce access and apply directly.
 * `write` requires `confirm` = the instance slug and `acknowledge` = the current preview's list.
 * Locked operations are never exposed by this; they keep needing a per-operation opt-in.
 */
export function applyBulkLevel(
  db: Db,
  instanceId: string,
  level: string,
  opts: { confirm?: string; acknowledge?: string[]; actor?: Actor; now?: Date } = {},
): BulkPreview['groups'] {
  assertLevel(level);
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? {};
  return db.transaction((tx) => {
    const instance = tx.select().from(pluginInstances).where(eq(pluginInstances.id, instanceId)).get();
    if (!instance) throw new NotFoundError('instance_not_found', 'No such instance');
    const preview = previewBulkLevel(tx, instanceId, level);
    if (level === 'write') {
      if (opts.confirm !== instance.slug) {
        throw new ConflictError('confirmation_required', `Type the endpoint slug "${instance.slug}" to confirm`);
      }
      if (!sameSet(opts.acknowledge, preview.acknowledge)) {
        throw new ConflictError('acknowledgement_mismatch', 'The list of exposed writes changed; review it again', {
          preview,
        });
      }
      acknowledge(tx, preview.acknowledge, actor, now);
    }
    tx.update(operationGroups)
      .set({ level, levelChangedAt: now, levelChangedBy: actor.userId ?? null })
      .where(eq(operationGroups.instanceId, instanceId))
      .run();
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        decision: 'group_level_bulk_changed',
        actorKind: 'user',
        actorId: actor.userId,
        detail: {
          to: level,
          groups: preview.groups.map((g) => ({ key: g.key, from: g.from, to: level })),
          acknowledged: preview.groups.flatMap((g) => g.exposes.map((o) => o.key)),
        },
      },
      now,
    );
    return preview.groups;
  });
}

// ── regrouping ───────────────────────────────────────────────────────────────────────────────────

export function renameGroup(db: Db, instanceId: string, key: string, label: string, opts: { actor?: Actor } = {}) {
  const trimmed = label.trim();
  if (!trimmed) throw new ValidationError('invalid_label', 'Label must not be empty');
  db.transaction((tx) => {
    const group = getGroup(tx, instanceId, key);
    tx.update(operationGroups).set({ label: trimmed }).where(eq(operationGroups.id, group.id)).run();
    writeAudit(tx, {
      kind: 'config',
      instanceId,
      decision: 'group_renamed',
      actorKind: 'user',
      actorId: opts.actor?.userId,
      detail: { group: key, from: group.label, to: trimmed },
    });
  });
}

/**
 * Merges groups into `into` (created if new). Stored as aliases so future syncs keep the grouping.
 * The merged group takes the lowest level involved, so merging never widens access.
 */
export function mergeGroups(
  db: Db,
  instanceId: string,
  input: { from: string[]; into: string; label?: string },
  opts: { actor?: Actor; now?: Date } = {},
): GroupSummary {
  const now = opts.now ?? new Date();
  const into = input.into.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(into)) throw new ValidationError('invalid_group_key', 'Invalid group key');
  const fromKeys = [...new Set(input.from)].filter((k) => k !== into);
  if (fromKeys.length === 0) throw new ValidationError('nothing_to_merge', 'Pick at least one other group to merge');

  db.transaction((tx) => {
    const sources = fromKeys.map((k) => getGroup(tx, instanceId, k));
    let target = tx
      .select()
      .from(operationGroups)
      .where(and(eq(operationGroups.instanceId, instanceId), eq(operationGroups.key, into)))
      .get();
    const level = [...sources, ...(target ? [target] : [])].map((g) => g.level).reduce(lowerLevel);
    if (!target) {
      target = {
        id: randomUUID(),
        instanceId,
        key: into,
        label: input.label?.trim() || into,
        level,
        levelChangedAt: now,
        levelChangedBy: opts.actor?.userId ?? null,
        firstSeenAt: now,
        stale: false,
      };
      tx.insert(operationGroups).values(target).run();
    } else {
      tx.update(operationGroups)
        .set({
          level,
          stale: false,
          ...(input.label?.trim() ? { label: input.label.trim() } : {}),
          ...(level !== target.level ? { levelChangedAt: now, levelChangedBy: opts.actor?.userId ?? null } : {}),
        })
        .where(eq(operationGroups.id, target.id))
        .run();
    }

    const sourceIds = sources.map((g) => g.id);
    const pluginGroups = new Set(opsInGroups(tx, sourceIds).map((o) => o.pluginGroup));
    // Aliases that pointed at a merged group now point at the target.
    for (const a of tx
      .select()
      .from(operationGroupAliases)
      .where(and(eq(operationGroupAliases.instanceId, instanceId), inArray(operationGroupAliases.groupKey, fromKeys)))
      .all()) {
      pluginGroups.add(a.pluginGroup);
    }
    for (const k of fromKeys) pluginGroups.add(k);
    for (const pluginGroup of pluginGroups) {
      tx.insert(operationGroupAliases)
        .values({ instanceId, pluginGroup, groupKey: into })
        .onConflictDoUpdate({
          target: [operationGroupAliases.instanceId, operationGroupAliases.pluginGroup],
          set: { groupKey: into },
        })
        .run();
    }
    tx.update(operations).set({ groupId: target.id }).where(inArray(operations.groupId, sourceIds)).run();
    tx.delete(operationGroups).where(inArray(operationGroups.id, sourceIds)).run();
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        decision: 'groups_merged',
        actorKind: 'user',
        actorId: opts.actor?.userId,
        detail: { from: sources.map((g) => ({ key: g.key, level: g.level })), into, level },
      },
      now,
    );
  });
  return listGroups(db, instanceId).find((g) => g.key === into)!;
}

// ── per-operation state ──────────────────────────────────────────────────────────────────────────

export interface OperationPatch {
  excluded?: boolean;
  lockedOptIn?: boolean;
  acknowledged?: boolean;
  classification?: 'read' | 'write';
}

/**
 * Exclude-only overrides plus locked opt-in, acknowledgement and classification override.
 * Locked classification is immutable (409). Opting in, or overriding to write, acknowledges the op.
 */
export function updateOperation(
  db: Db,
  instanceId: string,
  opId: string,
  patch: OperationPatch,
  opts: { actor?: Actor; now?: Date } = {},
): void {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? {};
  db.transaction((tx) => {
    const op = tx
      .select()
      .from(operations)
      .where(and(eq(operations.id, opId), eq(operations.instanceId, instanceId)))
      .get();
    if (!op) throw new NotFoundError('operation_not_found', 'No such operation on this instance');

    const set: Partial<typeof operations.$inferInsert> = {};
    if (patch.classification !== undefined && patch.classification !== op.classification) {
      if (op.locked)
        throw new ConflictError('operation_locked', `${op.key} is locked; its classification can't change`);
      set.classification = patch.classification;
      set.classificationSource = 'override';
    }
    if (patch.excluded !== undefined) set.excluded = patch.excluded;
    if (patch.lockedOptIn !== undefined) {
      if (!op.locked)
        throw new ValidationError('not_locked', `${op.key} is not locked; opt-in only applies to locked operations`);
      set.lockedOptIn = patch.lockedOptIn;
    }
    const acknowledges = patch.acknowledged === true || patch.lockedOptIn === true || set.classification === 'write';
    if (acknowledges && !op.writeAcknowledged) {
      Object.assign(set, { writeAcknowledged: true, acknowledgedAt: now, acknowledgedBy: actor.userId ?? null });
    }
    if (patch.acknowledged === false) {
      Object.assign(set, { writeAcknowledged: false, acknowledgedAt: null, acknowledgedBy: null });
    }
    if (Object.keys(set).length === 0) return;

    tx.update(operations).set(set).where(eq(operations.id, op.id)).run();
    writeAudit(
      tx,
      {
        kind: 'config',
        instanceId,
        operationKey: op.key,
        decision: 'operation_updated',
        actorKind: 'user',
        actorId: actor.userId,
        detail: {
          before: {
            excluded: op.excluded,
            lockedOptIn: op.lockedOptIn,
            writeAcknowledged: op.writeAcknowledged,
            classification: op.classification,
          },
          after: set,
        },
      },
      now,
    );
  });
}
