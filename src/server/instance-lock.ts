import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** SQLite OS locking survives process crashes without stale PID-file guessing. */
export function acquireInstanceLock(databasePath: string): () => void {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(`${databasePath}.instance`);
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch {
    db.close();
    throw new Error('instance_running');
  }
  return () => db.close();
}
