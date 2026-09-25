/**
 * Group-level access (design §5.2 step 2). Admins set one level per operation group; per-operation
 * state can only narrow it. Classification, approvals and pre-approval rules are evaluated later in
 * the pipeline — a reachable write still needs approval.
 */

export const ACCESS_LEVELS = ['none', 'read', 'write'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export type AccessReason =
  'group_missing' | 'group_none' | 'excluded' | 'group_read_only' | 'locked_not_opted_in' | 'pending_review';

export interface AccessOperation {
  classification: 'read' | 'write';
  locked: boolean;
  excluded: boolean;
  lockedOptIn: boolean;
  writeAcknowledged: boolean;
}

export interface AccessGroup {
  level: AccessLevel;
}

export type AccessDecision = { reachable: true } | { reachable: false; reason: AccessReason };

export function effectiveAccess(op: AccessOperation, group: AccessGroup | undefined): AccessDecision {
  // Fail closed on a missing or unrecognized group row.
  if (!group || !(ACCESS_LEVELS as readonly string[]).includes(group.level)) {
    return { reachable: false, reason: 'group_missing' };
  }
  if (group.level === 'none') return { reachable: false, reason: 'group_none' };
  if (op.excluded) return { reachable: false, reason: 'excluded' };
  // Locked operations are always writes, whatever classification the row carries.
  if (op.classification === 'read' && !op.locked) return { reachable: true };
  if (group.level === 'read') return { reachable: false, reason: 'group_read_only' };
  if (op.locked && !op.lockedOptIn) return { reachable: false, reason: 'locked_not_opted_in' };
  if (!op.writeAcknowledged) return { reachable: false, reason: 'pending_review' };
  return { reachable: true };
}
