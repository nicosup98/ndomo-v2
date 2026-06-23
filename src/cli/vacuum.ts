#!/usr/bin/env bun
/**
 * ndomo vacuum — reclaims disk space from .ndomo/state.db.
 *
 * Plan fcb12dc5 #4: post-PRAGMA retention sweep. Runs:
 *   1. PRAGMA incremental_vacuum — reclaims pages freed by deleted rows
 *   2. PRAGMA wal_checkpoint(TRUNCATE) — truncates WAL to main DB file
 *
 * Usage:
 *   bun run src/cli/vacuum.ts [projectDir]
 *
 * If projectDir is omitted, defaults to current working directory.
 *
 * For long-running installs, the plugin auto-finalizes background_tasks
 * terminal rows on init (see plugin.ts backgroundRetention config). The
 * vacuum CLI complements that by reclaiming the freed disk pages.
 *
 * One-time retrofit for pre-existing DBs: this script first sets
 * PRAGMA auto_vacuum = INCREMENTAL (idempotent for already-configured
 * DBs) before vacuuming so subsequent deletes are auto-reclaimed.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeDb, openDb } from "../db/client.ts";

export interface VacuumResult {
  pagesReclaimed: number;
  checkpoint: { busy: number; log: number; checkpointed: number } | null;
  sizeBefore: number;
  sizeAfter: number;
}

/**
 * Pure vacuum routine — opens DB at projectDir, applies incremental vacuum +
 * WAL checkpoint, closes. Exported for testability (CLI wrapper below).
 */
export function vacuumProject(projectDir: string): VacuumResult {
  const dbPath = join(projectDir, ".ndomo", "state.db");
  if (!existsSync(dbPath)) {
    throw new Error(`no .ndomo/state.db at ${dbPath}`);
  }
  const sizeBefore = statSync(dbPath).size;

  const db = openDb(projectDir);
  try {
    // Retrofit auto_vacuum for pre-existing DBs (no-op for already-configured).
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");

    // Step 1: incremental vacuum — reclaims pages freed by deleted rows.
    let totalFreed = 0;
    while (true) {
      const result = db.query("PRAGMA incremental_vacuum").get() as {
        incremental_vacuum: number;
      } | null;
      const freed = result?.incremental_vacuum ?? 0;
      if (freed === 0) break;
      totalFreed += freed;
    }

    // Step 2: WAL checkpoint — flush WAL to main DB and truncate WAL file.
    const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    } | null;

    const sizeAfter = statSync(dbPath).size;
    return {
      pagesReclaimed: totalFreed,
      checkpoint,
      sizeBefore,
      sizeAfter,
    };
  } finally {
    closeDb(db);
  }
}

// CLI entry — only runs when invoked directly (not when imported by tests).
const isMain =
  typeof import.meta.main === "boolean"
    ? import.meta.main
    : (process.argv[1]?.endsWith("vacuum.ts") ?? false);
if (isMain) {
  const projectDir = process.argv[2] ?? process.cwd();
  const dbPath = join(projectDir, ".ndomo", "state.db");
  console.log(`[vacuum] opening ${dbPath}`);
  const result = vacuumProject(projectDir);
  const delta = result.sizeBefore - result.sizeAfter;
  console.log(`[vacuum] incremental_vacuum: reclaimed ${result.pagesReclaimed} pages`);
  console.log(`[vacuum] wal_checkpoint(TRUNCATE): ${JSON.stringify(result.checkpoint)}`);
  console.log(
    `[vacuum] file size: ${result.sizeBefore} → ${result.sizeAfter} bytes (${delta >= 0 ? "-" : "+"}${Math.abs(delta)} bytes)`,
  );
}
