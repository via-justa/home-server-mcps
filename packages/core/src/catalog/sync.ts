import { randomUUID } from 'node:crypto';
import { SyncCatalogResultSchema } from '@home-server-mcps/plugin-sdk';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { operationGroupAliases, operationGroups, operations, pluginInstances, preApprovalRules } from '../db/schema.js';
import { ValidationError } from '../errors.js';

type OperationRow = typeof operations.$inferSelect;

export interface SyncSummary {
  added: number;
  updated: number;
  staled: number;
  restored: number;
  newGroups: string[];
  /** Writes (new, or reclassified read → write) now waiting for acknowledgement. */
  pendingReview: string[];
  /** Operations that became locked in this sync; their pre-approval rules were disabled. */
  newlyLocked: string[];
  rulesDisabled: number;
}

const isEffectiveWrite = (op: Pick<OperationRow, 'classification' | 'locked'>) =>
  op.locked || op.classification === 'write';

/**
 * Applies a plugin's `syncCatalog` result to an instance (design §5.2.1, §10). Plugin output is
 * untrusted and re-validated here. Runs in one transaction: either the whole catalog lands or none.
 *
 * - Operations missing from the result are marked `stale`, never deleted (history is kept).
 * - `locked` always follows the plugin seed; admin overrides survive unless the op becomes locked.
 * - New writes, and reads reclassified to writes, arrive unacknowledged (quarantined).
 * - Plugin groups are mapped through admin aliases; missing groups are created at `read`.
 */
