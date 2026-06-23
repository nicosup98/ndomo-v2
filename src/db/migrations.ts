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

/**
 * v15: backfill — rename finding keys inside analyses.findings_json.
 *
 * - description     → observation
 * - recommendation  → proposedAction
 *
 * Idempotent: rows already renamed are skipped (presence of `observation`
 * key signals the rename has already happened for that finding). Returns
 * the number of findings renamed.
 *
 * Pure data migration — no DDL. Safe to call repeatedly.
 */
export function backfillAnalysisFindings(db: Database): number {
  const rows = db
    .query("SELECT id, findings_json FROM analyses")
    .all() as Array<{ id: string; findings_json: string }>;

  let renamed = 0;
  const txn = db.transaction(() => {
    for (const row of rows) {
      let findings: unknown;
      try {
        findings = JSON.parse(row.findings_json);
      } catch {
        // Skip malformed JSON — leave row untouched
        continue;
      }
      if (!Array.isArray(findings) || findings.length === 0) continue;

      let mutated = false;
      const next = findings.map((f: unknown) => {
        if (f === null || typeof f !== "object") return f;
        const obj = f as Record<string, unknown>;
        // Skip if already renamed
        if ("observation" in obj) return f;

        const renamed_finding: Record<string, unknown> = { ...obj };
        if ("description" in renamed_finding) {
          renamed_finding.observation = renamed_finding.description;
          delete renamed_finding.description;
          mutated = true;
        }
        if ("recommendation" in renamed_finding) {
          renamed_finding.proposedAction = renamed_finding.recommendation;
          delete renamed_finding.recommendation;
          mutated = true;
        }
        return renamed_finding;
      });

      if (mutated) {
        renamed += next.length;
        db.query("UPDATE analyses SET findings_json = ? WHERE id = ?").run(
          JSON.stringify(next),
          row.id,
        );
      }
    }
  });
  txn();
  return renamed;
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

        // v15: backfill finding keys (description→observation, recommendation→proposedAction)
        // Data-only migration — runs in same transaction so a failure rolls back the
        // schema_version insert (which would otherwise leave an inconsistent state).
        if (m.version === 15) {
          backfillAnalysisFindings(db);
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
