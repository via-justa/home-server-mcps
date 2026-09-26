import { describe, expect, it } from 'vitest';
import { applyPatch, configHash, diff, validatePatch } from '../src/transform.js';

const automation = {
  id: 'morning',
  alias: 'Morning lights',
  triggers: [{ trigger: 'sun', event: 'sunrise' }],
  conditions: [{ condition: 'state', entity_id: 'person.me', state: 'home' }],
  actions: [{ action: 'light.turn_on', target: { area_id: 'kitchen' } }],
};

describe('config transforms (HA §2.8, §7 phase 6)', () => {
  it('hashes content, not key order', () => {
    expect(configHash({ a: 1, b: [1, { c: 2 }] })).toBe(configHash({ b: [1, { c: 2 }], a: 1 }));
    expect(configHash(automation)).not.toBe(configHash({ ...automation, alias: 'x' }));
  });

  it('applies add, append, replace, remove and test without touching the input', () => {
    const next = applyPatch(
      automation,
      validatePatch([
        { op: 'test', path: '/alias', value: 'Morning lights' },
        { op: 'replace', path: '/alias', value: 'Morning kitchen lights' },
        { op: 'add', path: '/triggers/-', value: { trigger: 'time', at: '07:00' } },
        { op: 'remove', path: '/conditions/0' },
        { op: 'add', path: '/mode', value: 'restart' },
      ]),
    );
    expect(next).toEqual({
      ...automation,
      alias: 'Morning kitchen lights',
      triggers: [automation.triggers[0], { trigger: 'time', at: '07:00' }],
      conditions: [],
      mode: 'restart',
    });
    expect(automation.alias).toBe('Morning lights');
  });

  it('diffs only the changed fields, for the approval prompt', () => {
    const next = applyPatch(
      automation,
      validatePatch([{ op: 'replace', path: '/actions/0/target/area_id', value: 'living_room' }]),
    );
    expect(diff(automation, next)).toEqual([
      { path: '/actions/0/target/area_id', before: 'kitchen', after: 'living_room' },
    ]);
    const added = applyPatch(
      automation,
      validatePatch([{ op: 'add', path: '/triggers/-', value: { trigger: 'time' } }]),
    );
    expect(diff(automation, added)).toEqual([
      { path: '/triggers', before: automation.triggers, after: [...automation.triggers, { trigger: 'time' }] },
    ]);
    expect(diff({ a: 1 }, { b: 2 })).toEqual([
      { path: '/a', before: 1 },
      { path: '/b', after: 2 },
    ]);
  });

  it.each([
    ['an empty patch', []],
    ['not a list', { op: 'add' }],
    ['an unknown op', [{ op: 'move', path: '/a', from: '/b' }]],
    ['a relative path', [{ op: 'remove', path: 'alias' }]],
    ['add without a value', [{ op: 'add', path: '/x' }]],
  ])('rejects %s', (_name, patch) => {
    expect(() => validatePatch(patch)).toThrow();
  });

  it.each([
    ['a missing key', [{ op: 'replace', path: '/nope', value: 1 }]],
    ['an out-of-range index', [{ op: 'remove', path: '/triggers/5' }]],
    ['a path through a scalar', [{ op: 'add', path: '/alias/x', value: 1 }]],
    ['a failed test', [{ op: 'test', path: '/alias', value: 'Other' }]],
    ['removing the whole object', [{ op: 'remove', path: '' }]],
  ])('refuses to apply %s', (_name, patch) => {
    expect(() => applyPatch(automation, validatePatch(patch))).toThrow();
  });
});
