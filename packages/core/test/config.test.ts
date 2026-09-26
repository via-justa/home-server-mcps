import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '../src/config/env.js';
import { clientIp } from '../src/http/common.js';
import { isValidSlug, RESERVED_SLUGS } from '../src/endpoints/slug.js';

describe('loadConfig', () => {
  it('defaults to MCP 8080 and admin 8081', () => {
    const c = loadConfig({});
    expect(c.MCP_PORT).toBe(8080);
    expect(c.ADMIN_PORT).toBe(8081);
    expect(c.TRUST_PROXY).toBe(0);
  });

  it('reads TRUST_PROXY as a hop count', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    expect(loadConfig({ TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(0);
    expect(() => loadConfig({ TRUST_PROXY: 'yes' })).toThrow(/hop count/);
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

describe('clientIp', () => {
  const ipOf = async (trust: number, xff?: string) => {
    const app = new Hono().get('/', (c) => c.text(clientIp(c, trust) ?? 'none'));
    return (await app.request('/', { headers: xff ? { 'x-forwarded-for': xff } : {} })).text();
  };

  it('takes the address the trusted proxy appended, not what the client sent', async () => {
    // The client forged the first entry; the one proxy appended the real peer.
    expect(await ipOf(1, '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(await ipOf(1, '203.0.113.9')).toBe('203.0.113.9');
    // Two chained proxies: the second-to-last entry is what the outer one saw.
    expect(await ipOf(2, '6.6.6.6, 203.0.113.9, 10.0.0.2')).toBe('203.0.113.9');
    // Untrusted: the header is ignored.
    expect(await ipOf(0, '6.6.6.6')).toBe('none');
  });
});
