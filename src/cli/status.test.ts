/**
 * Tests for src/cli/status.ts — CLI status command.
 *
 * Uses in-memory SQLite via bun:sqlite with full migrations applied.
 * Mocks resolveDbPath by using the DB path directly via fetchPlans.
 *
 * Tests:
 * 1. Empty DB → prints "no plans" message
 * 2. Single plan executing → shows plan with correct counts
 * 3. Multiple plans different statuses → grouped output in correct order
 * 4. --json flag → valid JSON output
 * 5. --status executing filter → only executing plans
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../db/migrations.ts";
import { runStatus } from "./status.ts";

let db: Database;
let dbPath: string;

/** Create a test plan directly in DB. */
function insertPlan(
  id: string,
  slug: string,
  title: string,
  status: string,
  createdAt: number = Date.now(),
  sessionId: string | null = null,
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO plans (id, slug, title, status, priority, created_at, updated_at, session_id, overview, complexity, created_by, updated_by, metadata)
     VALUES (?, ?, ?, ?, 2, ?, ?, ?, 'test', 3, 'test', 'test', '{}')`,
  ).run(id, slug, title, status, createdAt, now, sessionId);
}

/** Insert a task for a plan. */
function insertTask(id: string, planId: string, orderIndex: number, status: string): void {
  db.query(
    `INSERT INTO plan_tasks (id, plan_id, order_index, description, agent, files, complexity, status, created_by, updated_by, metadata)
     VALUES (?, ?, ?, 'test task', 'test', '[]', 3, ?, 'test', 'test', '{}')`,
  ).run(id, planId, orderIndex, status);
}

/** Capture console output during a function call. */
function captureConsole(fn: () => void): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { stdout, stderr };
}

// We need to test runStatus which resolves DB path internally.
// Strategy: create a temp DB file, mock resolveDbPath or test via
// the exported fetchPlans-like behavior. Since runStatus uses resolveDbPath
// which looks for .ndomo/state.db, we'll create a temp dir structure.
//
// Actually, simpler: we'll import the module and test the exported runStatus
// by creating a real .ndomo/state.db in a temp dir and changing cwd.
// But bun:test doesn't easily allow that. Instead, we'll test by
// creating the DB at the project root .ndomo/state.db path.
// Since tests run in the project root, this works if we clean up.
//
// BETTER APPROACH: refactor status.ts to export fetchPlans so we can test
// with in-memory DB directly. But the task says to test runStatus.
// We'll use a temp file DB and mock process.cwd.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ndomo-status-"));
  const ndomoDir = join(tmpDir, ".ndomo");
  mkdirSync(ndomoDir, { recursive: true });
  dbPath = join(ndomoDir, "state.db");
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
});

describe("status CLI", () => {
  test("empty DB prints 'no plans found'", () => {
    db.close();
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { stdout } = captureConsole(() => runStatus([]));
      expect(stdout).toContain("no plans found");
    } finally {
      process.chdir(origCwd);
    }
  });

  test("single executing plan shows correct counts", () => {
    const planId = crypto.randomUUID();
    insertPlan(planId, "test-plan", "Test Plan", "executing");
    insertTask(crypto.randomUUID(), planId, 0, "done");
    insertTask(crypto.randomUUID(), planId, 1, "running");
    insertTask(crypto.randomUUID(), planId, 2, "pending");
    db.close();

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { stdout } = captureConsole(() => runStatus([]));
      expect(stdout).toContain("executing");
      expect(stdout).toContain("1/3 done");
      expect(stdout).toContain("Test Plan");
    } finally {
      process.chdir(origCwd);
    }
  });

  test("multiple plans grouped by status in correct order", () => {
    const now = Date.now();
    insertPlan(crypto.randomUUID(), "plan-a", "Plan A", "executing", now - 1000);
    insertPlan(crypto.randomUUID(), "plan-b", "Plan B", "approved", now - 2000);
    insertPlan(crypto.randomUUID(), "plan-c", "Plan C", "draft", now - 3000);
    insertPlan(crypto.randomUUID(), "plan-d", "Plan D", "completed", now - 4000);
    db.close();

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { stdout } = captureConsole(() => runStatus([]));
      // Check order: executing before approved before draft before completed
      const execIdx = stdout.indexOf("executing");
      const apprIdx = stdout.indexOf("approved");
      const draftIdx = stdout.indexOf("draft");
      const compIdx = stdout.indexOf("completed");
      expect(execIdx).toBeGreaterThan(-1);
      expect(apprIdx).toBeGreaterThan(execIdx);
      expect(draftIdx).toBeGreaterThan(apprIdx);
      expect(compIdx).toBeGreaterThan(draftIdx);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("--json flag outputs valid JSON", () => {
    const planId = crypto.randomUUID();
    insertPlan(planId, "json-plan", "JSON Plan", "executing");
    insertTask(crypto.randomUUID(), planId, 0, "done");
    db.close();

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { stdout } = captureConsole(() => runStatus(["--json"]));
      const parsed = JSON.parse(stdout);
      expect(parsed.executing).toBeDefined();
      expect(parsed.executing).toHaveLength(1);
      expect(parsed.executing[0].slug).toBe("json-plan");
      expect(parsed.executing[0].taskDone).toBe(1);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("--status executing filter shows only executing plans", () => {
    const now = Date.now();
    insertPlan(crypto.randomUUID(), "exec-plan", "Exec Plan", "executing", now - 1000);
    insertPlan(crypto.randomUUID(), "appr-plan", "Appr Plan", "approved", now - 2000);
    insertPlan(crypto.randomUUID(), "draft-plan", "Draft Plan", "draft", now - 3000);
    db.close();

    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { stdout } = captureConsole(() => runStatus(["--status", "executing"]));
      expect(stdout).toContain("executing");
      expect(stdout).not.toContain("approved");
      expect(stdout).not.toContain("draft");
    } finally {
      process.chdir(origCwd);
    }
  });
});
