import { describe, expect, it } from 'vitest';
import { applyRegistrySync, findRegistryEntries } from '../src/catalog/registry.js';
import { seedInstance } from './helpers.js';

const entries = [
  { kind: 'area', id: 'living_room', name: 'Living Room' },
  { kind: 'area', id: 'kitchen', name: 'Kitchen' },
  { kind: 'entity', id: 'light.lamp', name: 'Floor Lamp', parentId: 'living_room', domain: 'light' },
  { kind: 'entity', id: 'light.100_percent', name: '100% Bulb', parentId: 'kitchen', domain: 'light' },
  { kind: 'entity', id: 'lock.front', name: 'Front Door', parentId: 'kitchen', domain: 'lock' },
];

describe('registry mirror', () => {
  it('upserts, filters, and marks missing entries stale', () => {
    const { db, instanceId } = seedInstance();
    expect(applyRegistrySync(db, instanceId, entries)).toEqual({ upserted: 5, staled: 0 });
    expect(findRegistryEntries(db, instanceId, { kind: 'area' }).map((e) => e.id)).toEqual(['kitchen', 'living_room']);
    expect(findRegistryEntries(db, instanceId, { parent: 'kitchen', domain: 'light' }).map((e) => e.id)).toEqual([
      'light.100_percent',
    ]);
    expect(findRegistryEntries(db, instanceId, { text: 'lamp' }).map((e) => e.id)).toEqual(['light.lamp']);

    expect(
      applyRegistrySync(
        db,
        instanceId,
        entries.filter((e) => e.id !== 'lock.front'),
      ),
    ).toEqual({ upserted: 4, staled: 1 });
    expect(findRegistryEntries(db, instanceId, { domain: 'lock' })).toEqual([]);
  });

  it('treats % and _ in search text literally', () => {
    const { db, instanceId } = seedInstance();
    applyRegistrySync(db, instanceId, entries);
    expect(findRegistryEntries(db, instanceId, { text: '100%' }).map((e) => e.id)).toEqual(['light.100_percent']);
    expect(findRegistryEntries(db, instanceId, { text: '%' }).map((e) => e.id)).toEqual(['light.100_percent']);
    expect(findRegistryEntries(db, instanceId, { text: '_room' }).map((e) => e.id)).toEqual(['living_room']);
  });

  it('rejects malformed plugin output', () => {
    const { db, instanceId } = seedInstance();
    expect(() => applyRegistrySync(db, instanceId, [{ kind: 'area' }])).toThrow();
  });
});
