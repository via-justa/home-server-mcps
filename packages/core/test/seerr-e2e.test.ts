import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppContext } from '../src/app.js';
import type { AppContext } from '../src/app.js';
import type { ClientPrompts } from '../src/approvals/service.js';
import { setGroupLevel, updateOperation } from '../src/catalog/groups.js';
import { createRule } from '../src/catalog/rules.js';
import { loadConfig } from '../src/config/env.js';
import { auditLog, operations } from '../src/db/schema.js';
import type { CallerContext } from '../src/gate/pipeline.js';
import { executeCode } from '../src/runtime/index.js';
import { FAKE_EMAIL, FAKE_PASSWORD, startFakeSeerr } from '../../../plugins/seerr/test/fake-seerr.js';
import type { FakeSeerr } from '../../../plugins/seerr/test/fake-seerr.js';

/**
 * The real core running the built Seerr plugin (a permission-confined child) against a fake Seerr
 * over HTTP, spec included (design §13 phase 18). Skipped until `pnpm build` has produced the bundle.
 */

const PLUGINS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins');
const BUILT = existsSync(path.join(PLUGINS, 'seerr/dist/index.js'));

let ctx: AppContext;
let fake: FakeSeerr;
let dataDir: string;
let instanceId: string;

beforeAll(async () => {
  if (!BUILT) return;
  fake = await startFakeSeerr();
  dataDir = mkdtempSync(path.join(tmpdir(), 'hsm-seerr-'));
  ctx = await createAppContext(
    loadConfig({ DATA_DIR: dataDir, CORE_PLUGINS_DIR: PLUGINS, CORE_PLUGINS_AUTOENABLE: 'true' }),
    { memoryDb: true, supervisor: { initTimeoutMs: 5000, rpcTimeoutMs: 10_000 } },
  );
  instanceId = (
    await ctx.instances.create({
      pluginId: 'seerr',
      slug: 'seerr',
      connection: {
        baseUrl: fake.url,
        authMethod: 'local',
        email: FAKE_EMAIL,
        password: FAKE_PASSWORD,
        specBaseUrl: fake.specUrl,
      },
    })
  ).id;
  await ctx.instances.syncNow(instanceId);
}, 30_000);

