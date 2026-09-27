import { describe, expect, it } from 'vitest';
import { isSdkCompatible, parseManifest, SDK_VERSION } from '../src/index.js';

const minimal = {
  id: 'example',
  name: 'Example',
  version: '1.0.0',
  sdk: '^0.1.0',
  entry: 'dist/index.js',
  binding: { namespace: 'example', functions: ['call'] },
  connection: { schema: { type: 'object' } },
};

describe('parseManifest', () => {
  it('accepts a minimal manifest and applies defaults', () => {
    const m = parseManifest(minimal);
    expect(m.capabilities).toEqual({ registry: false, targets: false, attestation: false, configTransform: false });
    expect(m.labels).toEqual({ operation: 'Operation', operations: 'Operations' });
    expect(m.binding.searchApis).toEqual([]);
    expect(m.network.hosts).toEqual([]);
    expect(m.matchProfiles).toEqual({});
  });

  it.each([
    ['uppercase id', { id: 'Example' }],
    ['non-semver version', { version: 'one' }],
    ['invalid sdk range', { sdk: 'not a range' }],
    ['absolute entry', { entry: '/etc/passwd' }],
    ['entry escaping the package', { entry: '../core/dist/main.js' }],
    ['reserved namespace', { binding: { namespace: 'catalog', functions: ['call'] } }],
    ['non-identifier function', { binding: { namespace: 'x', functions: ['do-it'] } }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseManifest({ ...minimal, ...patch })).toThrow();
  });

  it('rejects an unknown widget', () => {
    expect(() =>
      parseManifest({
        ...minimal,
        matchProfiles: { p: [{ field: '/name', label: 'Name', op: 'prefix', widget: 'free-text' }] },
      }),
    ).toThrow();
  });

  it('requires an op on param match fields', () => {
    expect(() =>
      parseManifest({ ...minimal, matchProfiles: { p: [{ field: '/name', label: 'Name', widget: 'prefix' }] } }),
    ).toThrow(/op/);
  });

  it('requires the targets capability for $targets match fields', () => {
    const profile = { p: [{ field: '$targets', label: 'Targets', widget: 'registry-picker' }] };
    expect(() => parseManifest({ ...minimal, matchProfiles: profile })).toThrow(/capabilities.targets/);
    expect(() => parseManifest({ ...minimal, capabilities: { targets: true }, matchProfiles: profile })).not.toThrow();
  });

  it('accepts covers only on $targets fields, as a JSON pointer', () => {
    const withCovers = (field: Record<string, unknown>) =>
      parseManifest({ ...minimal, capabilities: { targets: true }, matchProfiles: { p: [field] } });
    const targets = { field: '$targets', label: 'Targets', widget: 'registry-picker' };
    expect(withCovers({ ...targets, covers: '/selector' }).matchProfiles.p![0]).toMatchObject({ covers: '/selector' });
    expect(() => withCovers({ ...targets, covers: 'selector' })).toThrow(/JSON pointer/);
    expect(() => withCovers({ field: '/name', label: 'Name', op: 'eq', widget: 'text', covers: '/x' })).toThrow(
      /only \$targets/,
    );
  });

  it('requires matching capabilities for extra search APIs', () => {
    const binding = { namespace: 'x', functions: ['call'], searchApis: ['registry'] };
    expect(() => parseManifest({ ...minimal, binding })).toThrow(/capabilities.registry/);
    expect(() => parseManifest({ ...minimal, binding, capabilities: { registry: true } })).not.toThrow();
  });

  describe('connection ui', () => {
    const schema = {
      type: 'object',
      properties: { method: { type: 'string' }, password: { type: 'string', writeOnly: true } },
    };
    const withUi = (ui: unknown) => ({ ...minimal, connection: { schema, ui, help: 'Create a local user first.' } });

    it('accepts showWhen referencing another field', () => {
      const m = parseManifest(withUi({ password: { widget: 'secret', showWhen: { field: 'method', in: ['local'] } } }));
      expect(m.connection.ui.password?.showWhen).toEqual({ field: 'method', in: ['local'] });
      expect(m.connection.help).toBe('Create a local user first.');
    });

    it('rejects hints for unknown fields', () => {
      expect(() => parseManifest(withUi({ token: { widget: 'secret' } }))).toThrow(/no such connection field/);
    });

    it.each([
      ['an unknown field', { field: 'nope', in: ['x'] }],
      ['itself', { field: 'password', in: ['x'] }],
    ])('rejects showWhen referencing %s', (_name, showWhen) => {
      expect(() => parseManifest(withUi({ password: { showWhen } }))).toThrow(/another connection field/);
    });

    it('rejects an empty showWhen value list', () => {
      expect(() => parseManifest(withUi({ password: { showWhen: { field: 'method', in: [] } } }))).toThrow();
    });
  });
});

describe('isSdkCompatible', () => {
  it('checks the manifest range against the SDK version', () => {
    expect(isSdkCompatible({ sdk: `^${SDK_VERSION}` })).toBe(true);
    expect(isSdkCompatible({ sdk: '^2.0.0' })).toBe(false);
  });
});
