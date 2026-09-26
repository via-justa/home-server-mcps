import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { openDatabase } from '../src/db/index.js';
import { pluginInstances, settings } from '../src/db/schema.js';
import { getSettings } from '../src/settings.js';

const PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

describe('stored settings from an earlier release (review L22)', () => {
  it('reads a field the schema now rejects as its default, and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = openDatabase(':memory:');
    db.insert(settings)
      .values({ key: 'mcp', value: { accessTokenTtlMinutes: 1, allowDynamicRegistration: false, retired: 'x' } })
      .run();
    expect(getSettings(db, 'mcp')).toMatchObject({ accessTokenTtlMinutes: 60, allowDynamicRegistration: false });
    expect(warn.mock.calls.flat().join('\n')).toMatch(/settings\.mcp: ignoring stored accessTokenTtlMinutes/);
  });

  it('normalizes stored JSON at startup without writing defaults in, and keeps endpoints serving', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dataDir = mkdtempSync(path.join(tmpdir(), 'hsm-lenient-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const env = { DATA_DIR: dataDir, CORE_PLUGINS_DIR: PLUGINS, CORE_PLUGINS_AUTOENABLE: 'true' };

    const first = await createAppContext(loadConfig(env));
    const inst = await first.instances.create({ pluginId: 'echo', slug: 'echo', connection: {} });
    // As if an older release had stored values the current schemas reject.
    first.db
      .update(pluginInstances)
      .set({ settings: { executePerMinute: 0, sandbox: { timeoutMs: 5, memoryMb: 32 }, writesPerMinute: 7 } })
      .where(eq(pluginInstances.id, inst.id))
      .run();
    first.db
      .insert(settings)
      .values({ key: 'security', value: { sessionIdleMinutes: 1, requireTotp: true } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { sessionIdleMinutes: 1, requireTotp: true } } })
      .run();
    await first.stop();

    const ctx = await createAppContext(loadConfig(env));
    cleanup.push(() => ctx.stop());
    const stored = ctx.db.select().from(pluginInstances).where(eq(pluginInstances.id, inst.id)).get()!.settings;
    expect(stored).toEqual({ sandbox: { memoryMb: 32 }, writesPerMinute: 7 });
    expect(ctx.db.select().from(settings).where(eq(settings.key, 'security')).get()!.value).toEqual({
      requireTotp: true,
    });
    expect(ctx.instances.runtime(inst.id).settings).toMatchObject({
      executePerMinute: 30,
      writesPerMinute: 7,
      sandbox: { timeoutMs: 10_000, memoryMb: 32 },
    });
    // An unrelated change saves fine.
    await ctx.instances.update(inst.id, { settings: { approvalTimeoutMs: 60_000 } });
    expect(ctx.instances.runtime(inst.id).settings).toMatchObject({
      approvalTimeoutMs: 60_000,
      writesPerMinute: 7,
      sandbox: { memoryMb: 32 },
    });
  });
});
