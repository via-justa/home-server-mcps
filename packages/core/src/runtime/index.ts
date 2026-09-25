import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import { listGroups } from '../catalog/groups.js';
import { findRegistryEntries } from '../catalog/registry.js';
import type { Db } from '../db/index.js';
import { guides, operationGroups, operations } from '../db/schema.js';
import { effectiveAccess } from '../gate/access.js';
import { currentGuide, issueAttestationKey } from '../gate/attestation.js';
import { createGateBindings } from '../gate/pipeline.js';
import type { CallerContext, GateDeps, InstanceRuntime } from '../gate/pipeline.js';
import { BindingError, runInSandbox } from '../sandbox/index.js';
import type { Binding, SandboxResult } from '../sandbox/index.js';

/**
 * The two MCP tools' engines (design §5.1–§5.2). The MCP transport layer (phase 14) only has to
 * turn a tool call into `executeCode` / `searchCode` and the result back into tool output.
 */

export async function executeCode(
  deps: GateDeps,
  rt: InstanceRuntime,
  caller: CallerContext,
  code: string,
): Promise<SandboxResult> {
  const result = await runInSandbox({
    code,
    bindings: createGateBindings(deps, rt, caller),
    limits: rt.settings.sandbox,
  });
  // Each gated call's result was already redacted; this covers anything the script derived or logged.
  return result.ok ? { ...result, value: rt.redact(result.value), logs: rt.redact(result.logs) } : result;
}

type OperationRow = typeof operations.$inferSelect;

export interface CatalogFindQuery {
  text?: string;
  group?: string;
  tag?: string;
  kind?: string;
  classification?: 'read' | 'write' | 'locked';
  includeDisabled?: boolean;
  limit?: number;
}

function describeOp(op: OperationRow, groupKey: string | undefined, access: ReturnType<typeof effectiveAccess>) {
  return {
    key: op.key,
    displayName: op.displayName ?? undefined,
    group: groupKey,
    classification: op.locked ? 'locked' : op.classification,
    needsApproval: op.locked || op.classification === 'write',
    typedConfirmation: op.typedConfirmation,
    attestationRequired: op.attestationRequired,
    summary: (op.docs as { summary?: string } | null)?.summary,
    ...(access.reachable ? {} : { disabled: true, reason: access.reason }),
  };
}

function catalogBindings(db: Db, instanceId: string): Record<string, Binding> {
  const load = () => {
    const groups = new Map(
      db
        .select()
        .from(operationGroups)
        .where(eq(operationGroups.instanceId, instanceId))
        .all()
        .map((g) => [g.id, g]),
    );
    const ops = db
      .select()
      .from(operations)
      .where(and(eq(operations.instanceId, instanceId), eq(operations.stale, false)))
      .orderBy(asc(operations.key))
      .all();
    return { groups, ops };
  };
  const accessOf = (op: OperationRow, groups: Map<string, typeof operationGroups.$inferSelect>) =>
    effectiveAccess(
      {
        classification: op.classification,
        locked: op.locked,
        excluded: op.excluded,
        lockedOptIn: op.lockedOptIn,
        writeAcknowledged: op.writeAcknowledged,
      },
      groups.get(op.groupId),
    );

  return {
    find: async ([rawQuery]) => {
      const q = (rawQuery ?? {}) as CatalogFindQuery;
      const text = q.text?.toLowerCase();
      const limit = Math.min(Math.max(1, Number(q.limit) || 50), 200);
      const { groups, ops } = load();
      const out = [];
      for (const op of ops) {
        const group = groups.get(op.groupId);
        const access = accessOf(op, groups);
        if (!access.reachable && !q.includeDisabled) continue;
        if (q.group && group?.key !== q.group) continue;
        if (q.tag && op.tag !== q.tag) continue;
        if (q.kind && op.kind !== q.kind) continue;
        const cls = op.locked ? 'locked' : op.classification;
        if (q.classification && cls !== q.classification) continue;
        if (text) {
          const hay = [op.key, op.displayName, (op.docs as { summary?: string } | null)?.summary]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(text)) continue;
        }
        out.push(describeOp(op, group?.key, access));
        if (out.length >= limit) break;
      }
      return out;
    },
    get: async ([key]) => {
      const { groups, ops } = load();
      const op = ops.find((o) => o.key === key);
      if (!op) return null;
      const access = accessOf(op, groups);
      return { ...describeOp(op, groups.get(op.groupId)?.key, access), paramsSchema: op.paramsSchema, docs: op.docs };
    },
    groups: async () => listGroups(db, instanceId).filter((g) => !g.stale),
  };
}

/**
 * `guides.get(key)`: fetches the plugin's current best-practice guide, records its version, and
 * hands out the attestation key `execute` must present (HA §3.6). Revising a guide rotates the key.
 */
function guideBindings(deps: GateDeps, rt: InstanceRuntime): Record<string, Binding> {
  return {
    get: async ([key]) => {
      const op = deps.db
        .select()
        .from(operations)
        .where(
          and(eq(operations.instanceId, rt.instanceId), eq(operations.key, String(key)), eq(operations.stale, false)),
        )
        .get();
      if (!op) throw new BindingError('UNKNOWN_OPERATION', `${String(key)} is not in the catalog`);
      if (!op.attestationRequired) return { key: op.key, required: false };
      let guide;
      try {
        guide = await rt.plugin().call('getGuide', { key: op.key });
      } catch {
        throw new BindingError('PLUGIN_ERROR', `Could not load the guide for ${op.key}`);
      }
      const current = currentGuide(deps.db, rt.instanceId, op.id);
      if (!current || current.version !== guide.version || current.content !== guide.content) {
        deps.db
          .insert(guides)
          .values({
            id: randomUUID(),
            instanceId: rt.instanceId,
            operationId: op.id,
            version: guide.version,
            content: guide.content,
            fetchedAt: deps.now?.() ?? new Date(),
          })
          .run();
      }
      return {
        key: op.key,
        required: true,
        version: guide.version,
        content: guide.content,
        best_practice_key: issueAttestationKey(deps.attestationKey, rt.instanceId, op.key, guide.version),
      };
    },
  };
}

function searchBindings(deps: GateDeps, rt: InstanceRuntime): Record<string, Record<string, Binding>> {
  const bindings: Record<string, Record<string, Binding>> = { catalog: catalogBindings(deps.db, rt.instanceId) };
  if (rt.manifest.capabilities.registry) {
    bindings.registry = {
      find: async ([q]) =>
        findRegistryEntries(deps.db, rt.instanceId, (q ?? {}) as Parameters<typeof findRegistryEntries>[2]),
    };
  }
  if (rt.manifest.capabilities.attestation) bindings.guides = guideBindings(deps, rt);
  return bindings;
}

export async function searchCode(
  deps: GateDeps,
  rt: InstanceRuntime,
  caller: CallerContext,
  code: string,
): Promise<SandboxResult> {
  const result = await runInSandbox({
    code,
    bindings: searchBindings(deps, rt),
    limits: rt.settings.sandbox,
  });
  writeAudit(
    deps.db,
    {
      kind: 'search',
      instanceId: rt.instanceId,
      actorKind: 'mcp_client',
      actorId: caller.client.id,
      resultStatus: result.ok ? 'ok' : 'error',
      detail: result.ok ? { truncated: result.truncated } : { error: result.error.code },
    },
    deps.now?.() ?? new Date(),
  );
  return result.ok ? { ...result, value: rt.redact(result.value) } : result;
}
