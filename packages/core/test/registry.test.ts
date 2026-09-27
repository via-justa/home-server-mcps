import { describe, expect, it } from 'vitest';
import { applyRegistrySync, findRegistryEntries, scopesFromQuery } from '../src/catalog/registry.js';
import { seedInstance } from './helpers.js';

const entries = [
  { kind: 'zone', id: 'zone_a', name: 'Zone A' },
  { kind: 'zone', id: 'zone_b', name: 'Zone B' },
  {
    kind: 'item',
    id: 'widget.one',
    name: 'Widget One',
    parentId: 'zone_a',
    scopes: { type: 'widget', zone: 'zone_a' },
  },
  {
    kind: 'item',
    id: 'widget.100_percent',
    name: '100% Widget',
    parentId: 'zone_b',
    scopes: { type: 'widget', zone: 'zone_b' },
  },
  {
    kind: 'item',
    id: 'gadget.front',
    name: 'Front Gadget',
    parentId: 'zone_b',
    scopes: { type: 'gadget', zone: 'zone_b' },
  },
];

describe('registry mirror', () => {
  it('upserts, filters, and marks missing entries stale', () => {
    const { db, instanceId } = seedInstance();
    expect(applyRegistrySync(db, instanceId, entries)).toEqual({ upserted: 5, staled: 0 });
    expect(findRegistryEntries(db, instanceId, { kind: 'zone' }).map((e) => e.id)).toEqual(['zone_a', 'zone_b']);
    expect(
      findRegistryEntries(db, instanceId, { parent: 'zone_b', scopes: { type: 'widget' } }).map((e) => e.id),
    ).toEqual(['widget.100_percent']);
    expect(findRegistryEntries(db, instanceId, { scopes: { type: 'widget', zone: 'zone_a' } })).toMatchObject([
      { id: 'widget.one', scopes: { type: 'widget', zone: 'zone_a' } },
    ]);
    expect(findRegistryEntries(db, instanceId, { text: 'widget one' }).map((e) => e.id)).toEqual(['widget.one']);

    expect(
      applyRegistrySync(
        db,
        instanceId,
        entries.filter((e) => e.id !== 'gadget.front'),
      ),
    ).toEqual({ upserted: 4, staled: 1 });
    expect(findRegistryEntries(db, instanceId, { scopes: { type: 'gadget' } })).toEqual([]);
  });

  it('treats % and _ in search text literally', () => {
    const { db, instanceId } = seedInstance();
    applyRegistrySync(db, instanceId, entries);
    expect(findRegistryEntries(db, instanceId, { text: '100%' }).map((e) => e.id)).toEqual(['widget.100_percent']);
    expect(findRegistryEntries(db, instanceId, { text: '%' }).map((e) => e.id)).toEqual(['widget.100_percent']);
    expect(findRegistryEntries(db, instanceId, { text: '_a' }).map((e) => e.id)).toEqual(['zone_a']);
  });

  it('reads scope filters from a query string and refuses malformed scope keys', () => {
    const { db, instanceId } = seedInstance();
    applyRegistrySync(db, instanceId, entries);
    expect(scopesFromQuery({ kind: 'item', 'scope.type': 'gadget', text: '' })).toEqual({ type: 'gadget' });
    expect(() => findRegistryEntries(db, instanceId, { scopes: { 'a"b': 'x' } })).toThrow(/not a scope key/);
  });

  it('rejects malformed plugin output', () => {
    const { db, instanceId } = seedInstance();
    expect(() => applyRegistrySync(db, instanceId, [{ kind: 'area' }])).toThrow();
  });
});
