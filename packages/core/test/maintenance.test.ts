import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppContext } from '../src/app.js';
import { currentStep, totpAt } from '../src/auth/totp.js';
import { rotateMasterKeyCommand } from '../src/cli.js';
import { loadConfig } from '../src/config/env.js';
import { acquireServerLock, LOCK_FILENAME } from '../src/lock.js';
import { auditLog, preApprovalHits, sessions } from '../src/db/schema.js';
import { runHousekeeping } from '../src/maintenance.js';
import { updateSettings } from '../src/settings.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');
const PASSWORD = 'correct horse battery';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function env(dataDir: string, extra: Record<string, string> = {}) {
  return { DATA_DIR: dataDir, CORE_PLUGINS_DIR: PLUGINS, CORE_PLUGINS_AUTOENABLE: 'true', ...extra };
}

async function open(dataDir: string, extra: Record<string, string> = {}, now?: () => Date) {
  const ctx = await createAppContext(loadConfig(env(dataDir, extra)), { now });
  return ctx;
}

describe('housekeeping', () => {
  it('purges expired state and applies audit retention only when configured', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'hsm-maint-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    let now = new Date(); // audit rows are stamped with the real clock
    const ctx = await open(dataDir, {}, () => now);
    cleanup.push(() => ctx.stop());
    const user = await ctx.users.create({ username: 'admin', password: PASSWORD });
    ctx.sessions.create(user.id, 'admin', { idleMs: 60_000, absoluteMs: 60_000 }, {});
    const rule = { id: 'r1' };
    ctx.db.$client.exec(`PRAGMA foreign_keys = OFF`);
    ctx.db.insert(preApprovalHits).values({ ruleId: rule.id, occurredAt: now }).run();
    ctx.db.$client.exec(`PRAGMA foreign_keys = ON`);
    const auditBefore = ctx.db.select().from(auditLog).all().length;

    now = new Date(now.getTime() + 30 * 86_400_000);
    expect(runHousekeeping(ctx)).toMatchObject({ sessions: 1, preApprovalHits: 1, audit: 0 });
    expect(ctx.db.select().from(sessions).all()).toHaveLength(0);
    expect(ctx.db.select().from(auditLog).all().length).toBe(auditBefore);

    updateSettings(ctx.db, 'audit', { retentionDays: 7 }, {});
    const res = runHousekeeping(ctx);
    expect(res.audit).toBeGreaterThanOrEqual(auditBefore);
    const left = ctx.db.select().from(auditLog).all();
    expect(left.map((a) => a.decision)).toContain('audit_purged');
    expect(left.every((a) => a.at.getTime() > now.getTime() - 7 * 86_400_000)).toBe(true);
  });
});

describe('rotate-master-key', () => {
  async function seeded(extra: Record<string, string> = {}) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'hsm-rotate-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const ctx = await open(dataDir, extra);
    const user = await ctx.users.create({ username: 'admin', password: PASSWORD });
    const { secret } = ctx.users.beginTotp(user.id);
    const inst = await ctx.instances.create({ pluginId: 'echo', slug: 'echo', connection: { token: 'tok-123' } });
    const ch = ctx.notifier.save({
      kind: 'ntfy',
      name: 'n',
      config: { topic: 't' },
      secrets: { token: 'nt' },
      events: ['auth.lockout'],
    });
    ctx.sessions.create(user.id, 'admin', { idleMs: 60_000, absoluteMs: 60_000 }, {});
    await ctx.stop();
    return { dataDir, userId: user.id, secret, instanceId: inst.id, channelId: ch.id };
  }

  it('re-encrypts every secret under a new key file, keeping them readable', async () => {
    const s = await seeded();
    const keyFile = path.join(s.dataDir, 'master.key');
    const before = readFileSync(keyFile, 'utf8');
    const lines: string[] = [];
    const result = rotateMasterKeyCommand(env(s.dataDir), (l) => lines.push(l));
    expect(result).toEqual({ users: 1, oidc: 0, instances: 1, notifiers: 1, sessionsCleared: 1 });
    expect(readFileSync(keyFile, 'utf8')).not.toBe(before);
    expect(existsSync(`${keyFile}.new`)).toBe(false);
    expect(lines.join('\n')).toContain('Re-encrypted 1 endpoint connection(s)');

    const ctx = await open(s.dataDir);
    cleanup.push(() => ctx.stop());
    expect(ctx.instances.getConnection(s.instanceId).secrets).toMatchObject({ token: { set: true } });
    expect(ctx.notifier.list()[0]!.secrets).toEqual({ token: { set: true } });
    expect(ctx.users.confirmTotp(s.userId, totpAt(s.secret, currentStep()))).toHaveLength(10);
  });

  it('refuses to run while a server holds the data directory (review L8)', async () => {
    const s = await seeded();
    const keyFile = path.join(s.dataDir, 'master.key');
    const before = readFileSync(keyFile, 'utf8');
    // Stand-in for a running server: a live process named in the lock file.
    const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = new Promise((r) => server.once('exit', r));
    cleanup.push(() => server.kill());
    const lock = path.join(s.dataDir, LOCK_FILENAME);
    writeFileSync(lock, JSON.stringify({ pid: server.pid, host: hostname(), startedAt: new Date().toISOString() }));

    expect(() => rotateMasterKeyCommand(env(s.dataDir), () => undefined)).toThrow(/server is running/);
    expect(() => acquireServerLock(s.dataDir)).toThrow(/Another server/);
    expect(readFileSync(keyFile, 'utf8')).toBe(before);

    // Once it has stopped, the stale lock doesn't block anything.
    server.kill();
    await exited;
    expect(rotateMasterKeyCommand(env(s.dataDir), () => undefined)).toMatchObject({ instances: 1 });
    const release = acquireServerLock(s.dataDir);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: process.pid });
    release();
    expect(existsSync(lock)).toBe(false);
  });

  it('with MASTER_KEY in the environment, requires NEW_MASTER_KEY and changes nothing on a wrong key', async () => {
    const oldKey = randomBytes(32).toString('base64');
    const s = await seeded({ MASTER_KEY: oldKey });
    expect(() => rotateMasterKeyCommand(env(s.dataDir, { MASTER_KEY: oldKey }), () => undefined)).toThrow(
      /NEW_MASTER_KEY/,
    );

    const newKey = randomBytes(32).toString('base64');
    const wrong = randomBytes(32).toString('base64');
    expect(() =>
      rotateMasterKeyCommand(env(s.dataDir, { MASTER_KEY: wrong, NEW_MASTER_KEY: newKey }), () => undefined),
    ).toThrow(/decrypt/);
    // Still readable with the old key: the failed run changed nothing.
    const still = await open(s.dataDir, { MASTER_KEY: oldKey });
    expect(still.instances.getConnection(s.instanceId).secrets).toMatchObject({ token: { set: true } });
    await still.stop();

    rotateMasterKeyCommand(env(s.dataDir, { MASTER_KEY: oldKey, NEW_MASTER_KEY: newKey }), () => undefined);
    expect(existsSync(path.join(s.dataDir, 'master.key'))).toBe(false);
    const ctx = await open(s.dataDir, { MASTER_KEY: newKey });
    cleanup.push(() => ctx.stop());
    expect(ctx.notifier.list()[0]!.secrets).toEqual({ token: { set: true } });
    const row = ctx.db.select().from(auditLog).where(eq(auditLog.kind, 'config')).all();
    expect(row.length).toBeGreaterThan(0);
  });
});
