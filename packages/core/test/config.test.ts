import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { isValidSlug, RESERVED_SLUGS } from '../src/endpoints/slug.js';

describe('loadConfig', () => {
  it('defaults to MCP 8080 and admin 8081', () => {
    const c = loadConfig({});
    expect(c.MCP_PORT).toBe(8080);
    expect(c.ADMIN_PORT).toBe(8081);
    expect(c.TRUST_PROXY).toBe(false);
  });

  it('refuses to put MCP and admin on the same port', () => {
    expect(() => loadConfig({ MCP_PORT: '9000', ADMIN_PORT: '9000' })).toThrow(/must differ/);
  });

  it('validates public URLs', () => {
    expect(loadConfig({ PUBLIC_MCP_URL: 'https://mcp.example.com' }).PUBLIC_MCP_URL).toBe('https://mcp.example.com');
    expect(loadConfig({ PUBLIC_MCP_URL: '' }).PUBLIC_MCP_URL).toBeUndefined();
    expect(() => loadConfig({ PUBLIC_MCP_URL: 'not a url' })).toThrow();
  });
});

describe('isValidSlug', () => {
  it.each(['ha', 'ha-cabin', 'truenas', 'seerr2'])('accepts %s', (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each(['', 'HA', '-ha', 'ha_cabin', 'a/b', 'x'.repeat(64), ...RESERVED_SLUGS])('rejects %s', (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });
});