export function applyCatalogSync(db: Db, instanceId: string, rawResult: unknown, now = new Date()): SyncSummary {
  const result = SyncCatalogResultSchema.parse(rawResult);
  const seen = new Set<string>();
  for (const d of result.operations) {
    if (seen.has(d.key)) throw new ValidationError('duplicate_operation', `Duplicate operation key: ${d.key}`);
    seen.add(d.key);
  }

  return db.transaction((tx) => {
    const aliases = new Map(
      tx
        .select()
        .from(operationGroupAliases)
        .where(eq(operationGroupAliases.instanceId, instanceId))
        .all()
        .map((a) => [a.pluginGroup, a.groupKey]),
    );
    const groups = new Map(
      tx
        .select()
        .from(operationGroups)
        .where(eq(operationGroups.instanceId, instanceId))
        .all()
        .map((g) => [g.key, g]),
    );
    const existing = new Map(
      tx
        .select()
        .from(operations)
        .where(eq(operations.instanceId, instanceId))
        .all()
        .map((o) => [o.key, o]),
    );

    const summary: SyncSummary = {
      added: 0,
      updated: 0,
      staled: 0,
      restored: 0,
      newGroups: [],
      pendingReview: [],
      newlyLocked: [],
      rulesDisabled: 0,
    };

    const groupIdFor = (pluginGroup: string, label: string | undefined): string => {
      const key = aliases.get(pluginGroup) ?? pluginGroup;
      const found = groups.get(key);
      if (found) return found.id;
      const row = { id: randomUUID(), instanceId, key, label: label ?? key, level: 'read' as const, firstSeenAt: now };
      tx.insert(operationGroups).values(row).run();
      groups.set(key, { ...row, levelChangedAt: null, levelChangedBy: null, stale: false });
      summary.newGroups.push(key);
      return row.id;
    };

    for (const d of result.operations) {
      const prev = existing.get(d.key);
      const locked = d.locked;
      const override = !locked && prev?.classificationSource === 'override';
      const classification = locked ? 'write' : override ? prev!.classification : d.classification;
      const classificationSource = locked ? 'locked' : override ? 'override' : 'inferred';
      const fields = {
        displayName: d.displayName ?? null,
        kind: d.kind,
        pluginGroup: d.group,
        groupId: groupIdFor(d.group, d.groupLabel),
        tag: d.tag ?? null,
        classification,
        classificationSource,
        inferredClassification: d.classification,
        inferredReason: d.classificationReason,
        locked,
        typedConfirmation: d.typedConfirmation ?? locked,
        needsReview: d.needsReview,
        matchProfile: d.matchProfile ?? null,
        paramsSchema: d.paramsSchema ?? null,
        docs: d.docs ?? null,
        lastSeenAt: now,
        stale: false,
      } as const;
      const nowWrite = isEffectiveWrite({ classification, locked });

      if (!prev) {
        tx.insert(operations)
          .values({
            id: randomUUID(),
            instanceId,
            key: d.key,
            ...fields,
            attestationRequired: d.attestationRequired,
            firstSeenAt: now,
          })
          .run();
        summary.added++;
        if (nowWrite) summary.pendingReview.push(d.key);
        continue;
      }

      const becameWrite = nowWrite && !isEffectiveWrite(prev);
      const becameLocked = locked && !prev.locked;
      tx.update(operations)
        .set({
          ...fields,
          // The plugin can add the attestation requirement; only an admin can remove it.
          attestationRequired: prev.attestationRequired || d.attestationRequired,
          ...(becameWrite ? { writeAcknowledged: false, acknowledgedAt: null, acknowledgedBy: null } : {}),
          ...(becameLocked ? { lockedOptIn: false } : {}),
        })
        .where(eq(operations.id, prev.id))
        .run();
      summary.updated++;
      if (prev.stale) summary.restored++;
      if (becameWrite) summary.pendingReview.push(d.key);
      if (becameLocked) summary.newlyLocked.push(prev.id);
    }

    const missing = [...existing.values()].filter((o) => !seen.has(o.key) && !o.stale).map((o) => o.id);
    if (missing.length > 0) {
      tx.update(operations).set({ stale: true }).where(inArray(operations.id, missing)).run();
      summary.staled = missing.length;
    }

    if (summary.newlyLocked.length > 0) {
      summary.rulesDisabled = tx
        .update(preApprovalRules)
        .set({ enabled: false, updatedAt: now })
        .where(and(inArray(preApprovalRules.operationId, summary.newlyLocked), eq(preApprovalRules.enabled, true)))
        .run().changes;
    }

    // A group is stale when none of its operations are live; its level is kept in case they return.
    const liveGroupIds = new Set(
      tx
        .select({ groupId: operations.groupId })
        .from(operations)
        .where(and(eq(operations.instanceId, instanceId), eq(operations.stale, false)))
        .all()
        .map((r) => r.groupId),
    );
    for (const g of groups.values()) {
      const stale = !liveGroupIds.has(g.id);
      if (stale !== g.stale) tx.update(operationGroups).set({ stale }).where(eq(operationGroups.id, g.id)).run();
    }

    tx.update(pluginInstances)
      .set({
        upstreamVersion: result.upstreamVersion,
        sourceRef: result.sourceRef ?? null,
        lastSyncedAt: now,
        lastSyncStatus: 'ok',
      })
      .where(eq(pluginInstances.id, instanceId))
      .run();

    const newlyLockedKeys = [...existing.values()].filter((o) => summary.newlyLocked.includes(o.id)).map((o) => o.key);
    writeAudit(
      tx,
      {
        kind: 'plugin',
        instanceId,
        decision: 'catalog_synced',
        actorKind: 'system',
        detail: { ...summary, newlyLocked: newlyLockedKeys, upstreamVersion: result.upstreamVersion },
      },
      now,
    );
    if (summary.rulesDisabled > 0) {
      writeAudit(
        tx,
        {
          kind: 'config',
          instanceId,
          decision: 'rules_disabled_operation_locked',
          actorKind: 'system',
          detail: { operations: newlyLockedKeys, rulesDisabled: summary.rulesDisabled },
        },
        now,
      );
    }
    return { ...summary, newlyLocked: newlyLockedKeys };
  });
}
