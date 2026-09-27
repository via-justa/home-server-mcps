import { describe, expect, it } from 'vitest';
import { applyRegistrySync, findRegistryEntries } from '../src/catalog/registry.js';
import { seedInstance } from './helpers.js';

const entries = [
  { kind: 'area', id: 'zone_a', name: 'Zone A' },
  { kind: 'area', id: 'zone_b', name: 'Zone B' },
  { kind: 'entity', id: 'widget.one', name: 'Widget One', parentId: 'zone_a', domain: 'widget' },
  { kind: 'entity', id: 'widget.100_percent', name: '100% Widget', parentId: 'zone_b', domain: 'widget' },
  { kind: 'entity', id: 'gadget.front', name: 'Front Gadget', parentId: 'zone_b', domain: 'gadget' },
];

describe('registry mirror', () => {
  it('upserts, filters, and marks missing entries stale', () => {
    const { db, instanceId } = seedInstance();
    expect(applyRegistrySync(db, instanceId, entries)).toEqual({ upserted: 5, staled: 0 });
    expect(findRegistryEntries(db, instanceId, { kind: 'area' }).map((e) => e.id)).toEqual(['zone_a', 'zone_b']);
    expect(findRegistryEntries(db, instanceId, { parent: 'zone_b', domain: 'widget' }).map((e) => e.id)).toEqual([
      'widget.100_percent',
    ]);
    expect(findRegistryEntries(db, instanceId, { text: 'widget one' }).map((e) => e.id)).toEqual(['widget.one']);

    expect(
      applyRegistrySync(
        db,
        instanceId,
        entries.filter((e) => e.id !== 'gadget.front'),
      ),
    ).toEqual({ upserted: 4, staled: 1 });
    expect(findRegistryEntries(db, instanceId, { domain: 'gadget' })).toEqual([]);
  });

  it('treats % and _ in search text literally', () => {
    const { db, instanceId } = seedInstance();
    applyRegistrySync(db, instanceId, entries);
    expect(findRegistryEntries(db, instanceId, { text: '100%' }).map((e) => e.id)).toEqual(['widget.100_percent']);
    expect(findRegistryEntries(db, instanceId, { text: '%' }).map((e) => e.id)).toEqual(['widget.100_percent']);
    expect(findRegistryEntries(db, instanceId, { text: '_a' }).map((e) => e.id)).toEqual(['zone_a']);
  });

  it('rejects malformed plugin output', () => {
    const { db, instanceId } = seedInstance();
    expect(() => applyRegistrySync(db, instanceId, [{ kind: 'area' }])).toThrow();
  });
});
