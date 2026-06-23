/**
 * ndomo DB — SQLite client factory.
 *
 * Creates a project-level database in `.ndomo/state.db`.
 * Uses bun:sqlite (built-in, zero deps).
 *
 * NOTE on "async" terminology: bun:sqlite ops are SYNCHRONOUS (no async I/O).
 * In ndomo architecture, "async" refers to inter-agent coordination via DB
 * state + manual TUI switch between primaries (foreman↔craftsman), NOT to
 * async database I/O. All db.exec / db.prepare / stmt.run calls are sync.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const NDOMO_DIR = ".ndomo";
const DB_FILE = "state.db";

export function openDb(projectDir: string): Database {
  // Defensive validation: reject paths that would place .ndomo at the
  // filesystem root (e.g. projectDir="/" → "/.ndomo" → EACCES) or relative
  // paths that resolve against CWD unpredictably. See plan
  // 4dc34202 (harden-open-db-path-validation).
  if (projectDir === "" || projectDir === "/" || !isAbsolute(projectDir)) {
    throw new Error(
      `openDb: invalid projectDir ${JSON.stringify(projectDir)} — must be a non-root absolute path (e.g. /home/user/project). Received "/" or a relative path would create ".ndomo" at the filesystem root or an unpredictable CWD-relative location.`,
    );
  }
  const dir = join(projectDir, NDOMO_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DB_FILE);
  const db = new Database(path, { create: true });
  // Enable foreign key enforcement (OFF by default in SQLite/bun:sqlite)
  db.exec("PRAGMA foreign_keys = ON");
  // INCREMENTAL auto_vacuum — reclaims space from deleted rows on demand via
  // PRAGMA incremental_vacuum (run by `ndomo vacuum` CLI). Prevents unbounded
  // growth of .ndomo/state.db on long-running installs (audit fcb12dc5 #4).
  // NOTE: must be set BEFORE journal_mode = WAL — SQLite/bun:sqlite silently
  // ignores auto_vacuum when set after WAL is enabled on a fresh DB. Empirically
  // confirmed via /tmp/test-combo.ts (2026-06-23, plan fcb12dc5).
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  // WAL journal mode — better concurrency, persistent across opens (sticky
  // in DB file). For long-running installs this prevents the .ndomo/state.db
  // from blocking readers while a writer is active.
  db.exec("PRAGMA journal_mode = WAL");
  // NORMAL synchronous — safe with WAL (durability on checkpoint, not on every
  // commit). Faster than FULL on write-heavy workloads.
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

export function closeDb(db: Database): void {
  db.close();
}
