import type { ResolvedTarget } from '@home-server-mcps/plugin-sdk';
import { and, asc, count, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { preApprovalHits, preApprovalRules } from '../db/schema.js';
import { matches, MatchSchema } from './match.js';

export type PreApprovalOutcome =
  | { kind: 'auto_approved'; ruleId: string }
  /** Rules matched but all were at their rate limit: the call falls back to a human (TN §3.5). */
  | { kind: 'rate_limited'; ruleIds: string[] }
  | { kind: 'no_match' };

/**
 * Finds an enabled, unexpired rule for the operation whose match holds and which has rate budget left,
 * and records the hit, all in one transaction so concurrent calls can't overshoot a limit. Callers
 * must never pass a locked operation (design §5.2 step 6); rules on locked ops are also disabled at sync.
 */
export function evaluatePreApproval(
  db: Db,
  input: { instanceId: string; operationId: string; params: unknown; targets: readonly ResolvedTarget[] },
  now = new Date(),
): PreApprovalOutcome {
  return db.transaction((tx) => {
    const rules = tx
      .select()
      .from(preApprovalRules)
      .where(
        and(
          eq(preApprovalRules.instanceId, input.instanceId),
          eq(preApprovalRules.operationId, input.operationId),
          eq(preApprovalRules.enabled, true),
        ),
      )
      .orderBy(asc(preApprovalRules.createdAt))
      .all();

    const limited: string[] = [];
    for (const rule of rules) {
      if (rule.expiresAt && rule.expiresAt.getTime() <= now.getTime()) continue;
      const match = MatchSchema.safeParse(rule.match);
      if (!match.success || !matches(match.data, { params: input.params, targets: input.targets })) continue;

      if (rule.rateLimit != null) {
        const windowMs = (rule.windowSeconds ?? 3600) * 1000;
        const used =
          tx
            .select({ n: count() })
            .from(preApprovalHits)
            .where(
              and(
                eq(preApprovalHits.ruleId, rule.id),
                gt(preApprovalHits.occurredAt, new Date(now.getTime() - windowMs)),
              ),
            )
            .get()?.n ?? 0;
        if (used >= rule.rateLimit) {
          limited.push(rule.id);
          continue;
        }
      }
      tx.insert(preApprovalHits).values({ ruleId: rule.id, occurredAt: now }).run();
      tx.update(preApprovalRules).set({ lastTriggeredAt: now }).where(eq(preApprovalRules.id, rule.id)).run();
      return { kind: 'auto_approved', ruleId: rule.id };
    }
    return limited.length > 0 ? { kind: 'rate_limited', ruleIds: limited } : { kind: 'no_match' };
  });
}
