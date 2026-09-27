import { describe, expect, it } from 'vitest';
import { OperationDescriptorSchema } from '../src/index.js';

const base = {
  key: 'app.upgrade',
  kind: 'method',
  group: 'app',
  classification: 'write',
  classificationReason: 'naming:upgrade',
};

describe('OperationDescriptorSchema', () => {
  it('applies defaults', () => {
    expect(OperationDescriptorSchema.parse(base)).toMatchObject({
      locked: false,
      attestationRequired: false,
      needsReview: false,
    });
  });

  it('requires an access group', () => {
    const { group: _group, ...withoutGroup } = base;
    expect(() => OperationDescriptorSchema.parse(withoutGroup)).toThrow();
  });

  it.each(['app', 'store.volume', 'share.files', 'request', 'widget', 'config_entries', 'alert-panel'])(
    'accepts group %s',
    (group) => {
      expect(() => OperationDescriptorSchema.parse({ ...base, group })).not.toThrow();
    },
  );

  it.each(['', 'App', '.app', 'store/volume', 'a b', 'x'.repeat(129)])('rejects group %j', (group) => {
    expect(() => OperationDescriptorSchema.parse({ ...base, group })).toThrow();
  });
});
