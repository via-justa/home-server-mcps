import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppContext } from '../src/app.js';
import type { AppContext } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { startServers } from '../src/server.js';
import type { RunningServers } from '../src/server.js';

let servers: RunningServers;
let ctx: AppContext;
let dataDir: string;
let uiDir: string;
let mcp: string;
let admin: string;

beforeAll(async () => {
  uiDir = mkdtempSync(path.join(tmpdir(), 'synoikia-ui-'));
  writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><div id="app"></div>');
  dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-data-'));
  ctx = await createAppContext(
    loadConfig({
      MCP_HOST: '127.0.0.1',
      MCP_PORT: '0',
      ADMIN_HOST: '127.0.0.1',
      ADMIN_PORT: '0',
      ADMIN_UI_DIR: uiDir,
      DATA_DIR: dataDir,
      CORE_PLUGINS_DIR: path.join(dataDir, 'no-core-plugins'),
    }),
  );
  servers = await startServers(ctx);
  mcp = `http://127.0.0.1:${servers.mcp.port}`;
  admin = `http://127.0.0.1:${servers.admin.port}`;
});

afterAll(async () => {
  await servers?.close();
  await ctx?.stop();
  rmSync(uiDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('listeners', () => {
  it('bind two different ports', () => {
    expect(servers.mcp.port).not.toBe(servers.admin.port);
  });

  it.each([
    ['mcp', () => mcp],
    ['admin', () => admin],
  ])('%s serves /healthz', async (_name, base) => {
    const res = await fetch(`${base()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('port separation', () => {
  it('does not expose the Admin API or auth on the MCP port', async () => {
    for (const p of ['/api/session', '/api/instances', '/auth/login']) {
      const res = await fetch(`${mcp}${p}`, { method: p.startsWith('/auth') ? 'POST' : 'GET' });
      expect(res.status, p).toBe(404);
    }
  });

  it('does not expose MCP endpoints or OAuth on the admin port', async () => {
    const post = await fetch(`${admin}/acme`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(post.status).toBe(404);
    for (const p of ['/.well-known/oauth-authorization-server', '/oauth/token']) {
      const res = await fetch(`${admin}${p}`, { method: p.startsWith('/oauth') ? 'POST' : 'GET' });
      expect(res.status, p).toBe(404);
    }
  });
});

describe('mcp listener', () => {
  it('answers an unknown slug like any endpoint that needs credentials (review L16)', async () => {
    const res = await fetch(`${mcp}/nope`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  });
});

describe('admin listener', () => {
  it('serves the SPA for client-side routes', async () => {
    const res = await fetch(`${admin}/endpoints/acme/connection`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="app">');
  });

  it('reports an unauthenticated session that needs setup', async () => {
    const res = await fetch(`${admin}/api/session`);
    expect(await res.json()).toMatchObject({ authenticated: false, setupRequired: true });
  });

  it('does not let the SPA fallback swallow unknown API routes', async () => {
    const res = await fetch(`${admin}/api/does-not-exist`);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
