import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { and, eq } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { pendingApprovals } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

/**
 * Human approval (design §5.3). A request is offered on every available channel at once: MCP
 * elicitation (if the client supports it), the portal inbox, and notifier links. The first decision
 * wins. Unanswered requests are denied at the timeout; nothing is ever approved by default.
 */

export type DecisionOutcome = 'approved' | 'denied' | 'timed_out' | 'cancelled';
export type DecisionChannel = 'elicitation' | 'portal' | 'link';

export interface Decision {
  outcome: DecisionOutcome;
  via?: DecisionChannel;
  decidedBy?: string;
  reason?: string;
}

/** What the MCP layer asks the client to show; `confirm` is present for typed-confirmation ops. */
export interface ElicitRequest {
  approvalId: string;
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, { type: 'boolean' | 'string'; title: string; description?: string }>;
    required: string[];
  };
}

export interface ElicitResponse {
  action: 'accept' | 'decline' | 'cancel';
  content?: { approve?: unknown; confirm?: unknown };
}

export type ElicitFn = (req: ElicitRequest) => Promise<ElicitResponse>;

export interface ApprovalRequestInput {
  instanceId: string;
  operationId: string;
  operationKey: string;
  classification: string;
  paramsDisplay: unknown;
  paramsHash: string;
  resolvedTargets: unknown;
  summary: string;
  confirmLiteral?: string;
  diff?: unknown;
  expectedHash?: string;
  client: { kind: string; id?: string };
  mcpSessionId?: string;
  timeoutMs: number;
  /** Present only when the MCP client advertised elicitation and the session is live. */
  elicit?: ElicitFn;
  /** When no elicitation is possible: wait for portal/link (true) or deny immediately (false). */
  allowPortalOnly: boolean;
}

export interface ApprovalEvents {
  pending: [approval: { id: string; instanceId: string; operationKey: string; summary: string; expiresAt: Date }];
  decided: [approval: { id: string; instanceId: string; operationKey: string; decision: Decision }];
}

interface Live {
  row: typeof pendingApprovals.$inferSelect;
  settle: (d: Decision) => void;
}

export class ApprovalService extends EventEmitter<ApprovalEvents> {
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  /**
   * Called once at startup: pending rows from a previous process can never be approved, because the
   * exact params they cover only ever lived in memory (design §5.5). They are denied and audited.
   */
  static denyOrphans(db: Db, now = new Date()): number {
    return db.transaction((tx) => {
      const orphans = tx.select().from(pendingApprovals).where(eq(pendingApprovals.status, 'pending')).all();
      for (const o of orphans) {
        tx.update(pendingApprovals)
          .set({ status: 'denied', decidedAt: now })
          .where(eq(pendingApprovals.id, o.id))
          .run();
        writeAudit(
          tx,
          {
            kind: 'call',
            instanceId: o.instanceId,
            decision: 'denied',
            actorKind: 'system',
            detail: { approvalId: o.id, reason: 'server_restart' },
          },
          now,
        );
      }
      return orphans.length;
    });
  }

  get pendingCount(): number {
    return this.live.size;
  }

  request(input: ApprovalRequestInput): { id: string; decision: Promise<Decision> } {
    const now = this.now();
    const id = randomUUID();
    const row = {
      id,
      instanceId: input.instanceId,
      operationId: input.operationId,
      paramsDisplay: input.paramsDisplay ?? null,
      paramsHash: input.paramsHash,
      resolvedTargets: input.resolvedTargets ?? null,
      summary: input.summary,
      confirmLiteral: input.confirmLiteral ?? null,
      diff: input.diff ?? null,
      expectedHash: input.expectedHash ?? null,
      clientKind: input.client.kind,
      clientId: input.client.id ?? null,
      mcpSessionId: input.mcpSessionId ?? null,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + input.timeoutMs),
      status: 'pending' as const,
      decidedBy: null,
      decidedVia: null,
      decidedAt: null,
    };

    if (!input.elicit && !input.allowPortalOnly) {
      this.db
        .insert(pendingApprovals)
        .values({ ...row, status: 'denied', decidedAt: now })
        .run();
      return { id, decision: Promise.resolve({ outcome: 'denied', reason: 'no_approval_path' }) };
    }

