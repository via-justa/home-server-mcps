import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppContext } from '../src/app.js';
import { setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { loadConfig } from '../src/config/env.js';
import { auditLog, notifierChannels, operations } from '../src/db/schema.js';
import { createAdminApp } from '../src/http/admin-app.js';
import { createMcpApp } from '../src/http/mcp-app.js';
import { executeCode } from '../src/runtime/index.js';
import { browser } from './admin-client.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');
const PASSWORD = 'correct horse battery';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(respond: (req: Sent) => number = () => 200) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hsm-notify-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const sent: Sent[] = [];
  const ctx = await createAppContext(
    loadConfig({
      DATA_DIR: dataDir,
      CORE_PLUGINS_DIR: PLUGINS,
      CORE_PLUGINS_AUTOENABLE: 'true',
      PUBLIC_MCP_URL: 'https://mcp.example.com/',
    }),
    {
      memoryDb: true,
      notifyRetryDelaysMs: [1, 1],
      notifyFetch: async (url, init) => {
        const req = { url, headers: init.headers, body: init.body };
        sent.push(req);
        const status = respond(req);
        return { ok: status < 300, status };
      },
    },
  );
  cleanup.push(() => ctx.stop());
  return { ctx, sent };
}

/** Waits for async fan-out (dispatch is fire-and-forget from event handlers). */
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

