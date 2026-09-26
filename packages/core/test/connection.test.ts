import type { Manifest } from '@home-server-mcps/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/errors.js';
import { validateConnection } from '../src/instances/connection.js';

const manifest = (schema: Record<string, unknown>) => ({ connection: { schema } }) as unknown as Manifest;

describe('validateConnection (review L2)', () => {
  it('validates repeatedly against a schema with an $id, and a changed schema under the same $id', () => {
    const v1 = manifest({
      $id: 'https://example.com/conn.json',
      type: 'object',
      properties: { url: { type: 'string', format: 'uri' }, apiKey: { type: 'string', writeOnly: true } },
      required: ['url'],
    });
    for (let i = 0; i < 3; i++) {
      expect(validateConnection(v1, { url: 'https://nas.lan', apiKey: 'k' })).toEqual({
        config: { url: 'https://nas.lan' },
        secrets: { apiKey: 'k' },
      });
    }
    expect(() => validateConnection(v1, { url: 'not a url' })).toThrow(ValidationError);

    // A later plugin version keeps the $id but changes the schema.
    const v2 = manifest({
      $id: 'https://example.com/conn.json',
      type: 'object',
      properties: { host: { type: 'string' } },
      required: ['host'],
    });
    expect(validateConnection(v2, { host: 'nas' })).toEqual({ config: { host: 'nas' }, secrets: {} });
    expect(() => validateConnection(v2, { url: 'https://nas.lan' })).toThrow(ValidationError);
    expect(validateConnection(v1, { url: 'https://nas.lan' }).config).toEqual({ url: 'https://nas.lan' });
  });
});
