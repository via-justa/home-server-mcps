import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { DbLike } from '../db/index.js';
import { guides } from '../db/schema.js';

/**
 * Best-practice attestation (HA §3.6, design §5.1/§5.2 step 1). `search` hands out a key bound to
 * (instance, operation, guide version); `execute` must present it. Revising the guide invalidates
 * every outstanding key at once, because the version is part of the MAC.
 */

export function issueAttestationKey(macKey: Buffer, instanceId: string, opKey: string, guideVersion: string): string {
  return createHmac('sha256', macKey).update(`${instanceId}\n${opKey}\n${guideVersion}`).digest('base64url');
}

export function currentGuide(db: DbLike, instanceId: string, operationId: string) {
  return db
    .select()
    .from(guides)
    .where(and(eq(guides.instanceId, instanceId), eq(guides.operationId, operationId)))
    .orderBy(desc(guides.fetchedAt))
    .get();
}

export function verifyAttestationKey(
  db: DbLike,
  macKey: Buffer,
  input: { instanceId: string; operationId: string; opKey: string; presented: unknown },
): boolean {
  if (typeof input.presented !== 'string' || input.presented === '') return false;
  const guide = currentGuide(db, input.instanceId, input.operationId);
  if (!guide) return false;
  const expected = Buffer.from(issueAttestationKey(macKey, input.instanceId, input.opKey, guide.version));
  const presented = Buffer.from(input.presented);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
