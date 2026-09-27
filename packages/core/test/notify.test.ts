import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { auditLog, notifierChannels } from '../src/db/schema.js';
import { createAdminApp } from '../src/http/admin-app.js';
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
  const dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-notify-'));
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

describe('notification channels', () => {
  it('stores secrets encrypted, reports only whether they are set, and merges updates', async () => {
    const { ctx } = await setup();
    const ch = ctx.notifier.save({
      kind: 'ntfy',
      name: 'Phone',
      config: { topic: 'homelab' },
      secrets: { token: 'tk_secret' },
      events: ['instance.error'],
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
      ctx.notifier.save({ kind: 'ntfy', name: 'x', config: { topic: 'bad topic!' }, events: ['instance.error'] }),
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
      .update(`${last.headers['x-synoikia-timestamp']}.${last.body}`)
      .digest('hex');
    expect(last.headers['x-synoikia-signature']).toBe(`sha256=${expected}`);
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

  it('publishes ntfy JSON, and has no approval events or links', async () => {
    const { ctx, sent } = await setup();
    ctx.notifier.save({
      kind: 'ntfy',
      name: 'Phone',
      config: { server: 'https://ntfy.example.com/', topic: 'homelab' },
      secrets: { token: 'tk' },
      events: ['sync.pending_review'],
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
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      topic: 'homelab',
      title: '1 write operation(s) to review on /nas',
    });
    expect(sent[0]!.url).toBe('https://ntfy.example.com');
    expect(sent[0]!.headers.authorization).toBe('Bearer tk');

    expect(JSON.parse(sent[0]!.body)).not.toHaveProperty('actions');

    // Rules a sync disabled are reported even when no write needs review.
    ctx.events.emit('sync.completed', {
      instanceId: 'i',
      slug: 'nas',
      added: 0,
      pendingReview: [],
      newGroups: [],
      rulesDisabled: 2,
    });
    await until(() => sent.length === 2);
    expect(JSON.parse(sent[1]!.body)).toMatchObject({ title: 'Pre-approval rules disabled on /nas' });
    expect(JSON.parse(sent[1]!.body).message).toMatch(/2 pre-approval rule\(s\) no longer fit/);

    // Approvals happen in the MCP client (design §5.3); channels can't subscribe to them.
    expect(() =>
      ctx.notifier.save({ kind: 'ntfy', name: 'x', config: { topic: 't' }, events: ['approval.pending'] }),
    ).toThrow(/Invalid channel/);
    // A channel saved before that change keeps working; the stale event is dropped.
    const old = ctx.notifier.save({ kind: 'ntfy', name: 'Old', config: { topic: 't' }, events: ['auth.lockout'] });
    ctx.db
      .update(notifierChannels)
      .set({ events: ['approval.pending', 'auth.lockout'] })
      .where(eq(notifierChannels.id, old.id))
      .run();
    expect(ctx.notifier.list().find((c) => c.id === old.id)?.events).toEqual(['auth.lockout']);
    expect(ctx.notifier.save({ name: 'Old 2' }, { id: old.id }).events).toEqual(['auth.lockout']);
  });
});