    this.db.insert(pendingApprovals).values(row).run();
    const decision = new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => settle({ outcome: 'timed_out' }), input.timeoutMs);
      const settle = (d: Decision) => {
        if (!this.live.delete(id)) return; // first decision wins
        clearTimeout(timer);
        const status = d.outcome === 'timed_out' ? 'timed_out' : d.outcome;
        this.db
          .update(pendingApprovals)
          .set({ status, decidedBy: d.decidedBy ?? null, decidedVia: d.via ?? null, decidedAt: this.now() })
          .where(and(eq(pendingApprovals.id, id), eq(pendingApprovals.status, 'pending')))
          .run();
        this.emit('decided', { id, instanceId: input.instanceId, operationKey: input.operationKey, decision: d });
        resolve(d);
      };
      this.live.set(id, { row, settle });
    });

    this.emit('pending', {
      id,
      instanceId: input.instanceId,
      operationKey: input.operationKey,
      summary: input.summary,
      expiresAt: row.expiresAt,
    });
    if (input.elicit) this.offerElicitation(id, input);
    return { id, decision };
  }

  private offerElicitation(id: string, input: ApprovalRequestInput) {
    const properties: ElicitRequest['requestedSchema']['properties'] = {
      approve: { type: 'boolean', title: 'Approve this call?' },
    };
    const required = ['approve'];
    if (input.confirmLiteral) {
      properties.confirm = {
        type: 'string',
        title: `Type "${input.confirmLiteral}" to confirm`,
        description: 'Required for this operation. Anything else denies the call.',
      };
      required.push('confirm');
    }
    const message = [
      input.summary,
      '',
      `Operation: ${input.operationKey} (${input.classification})`,
      `Parameters: ${JSON.stringify(input.paramsDisplay)}`,
      ...(input.diff ? [`Changes: ${JSON.stringify(input.diff)}`] : []),
    ].join('\n');

    input.elicit!({ approvalId: id, message, requestedSchema: { type: 'object', properties, required } }).then(
      (res) => {
        const live = this.live.get(id);
        if (!live) return;
        if (res.action === 'cancel') return; // dismissed without deciding: portal/link/timeout still apply
        if (res.action === 'decline' || res.content?.approve !== true) {
          return live.settle({ outcome: 'denied', via: 'elicitation', decidedBy: input.client.id });
        }
        if (input.confirmLiteral && res.content?.confirm !== input.confirmLiteral) {
          return live.settle({
            outcome: 'denied',
            via: 'elicitation',
            decidedBy: input.client.id,
            reason: 'confirmation_mismatch',
          });
        }
        live.settle({ outcome: 'approved', via: 'elicitation', decidedBy: input.client.id });
      },
      () => undefined, // client can't/didn't elicit: the other channels still apply
    );
  }

  /** Portal / approval-link decision. A wrong typed confirmation is rejected so the admin can retry. */
  decide(
    id: string,
    input: { approve: boolean; confirm?: string; decidedBy: string; via: 'portal' | 'link' },
  ): Decision {
    const live = this.live.get(id);
    if (!live) {
      const row = this.db.select().from(pendingApprovals).where(eq(pendingApprovals.id, id)).get();
      if (!row) throw new NotFoundError('approval_not_found', 'No such approval');
      throw new ConflictError('approval_closed', `This approval is already ${row.status}`);
    }
    if (input.approve && live.row.confirmLiteral && input.confirm !== live.row.confirmLiteral) {
      throw new ValidationError('confirmation_mismatch', `Type "${live.row.confirmLiteral}" exactly to approve`);
    }
    const decision: Decision = {
      outcome: input.approve ? 'approved' : 'denied',
      via: input.via,
      decidedBy: input.decidedBy,
    };
    live.settle(decision);
    return decision;
  }

  /** Cancels every open request (shutdown). Cancelled calls are denied to the sandbox. */
  cancelAll(reason = 'shutdown') {
    for (const live of [...this.live.values()]) live.settle({ outcome: 'cancelled', reason });
  }
}
