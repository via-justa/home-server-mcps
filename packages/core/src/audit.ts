import type { DbLike } from './db/index.js';
import { auditLog } from './db/schema.js';

type AuditInsert = typeof auditLog.$inferInsert;

export interface AuditEvent {
  kind: AuditInsert['kind'];
  instanceId?: string;
  operationKey?: string;
  classification?: string;
  decision?: string;
  actorKind: AuditInsert['actorKind'];
  actorId?: string;
  detail?: unknown;
}

/** Append-only (design §7.3): this module only ever inserts. */
export function writeAudit(db: DbLike, event: AuditEvent, at: Date = new Date()): void {
  db.insert(auditLog)
    .values({ ...event, at })
    .run();
}
