import { describe, expect, it } from 'vitest';
import { writeAudit } from '../src/audit.js';
import { auditCsvChunks, exportAuditCsv } from '../src/audit-query.js';
import { openDatabase } from '../src/db/index.js';

describe('audit CSV export (review L21)', () => {
  it('streams every matching row once, in pages, newest first, even with equal timestamps', () => {
    const db = openDatabase(':memory:');
    const base = Date.UTC(2026, 0, 1);
    db.transaction((tx) => {
      for (let i = 0; i < 2500; i++) {
        // Runs of 7 rows share a timestamp, so page boundaries fall inside ties.
        writeAudit(
          tx,
          { kind: i % 2 ? 'call' : 'config', actorKind: 'system', decision: `d${i}` },
          new Date(base + Math.floor(i / 7) * 1000),
        );
      }
    });

    const chunks = [...auditCsvChunks(db, {})];
    expect(chunks.length).toBe(4); // header + 3 pages of up to 1000
    const lines = chunks.join('').trimEnd().split('\n');
    expect(lines[0]).toMatch(/^id,at,kind,/);
    const ids = lines.slice(1).map((l) => Number(l.split(',')[0]));
    expect(ids).toHaveLength(2500);
    expect(new Set(ids).size).toBe(2500);
    // Newest first; within a timestamp, highest id first.
    expect(ids[0]).toBe(2500);
    expect(ids.at(-1)).toBe(1);

    const calls = exportAuditCsv(db, { kind: 'call' }).trimEnd().split('\n');
    expect(calls).toHaveLength(1 + 1250);
  });
});
