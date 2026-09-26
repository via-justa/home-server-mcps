import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

/**
 * A running server holds `DATA_DIR/server.lock` (pid and host). Offline operator commands such as
 * `rotate-master-key` refuse to run while it is held: a live server keeps the old master key in memory
 * and would write secrets under it after the rotation (design §7.1).
 */

export const LOCK_FILENAME = 'server.lock';

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

const lockPath = (dataDir: string) => path.join(dataDir, LOCK_FILENAME);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The live holder of the lock, or null if it is free or stale (dead pid, other host or container). */
export function lockHolder(dataDir: string): LockInfo | null {
  let info: LockInfo;
  try {
    info = JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as LockInfo;
  } catch {
    return null;
  }
  if (typeof info?.pid !== 'number' || info.host !== hostname() || info.pid === process.pid) return null;
  return alive(info.pid) ? info : null;
}

/** Takes the lock for this process; throws if another live server holds it. Returns the release. */
export function acquireServerLock(dataDir: string): () => void {
  const holder = lockHolder(dataDir);
  if (holder) throw new Error(`Another server (pid ${holder.pid}) is using ${dataDir}`);
  const info: LockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  writeFileSync(lockPath(dataDir), `${JSON.stringify(info)}\n`, { mode: 0o600 });
  return () => {
    try {
      const current = JSON.parse(readFileSync(lockPath(dataDir), 'utf8')) as LockInfo;
      if (current.pid === process.pid) rmSync(lockPath(dataDir), { force: true });
    } catch {
      // already gone
    }
  };
}

/** For offline commands: throws while a server is running on this data directory. */
export function assertServerStopped(dataDir: string) {
  const holder = lockHolder(dataDir);
  if (holder) {
    throw new Error(
      `The server is running (pid ${holder.pid}, since ${holder.startedAt}); stop it first. ` +
        `If it is not running, delete ${lockPath(dataDir)}.`,
    );
  }
}
