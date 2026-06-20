/**
 * ndomo DB — Migration runner.
 *
 * Reads MIGRATIONS from schema.ts, compares against schema_version,
 * and applies pending migrations in a transaction.
 */

import type { Database } from "bun:sqlite";
import { MIGRATIONS } from "./schema.ts";

/**
 * Add a column to a table if it doesn't already exist.
 * Uses PRAGMA table_info to check — the only reliable idempotent pattern
 * for SQLite 3.45 which lacks ALTER TABLE ADD COLUMN IF NOT EXISTS.
 */
function addColumnIfMissing(db: Database, table: string, column: string, type: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function runMigrations(db: Database): void {
  // Ensure schema_version table exists first
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);",
  );

  // Get current version
  const row = db
    .query<{ version: number }, []>("SELECT MAX(version) as version FROM schema_version")
    .get();
  const current = row?.version ?? 0;

  // Apply pending migrations
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      const txn = db.transaction(() => {
        // v5: add archived_at columns BEFORE running SQL that creates indexes
        // on those columns. SQLite 3.45 lacks ADD COLUMN IF NOT EXISTS, so we
        // check PRAGMA table_info first (addColumnIfMissing helper).
        if (m.version === 5) {
          addColumnIfMissing(db, "plans", "archived_at", "INTEGER");
          addColumnIfMissing(db, "plan_tasks", "archived_at", "INTEGER");
          addColumnIfMissing(db, "sessions", "archived_at", "INTEGER");
        }

        // v6: write-once audit trail — original_plan_data on plans + plan_tasks
        if (m.version === 6) {
          addColumnIfMissing(db, "plans", "original_plan_data", "TEXT");
          addColumnIfMissing(db, "plan_tasks", "original_plan_data", "TEXT");
        }

        // v8: agent execution tracking on plans
        if (m.version === 8) {
          addColumnIfMissing(db, "plans", "created_by_agent", "TEXT");
          addColumnIfMissing(db, "plans", "executed_by_agent", "TEXT");
          addColumnIfMissing(db, "plans", "executed_by_session", "TEXT");
        }

        // Execute SQL only if it contains actual statements (not just comments)
        const hasStatements = m.sql.split("\n").some((line) => {
          const trimmed = line.trim();
          return trimmed.length > 0 && !trimmed.startsWith("--");
        });
        if (hasStatements) {
          db.exec(m.sql);
        }

        db.query(
          "INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)",
        ).run(m.version, Date.now(), m.description);
      });
      txn();
    }
  }
}
