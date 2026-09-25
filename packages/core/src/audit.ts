import type { DbLike } from './db/index.js';
import { auditLog } from './db/schema.js';

export type AuditEvent = Omit<typeof auditLog.$inferInsert, 'id' | 'at'>;

/** Append-only (design §7.3): this module only ever inserts. */
export function writeAudit(db: DbLike, event: AuditEvent, at: Date = new Date()): void {
  db.insert(auditLog)
    .values({ ...event, at })
    .run();
}
