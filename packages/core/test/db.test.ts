import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { settings } from '../src/db/schema.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('applies the migrations and enables foreign keys', () => {
    const db = openDatabase(':memory:');
    const tables = db.$client
      .prepare("select name from sqlite_master where type = 'table' and name not like '\\_%' escape '\\'")
      .pluck()
      .all();
    expect(tables).toEqual(
      expect.arrayContaining(['users', 'plugins', 'plugin_instances', 'operations', 'operation_groups', 'audit_log']),
    );
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('persists to DATA_DIR and is idempotent across reopen', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'synoikia-db-'));
    dirs.push(dataDir);
    const first = openDatabase({ dataDir });
    first
      .insert(settings)
      .values({ key: 'k', value: { a: 1 } })
      .run();
    first.$client.close();

    const second = openDatabase({ dataDir });
    expect(second.select().from(settings).all()).toEqual([{ key: 'k', value: { a: 1 } }]);
    expect(second.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    second.$client.close();
  });
});