afterAll(async () => {
  await ctx?.stop();
  await fake?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const opId = (key: string) =>
  ctx.db
    .select()
    .from(operations)
    .where(and(eq(operations.instanceId, instanceId), eq(operations.key, key)))
    .get()!.id;

/** Runs `execute` code as an MCP client whose user decides approvals with `decide`. */
function run(code: string, decide?: (approvalId: string, message: string) => void) {
  const prompts: ClientPrompts | undefined = decide
    ? {
        url: async (req) => {
          setTimeout(() => decide(req.approvalId, req.message), 10);
          return { action: 'accept' };
        },
      }
    : undefined;
  const caller: CallerContext = { client: { kind: 'mcp_client', id: 'e2e' }, principal: { ceiling: 'write' }, prompts };
  return executeCode(ctx.gateDeps(), ctx.instances.runtime(instanceId), caller, code);
}

describe.skipIf(!BUILT)('Seerr plugin end to end (fake Seerr)', () => {
  it('syncs the spec for the instance version into groups that start at Read', () => {
    const rows = ctx.db.select().from(operations).where(eq(operations.instanceId, instanceId)).all();
    expect(rows.length).toBe(215);
    expect(rows.find((o) => o.key === 'GET /settings/discover/reset')).toMatchObject({ locked: true });
    expect(rows.find((o) => o.key === 'POST /request/{requestId}/{status}#on-behalf')).toMatchObject({
      locked: true,
      typedConfirmation: true,
    });
    expect(ctx.instances.get(instanceId)).toMatchObject({
      upstreamVersion: '3.4.1',
      sourceRef: 'v3.4.1',
      lastSyncStatus: 'ok',
    });
  });

  it('runs reads at Read, redacts settings secrets, and hides writes', async () => {
    await expect(run(`return (await seerr.request({ path: '/movie/603' })).title;`)).resolves.toMatchObject({
      ok: true,
      value: 'The Matrix',
    });
    const settings = await run(
      `return await Promise.all(['/settings/main', '/settings/notifications/telegram', '/settings/notifications/webhook', '/settings/radarr'].map((path) => seerr.request({ path })));`,
    );
    for (const s of [
      'seerr-main-api-key-123',
      'tg-bot-secret-456',
      'hooks.example/secret-789',
      'hook-secret-000',
      'radarr-key-111',
    ])
      expect(JSON.stringify(settings)).not.toContain(s);
    expect(settings).toMatchObject({
      ok: true,
      value: [
        { applicationTitle: 'Home Seerr', apiKey: '[REDACTED]' },
        { options: { botAPI: '[REDACTED]', chatId: '42' } },
        { options: { webhookUrl: '[REDACTED]', authHeader: '[REDACTED]' } },
        [{ name: 'Radarr 4K', apiKey: '[REDACTED]' }],
      ],
    });
    await expect(
      run(
        `return await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 1 } });`,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_DISABLED' } });
  });

  it('asks for a media request at Ask and runs it once a human approves', async () => {
    setGroupLevel(ctx.db, instanceId, 'request', 'ask');
    const shown: string[] = [];
    const r = await run(
      `return (await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 550 } })).media;`,
      (id, message) => {
        shown.push(message);
        ctx.approvals.decide(id, { approve: true, decidedBy: 'admin' });
      },
    );
    expect(r).toMatchObject({ ok: true, value: { mediaType: 'movie', tmdbId: 550 } });
    expect(shown[0]).toContain('Seerr POST /request {"mediaType":"movie","mediaId":550}');
  });

  it('auto-approves standard-quality requests under a media-request rule, and asks for 4K', async () => {
    const rt = ctx.instances.runtime(instanceId);
    createRule(ctx.db, rt.manifest, instanceId, {
      operationId: opId('POST /request'),
      match: [
        { field: '/body/is4k', op: 'bool', value: false },
        { field: '/body/mediaType', op: 'in', value: ['movie'] },
        { field: '/body/mediaId', op: 'any' },
      ],
      reason: 'standard movie requests',
    });
    const standard = await run(
      `return (await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 551, is4k: false } })).is4k;`,
    );
    expect(standard).toMatchObject({ ok: true, value: false });
    // 4K doesn't match the rule, so a human is asked (and here, nobody can be).
    const uhd = await run(
      `return await seerr.request({ method: 'POST', path: '/request', body: { mediaType: 'movie', mediaId: 552, is4k: true } });`,
    );
    expect(uhd).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const audit = ctx.db.select().from(auditLog).where(eq(auditLog.operationKey, 'POST /request')).all();
    expect(audit.map((a) => a.decision)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^auto-approved:rule:/), 'human-approved', 'denied']),
    );
  });

  it("needs the requester's name typed to approve someone else's request (locked)", async () => {
    updateOperation(ctx.db, instanceId, opId('POST /request/{requestId}/{status}#on-behalf'), { level: 'ask' });
    const attempts: string[] = [];
    const r = await run(
      `return (await seerr.request({ method: 'POST', path: '/request/7/approve' })).status;`,
      (id) => {
        try {
          ctx.approvals.decide(id, { approve: true, confirm: '7', decidedBy: 'admin' });
        } catch (err) {
          attempts.push((err as Error).message);
          ctx.approvals.decide(id, { approve: true, confirm: 'Alex', decidedBy: 'admin' });
        }
      },
    );
    expect(attempts[0]).toMatch(/Type "Alex" exactly/);
    expect(r).toMatchObject({ ok: true, value: 2 });
    // Approving the plugin's own request is the ordinary key, which is at Ask via the group.
    const own = await run(
      `return (await seerr.request({ method: 'POST', path: '/request/8/approve' })).status;`,
      (id) => ctx.approvals.decide(id, { approve: true, decidedBy: 'admin' }),
    );
    expect(own).toMatchObject({ ok: true, value: 2 });
  });

  it('reports a Seerr permission denial as UPSTREAM_DENIED', async () => {
    fake.denied.add('/settings/main');
    await expect(run(`return await seerr.request({ path: '/settings/main' });`)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UPSTREAM_DENIED' },
    });
    fake.denied.delete('/settings/main');
  });
});
