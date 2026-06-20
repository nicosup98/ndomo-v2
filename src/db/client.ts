/**
 * ndomo DB — SQLite client factory.
 *
 * Creates a project-level database in `.ndomo/state.db`.
 * Uses bun:sqlite (built-in, zero deps).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const NDOMO_DIR = ".ndomo";
const DB_FILE = "state.db";

export function openDb(projectDir: string): Database {
  const dir = join(projectDir, NDOMO_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DB_FILE);
  const db = new Database(path, { create: true });
  // Enable foreign key enforcement (OFF by default in SQLite/bun:sqlite)
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function closeDb(db: Database): void {
  db.close();
}
