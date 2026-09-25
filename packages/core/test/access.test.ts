import { describe, expect, it } from 'vitest';
import { effectiveAccess } from '../src/gate/access.js';
import type { AccessLevel, AccessOperation } from '../src/gate/access.js';

const read: AccessOperation = {
  classification: 'read',
  locked: false,
  excluded: false,
  lockedOptIn: false,
  writeAcknowledged: false,
};
const write: AccessOperation = { ...read, classification: 'write', writeAcknowledged: true };
const locked: AccessOperation = { ...write, locked: true, lockedOptIn: true };

const at = (level: AccessLevel) => ({ level });

describe('effectiveAccess', () => {
  it.each([
    ['read op, group none', read, 'none', 'group_none'],
    ['read op, group read', read, 'read', null],
    ['read op, group write', read, 'write', null],
    ['write op, group none', write, 'none', 'group_none'],
    ['write op, group read', write, 'read', 'group_read_only'],
    ['write op, group write', write, 'write', null],
    ['locked op, group read', locked, 'read', 'group_read_only'],
    ['locked op (opted in), group write', locked, 'write', null],
  ] as const)('%s', (_name, op, level, reason) => {
    expect(effectiveAccess(op, at(level))).toEqual(reason ? { reachable: false, reason } : { reachable: true });
  });

  it('fails closed when the group row is missing or has an unknown level', () => {
    expect(effectiveAccess(read, undefined)).toEqual({ reachable: false, reason: 'group_missing' });
    expect(effectiveAccess(read, { level: 'admin' as AccessLevel })).toEqual({
      reachable: false,
      reason: 'group_missing',
    });
  });

  it('lets an exclusion override any group level', () => {
    for (const op of [read, write, locked]) {
      expect(effectiveAccess({ ...op, excluded: true }, at('write'))).toEqual({ reachable: false, reason: 'excluded' });
    }
  });

  it('keeps locked ops off at write level until opted in', () => {
    expect(effectiveAccess({ ...locked, lockedOptIn: false }, at('write'))).toEqual({
      reachable: false,
      reason: 'locked_not_opted_in',
    });
  });

  it('treats a locked op as a write even if its row says read', () => {
    expect(effectiveAccess({ ...locked, classification: 'read' }, at('read'))).toEqual({
      reachable: false,
      reason: 'group_read_only',
    });
  });

  it('quarantines unacknowledged writes, but not reads', () => {
    expect(effectiveAccess({ ...write, writeAcknowledged: false }, at('write'))).toEqual({
      reachable: false,
      reason: 'pending_review',
    });
    expect(effectiveAccess({ ...locked, writeAcknowledged: false }, at('write'))).toEqual({
      reachable: false,
      reason: 'pending_review',
    });
    expect(effectiveAccess({ ...read, writeAcknowledged: false }, at('read'))).toEqual({ reachable: true });
  });
});
