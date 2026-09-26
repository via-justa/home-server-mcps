/**
 * Access levels (design §5.2 step 2). Every operation has an effective level: its own override if
 * an admin set one, otherwise its group's level. The level decides whether a call is hidden, runs
 * straight away, needs a human approval, or is auto-approved:
 *
 *   none  → nothing callable
 *   read  → reads run; writes are hidden
 *   ask   → reads run; writes need approval (pre-approval rules may cover them)
 *   write → reads run; acknowledged writes run without asking
 *
 * Locked operations never follow their group into `ask`/`write`: each needs its own `ask` override,
 * and `write` is not allowed for them. A principal whose access ceiling is `read` (consent page,
 * bearer token) never reaches a write, whatever the levels say.
 */

export const ACCESS_LEVELS = ['none', 'read', 'ask', 'write'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_CEILINGS = ['read', 'write'] as const;
export type AccessCeiling = (typeof ACCESS_CEILINGS)[number];

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, ask: 2, write: 3 };

export const isAccessLevel = (v: unknown): v is AccessLevel => (ACCESS_LEVELS as readonly unknown[]).includes(v);

export const minLevel = (a: AccessLevel, b: AccessLevel): AccessLevel => (RANK[a] <= RANK[b] ? a : b);

export type AccessReason = 'group_missing' | 'level_none' | 'read_only' | 'token_read_only' | 'locked_not_opted_in';

/** `run`: read, no approval · `approve`: needs a human (or a pre-approval rule) · `auto`: write, auto-approved. */
export type AccessMode = 'run' | 'approve' | 'auto';

export interface AccessOperation {
  classification: 'read' | 'write';
  locked: boolean;
  levelOverride: AccessLevel | null;
  writeAcknowledged: boolean;
}

export interface AccessGroup {
  level: AccessLevel;
}

export interface AccessPrincipal {
  ceiling: AccessCeiling;
}

export type AccessDecision =
  | {
      reachable: true;
      mode: AccessMode;
      level: AccessLevel;
      /** A write at level `write` that nobody acknowledged yet: it asks until an admin does. */
      pendingReview?: true;
    }
  | { reachable: false; reason: AccessReason };

export const FULL_ACCESS: AccessPrincipal = { ceiling: 'write' };

export function effectiveAccess(
  op: AccessOperation,
  group: AccessGroup | undefined,
  principal: AccessPrincipal = FULL_ACCESS,
): AccessDecision {
  // Fail closed on a missing or unrecognized group row, and on an unrecognized override.
  if (!group || !isAccessLevel(group.level)) return { reachable: false, reason: 'group_missing' };
  const level: AccessLevel =
    op.levelOverride === null ? group.level : isAccessLevel(op.levelOverride) ? op.levelOverride : 'none';

  if (level === 'none') return { reachable: false, reason: 'level_none' };
  // Locked operations are always writes, whatever classification the row carries.
  const isWrite = op.locked || op.classification === 'write';
  if (!isWrite) return { reachable: true, mode: 'run', level };

  if (principal.ceiling !== 'write') return { reachable: false, reason: 'token_read_only' };
  if (op.locked) {
    // Only an explicit per-operation `ask` opens a locked op, and it never auto-approves.
    if (op.levelOverride === null || RANK[level] < RANK.ask) return { reachable: false, reason: 'locked_not_opted_in' };
    return { reachable: true, mode: 'approve', level: 'ask' };
  }
  if (level === 'read') return { reachable: false, reason: 'read_only' };
  if (level === 'ask') return { reachable: true, mode: 'approve', level };
  if (!op.writeAcknowledged) return { reachable: true, mode: 'approve', level, pendingReview: true };
  return { reachable: true, mode: 'auto', level };
}
