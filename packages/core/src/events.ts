import { EventEmitter } from 'node:events';

/**
 * In-process event bus (design §9.1). Notifiers and the admin SSE stream subscribe here; producers
 * never need to know who is listening. Payloads never carry raw params or secrets.
 */
export interface CoreEventMap {
  'approval.pending': [
    { approvalId: string; instanceId: string; slug: string; operationKey: string; summary: string; expiresAt: Date },
  ];
  'approval.decided': [
    {
      approvalId: string;
      instanceId: string;
      slug: string;
      operationKey: string;
      outcome: string;
      via?: string;
      decidedBy?: string;
    },
  ];
  'instance.status': [{ instanceId: string; slug: string; status: string; error?: string }];
  'plugin.crashed': [{ instanceId: string; slug: string; error: string }];
  'sync.completed': [{ instanceId: string; slug: string; added: number; pendingReview: string[]; newGroups: string[] }];
  'sync.failed': [{ instanceId: string; slug: string; error: string }];
  'auth.lockout': [{ username: string; ip?: string }];
}

export type CoreEventName = keyof CoreEventMap;

export const CORE_EVENT_NAMES: CoreEventName[] = [
  'approval.pending',
  'approval.decided',
  'instance.status',
  'plugin.crashed',
  'sync.completed',
  'sync.failed',
  'auth.lockout',
];

export class CoreEvents extends EventEmitter<CoreEventMap> {
  constructor() {
    super();
    // Several subscribers (notifier channels, SSE clients) is normal; don't warn at 10.
    this.setMaxListeners(0);
  }
}
