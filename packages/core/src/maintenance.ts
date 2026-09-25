import { and, lt, max, notInArray } from 'drizzle-orm';
import type { AppContext } from './app.js';
import { writeAudit } from './audit.js';
import { auditLog, pendingApprovals, preApprovalHits, preApprovalRules } from './db/schema.js';
import { getSettings } from './settings.js';

/**
 * Housekeeping (design §10): expired sessions, OAuth codes/tokens and approval links, rate-limit hits
 * older than any rule's window, decided approvals past a week, and — only when an admin configured a
 * retention — old audit rows. Runs hourly; every step is idempotent.
 */

const DAY = 24 * 60 * 60_000;

export interface HousekeepingResult {
  sessions: number;
  oauth: number;
  approvalLinks: number;
  preApprovalHits: number;
  approvals: number;
  audit: number;
}

export function runHousekeeping(ctx: AppContext): HousekeepingResult {
  const now = ctx.now();

  // Keep hits for the longest rule window (default 1 h), so rate limits stay exact.
  const longest =
    ctx.db
      .select({ w: max(preApprovalRules.windowSeconds) })
      .from(preApprovalRules)
      .get()?.w ?? 3600;
  const hitCutoff = new Date(now.getTime() - Math.max(longest, 3600) * 1000);
  const hits = ctx.db.delete(preApprovalHits).where(lt(preApprovalHits.occurredAt, hitCutoff)).run().changes;

  // Links cascade with their approval; approvals must outlive any link, and stay visible for a week.
  const approvals = ctx.db
    .delete(pendingApprovals)
    .where(
      and(
        lt(pendingApprovals.requestedAt, new Date(now.getTime() - 7 * DAY)),
        notInArray(pendingApprovals.status, ['pending']),
      ),
    )
    .run().changes;

  let audit = 0;
  const { retentionDays } = getSettings(ctx.db, 'audit');
  if (retentionDays) {
    const cutoff = new Date(now.getTime() - retentionDays * DAY);
    audit = ctx.db.delete(auditLog).where(lt(auditLog.at, cutoff)).run().changes;
    if (audit > 0) {
      writeAudit(
        ctx.db,
        {
          kind: 'config',
          decision: 'audit_purged',
          actorKind: 'system',
          detail: { rows: audit, before: cutoff.toISOString(), retentionDays },
        },
        now,
      );
    }
  }

  return {
    sessions: ctx.sessions.purgeExpired(),
    oauth: ctx.oauth.purgeExpired(),
    approvalLinks: ctx.links.purgeExpired(),
    preApprovalHits: hits,
    approvals,
    audit,
  };
}
