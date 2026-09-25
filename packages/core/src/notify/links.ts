import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { approvalLinks } from '../db/schema.js';
import { randomToken, sha256 } from '../auth/tokens.js';

/**
 * Approval links (design §9.2): single-use, stored hashed, bound to one approval, expiring with it.
 * A link only opens the decision page on the MCP port — deciding still needs a signed-in human.
 */

export type LinkAction = 'approve' | 'deny' | 'view';

export class ApprovalLinkService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(
    approvalId: string,
    expiresAt: Date,
    actions: LinkAction[] = ['approve', 'deny', 'view'],
  ): Record<LinkAction, string> {
    const out = {} as Record<LinkAction, string>;
    for (const action of actions) {
      const token = randomToken(32);
      this.db
        .insert(approvalLinks)
        .values({ tokenHash: sha256(token), approvalId, action, expiresAt })
        .run();
      out[action] = token;
    }
    return out;
  }

  /** The live link row for a token, or null if unknown, used, or expired. */
  resolve(token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    return (
      this.db
        .select()
        .from(approvalLinks)
        .where(
          and(
            eq(approvalLinks.tokenHash, sha256(token)),
            isNull(approvalLinks.usedAt),
            gt(approvalLinks.expiresAt, this.now()),
          ),
        )
        .get() ?? null
    );
  }

  /** Burns every link of an approval once it has been decided (by any channel). */
  consumeAll(approvalId: string) {
    this.db
      .update(approvalLinks)
      .set({ usedAt: this.now() })
      .where(and(eq(approvalLinks.approvalId, approvalId), isNull(approvalLinks.usedAt)))
      .run();
  }

  purgeExpired(): number {
    return this.db
      .delete(approvalLinks)
      .where(lt(approvalLinks.expiresAt, new Date(this.now().getTime() - 24 * 3600_000)))
      .run().changes;
  }
}