/** Cookie-keeping browser for the MCP-port HTML forms. */
function formBrowser(app: Pick<Hono, 'request'>) {
  const jar = new Map<string, string>();
  return async (url: string, fields?: Record<string, string>) => {
    const headers: Record<string, string> = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (fields) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await app.request(url, {
      method: fields ? 'POST' : 'GET',
      headers,
      body: fields ? new URLSearchParams(fields).toString() : undefined,
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair!.indexOf('=');
      const value = pair!.slice(i + 1);
      if (value) jar.set(pair!.slice(0, i), value);
      else jar.delete(pair!.slice(0, i));
    }
    return res;
  };
}
const hidden = (page: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1] ?? '';

describe('notification channels', () => {
  it('stores secrets encrypted, reports only whether they are set, and merges updates', async () => {
    const { ctx } = await setup();
    const ch = ctx.notifier.save({
      kind: 'ntfy',
      name: 'Phone',
      config: { topic: 'homelab' },
      secrets: { token: 'tk_secret' },
      events: ['approval.pending'],
    });
    expect(ch.secrets).toEqual({ token: { set: true } });
    expect(JSON.stringify(ctx.notifier.list())).not.toContain('tk_secret');
    const raw = ctx.db.select().from(notifierChannels).get()!;
    expect(raw.secretsEnc!.toString('utf8')).not.toContain('tk_secret');

    // Omitted secrets are kept; null clears.
    expect(ctx.notifier.save({ name: 'Phone 2' }, { id: ch.id }).secrets).toEqual({ token: { set: true } });
    expect(ctx.notifier.save({ secrets: { token: null } }, { id: ch.id }).secrets).toEqual({ token: { set: false } });
    expect(() => ctx.notifier.save({ kind: 'webhook', config: { url: 'https://x' } }, { id: ch.id })).toThrow(/kind/);
    expect(() =>
      ctx.notifier.save({ kind: 'ntfy', name: 'x', config: { topic: 'bad topic!' }, events: ['approval.pending'] }),
    ).toThrow(/Invalid channel/);
    const audit = ctx.db.select().from(auditLog).where(eq(auditLog.kind, 'config')).all();
    expect(audit.map((a) => a.decision)).toEqual(['notifier_created', 'notifier_updated', 'notifier_updated']);
    expect(JSON.stringify(audit)).not.toContain('tk_secret');
  });

  it('is managed through the Admin API', async () => {
    const { ctx } = await setup();
    const app = createAdminApp(ctx);
    const b = await browser(app).init();
    await b.post('/api/setup', { username: 'admin', password: PASSWORD });
    const created = await b.post('/api/notifiers', {
      kind: 'webhook',
      name: 'Hook',
      config: { url: 'https://hooks.example.com/in' },
      secrets: { hmacSecret: 's3cret' },
      events: ['sync.failed'],
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(await (await b.post(`/api/notifiers/${id}/test`)).json()).toEqual({ ok: true });
    expect(await (await b.patch(`/api/notifiers/${id}`, { enabled: false })).json()).toMatchObject({ enabled: false });
    expect(((await (await b.get('/api/notifiers')).json()) as unknown[]).length).toBe(1);
    expect((await b.del(`/api/notifiers/${id}`)).status).toBe(204);
    expect((await b.post('/api/notifiers', { kind: 'nope' })).status).toBe(400);
  });

  it('signs webhooks, filters by event and instance, and retries server errors', async () => {
    let failures = 2;
    const { ctx, sent } = await setup((req) => (req.url.includes('flaky') && failures-- > 0 ? 503 : 200));
    const hook = ctx.notifier.save({
      kind: 'webhook',
      name: 'Hook',
      config: { url: 'https://hooks.example.com/flaky' },
      secrets: { hmacSecret: 's3cret', headers: { 'x-extra': '1' } },
      events: ['sync.failed'],
    });
    ctx.notifier.save({
      kind: 'webhook',
      name: 'Only other',
      config: { url: 'https://hooks.example.com/other' },
      events: ['sync.failed'],
      instanceFilter: ['someone-else'],
    });
    ctx.events.emit('sync.failed', { instanceId: 'i1', slug: 'nas', error: 'boom' });
    await until(() => sent.length === 3);
    expect(sent.every((s) => s.url.endsWith('/flaky'))).toBe(true);
    const last = sent[2]!;
    const expected = createHmac('sha256', 's3cret')
      .update(`${last.headers['x-hsm-timestamp']}.${last.body}`)
      .digest('hex');
    expect(last.headers['x-hsm-signature']).toBe(`sha256=${expected}`);
    expect(last.headers['x-extra']).toBe('1');
    expect(JSON.parse(last.body)).toMatchObject({
      event: 'sync.failed',
      instance: { slug: 'nas' },
      data: { error: 'boom' },
    });
    await until(
      () => ctx.db.select().from(notifierChannels).where(eq(notifierChannels.id, hook.id)).get()!.lastSentAt !== null,
    );

    // Client errors are not retried and are recorded on the channel.
    const { ctx: ctx2, sent: sent2 } = await setup(() => 404);
    const bad = ctx2.notifier.save({ kind: 'ntfy', name: 'x', config: { topic: 't' }, events: ['auth.lockout'] });
    expect(await ctx2.notifier.test(bad.id)).toEqual({ ok: false, error: 'HTTP 404' });
    expect(sent2).toHaveLength(1);
    expect(ctx2.notifier.list()[0]).toMatchObject({ lastError: 'HTTP 404' });
  });

  it('publishes ntfy JSON with approve/deny links for pending approvals', async () => {
    const { ctx, sent } = await setup();
    ctx.notifier.save({
      kind: 'ntfy',
      name: 'Phone',
      config: { server: 'https://ntfy.example.com/', topic: 'homelab' },
      secrets: { token: 'tk' },
      events: ['approval.pending', 'sync.pending_review'],
    });
    ctx.events.emit('sync.completed', { instanceId: 'i', slug: 'nas', added: 0, pendingReview: [], newGroups: [] });
    ctx.events.emit('sync.completed', {
      instanceId: 'i',
      slug: 'nas',
      added: 1,
      pendingReview: ['pool.create'],
      newGroups: [],
    });
    await until(() => sent.length === 1);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ topic: 'homelab', title: '1 new write operation(s) on /nas' });
    expect(sent[0]!.url).toBe('https://ntfy.example.com');
    expect(sent[0]!.headers.authorization).toBe('Bearer tk');

    const { ctx: live, sent: liveSent } = await withApproval();
    const body = JSON.parse(liveSent[0]!.body) as { click: string; actions: { url: string }[]; message: string };
    expect(body.click).toMatch(/^https:\/\/mcp\.example\.com\/a\/[\w-]+$/);
    expect(body.actions.map((a) => a.url)).toHaveLength(2);
    expect(body.message).not.toContain('hunter2');
    void live;
  });
});

/** An echo instance with a pending echo.set approval (no elicitation, so it waits for portal/link). */
async function withApproval(
  code = `return (await echo.call('echo.set', { name: 'tank/a', password: 'hunter2' })).key;`,
) {
  const t = await setup();
  const { ctx } = t;
  await ctx.users.create({ username: 'admin', password: PASSWORD });
  ctx.notifier.save({ kind: 'ntfy', name: 'Phone', config: { topic: 'homelab' }, events: ['approval.pending'] });
  const instance = await ctx.instances.create({ pluginId: 'echo', slug: 'echo', connection: {} });
  await ctx.instances.syncNow(instance.id);
  const ops = ctx.db.select().from(operations).where(eq(operations.instanceId, instance.id)).all();
  setGroupLevel(ctx.db, instance.id, 'echo', 'write', {
    acknowledge: ops.filter((o) => o.classification === 'write' && !o.locked).map((o) => o.id),
  });
  updateOperation(ctx.db, instance.id, ops.find((o) => o.key === 'echo.delete')!.id, { lockedOptIn: true });
  const run = executeCode(
    ctx.gateDeps(),
    ctx.instances.runtime(instance.id),
    { client: { kind: 'mcp_client', id: 'claude' } },
    code,
  );
  await until(() => t.sent.length > 0);
  const links = (JSON.parse(t.sent[0]!.body) as { actions: { label: string; url: string }[] }).actions;
  const linkPath = (label: string) => new URL(links.find((a) => a.label.startsWith(label))!.url).pathname;
  return { ...t, run, approvePath: linkPath('Approve'), denyPath: linkPath('Deny') };
}

describe('approval links', () => {
  it('needs a signed-in user and a POST: opening the link alone decides nothing', async () => {
    const t = await withApproval();
    const app = createMcpApp(t.ctx);
    const browse = formBrowser(app);

    const login = await (await browse(t.approvePath)).text();
    expect(login).toContain('Sign in to review this approval request');
    expect(hidden(login, 'continue')).toBe(t.approvePath);
    // Still pending after the GET.
    expect(t.ctx.db.select().from(auditLog).where(eq(auditLog.decidedVia, 'link')).all()).toHaveLength(0);

    const signedIn = await browse('/oauth/login', {
      username: 'admin',
      password: PASSWORD,
      csrf: hidden(login, 'csrf'),
      continue: t.approvePath,
    });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get('location')).toBe(t.approvePath);

    const pageHtml = await (await browse(t.approvePath)).text();
    expect(pageHtml).toContain('echo.set');
    expect(pageHtml).not.toContain('hunter2');
    expect(pageHtml).toContain('Signed in as <strong>admin</strong>');

    // Without the CSRF field the POST is refused.
    expect((await browse(t.approvePath, { decision: 'approve' })).status).toBe(400);
    const done = await browse(t.approvePath, { decision: 'approve', csrf: hidden(pageHtml, 'csrf') });
    expect(await done.text()).toContain('was approved');
    await expect(t.run).resolves.toMatchObject({ ok: true, value: 'echo.set' });
    const audit = t.ctx.db.select().from(auditLog).where(eq(auditLog.decidedVia, 'link')).all();
    expect(audit.map((a) => [a.decision, a.actorId, a.decidedBy])).toEqual([['human-approved', 'claude', 'admin']]);

    // Every link of a decided approval is burnt.
    expect((await browse(t.approvePath)).status).toBe(404);
    expect((await browse(t.denyPath)).status).toBe(404);
  });

  it('requires the typed confirmation for locked operations and can deny', async () => {
    const t = await withApproval(`return (await echo.call('echo.delete', { name: 'tank/x' })).key;`);
    const app = createMcpApp(t.ctx);
    const browse = formBrowser(app);
    const login = await (await browse(t.denyPath)).text();
    await browse('/oauth/login', {
      username: 'admin',
      password: PASSWORD,
      csrf: hidden(login, 'csrf'),
      continue: t.denyPath,
    });
    const pageHtml = await (await browse(t.denyPath)).text();
    expect(pageHtml).toContain('Type <code>tank/x</code> to approve');
    const csrf = hidden(pageHtml, 'csrf');
    const wrong = await browse(t.denyPath, { decision: 'approve', confirm: 'nope', csrf });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('exactly to approve');
    expect(await (await browse(t.denyPath, { decision: 'deny', csrf })).text()).toContain('was denied');
    await expect(t.run).resolves.toMatchObject({ ok: false });
  });

  it('rejects unknown tokens', async () => {
    const { ctx } = await setup();
    const app = createMcpApp(ctx);
    expect((await app.request('/a/not-a-real-token-at-all-000000')).status).toBe(404);
    expect((await app.request('/a/short')).status).toBe(404);
  });
});
