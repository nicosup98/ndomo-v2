/**
 * Tests for plan_files join table (v7 migration).
 *
 * Validates:
 * - Insert and query plan_files
 * - CASCADE delete when plan is deleted
 * - Composite primary key (plan_id, file_path)
 *
 * Uses in-memory SQLite via bun:sqlite. Each test gets a fresh DB
 * with the full schema applied by runMigrations.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { createPlan, deletePlan } from "./plans.ts";
import type { Plan } from "./types.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

function makePlan(overrides: Partial<Parameters<typeof createPlan>[1]> = {}): Plan {
  return createPlan(db, {
    id: crypto.randomUUID(),
    slug: "test-plan",
    title: "Test",
    status: "draft",
    priority: 2,
    approvedAt: null,
    completedAt: null,
    sessionId: null,
    overview: "test",
    approach: null,
    complexity: 3,
    createdBy: "test",
    updatedBy: "test",
    sourceSessionId: null,
    sourceMessageId: null,
    category: null,
    metadata: {},
    archivedAt: null,
    ...overrides,
  });
}

describe("plan_files", () => {
  test("insert and query plan files", () => {
    const plan = makePlan();

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/index.ts",
      "input",
    );

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "README.md",
      "reference",
    );

    const rows = db
      .query("SELECT * FROM plan_files WHERE plan_id = ? ORDER BY file_path")
      .all(plan.id) as Array<{ plan_id: string; file_path: string; role: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.file_path).toBe("README.md");
    expect(rows[0]?.role).toBe("reference");
    expect(rows[1]?.file_path).toBe("src/index.ts");
    expect(rows[1]?.role).toBe("input");
  });

  test("multi-role inserts allowed (same file_path, different roles)", () => {
    const plan = makePlan();

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/index.ts",
      "input",
    );

    // v10: same file_path with different role is ALLOWED (multi-role PK)
    expect(() => {
      db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
        plan.id,
        "src/index.ts",
        "output",
      );
    }).not.toThrow();

    // Both rows exist
    const rows = db
      .query("SELECT * FROM plan_files WHERE plan_id = ? AND file_path = ?")
      .all(plan.id, "src/index.ts") as Array<{ role: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.role).sort()).toEqual(["input", "output"]);
  });

  test("CASCADE delete removes plan_files when plan is deleted", () => {
    const plan = makePlan({ status: "approved" });

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/index.ts",
      "input",
    );

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "README.md",
      "reference",
    );

    // Verify files exist
    const before = db
      .query("SELECT COUNT(*) as count FROM plan_files WHERE plan_id = ?")
      .get(plan.id) as { count: number };
    expect(before.count).toBe(2);

    // Delete plan — CASCADE should remove plan_files
    deletePlan(db, plan.id, { confirm: true });

    // Verify files are gone
    const after = db
      .query("SELECT COUNT(*) as count FROM plan_files WHERE plan_id = ?")
      .get(plan.id) as { count: number };
    expect(after.count).toBe(0);
  });

  test("default role is 'input'", () => {
    const plan = makePlan();

    db.query("INSERT INTO plan_files (plan_id, file_path) VALUES (?, ?)").run(
      plan.id,
      "src/utils.ts",
    );

    const row = db
      .query("SELECT role FROM plan_files WHERE plan_id = ? AND file_path = ?")
      .get(plan.id, "src/utils.ts") as { role: string };

    expect(row.role).toBe("input");
  });

  test("multi-role: same file_path with 3 roles all exist", () => {
    const plan = makePlan();

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/main.ts",
      "input",
    );
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/main.ts",
      "modified",
    );
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/main.ts",
      "reviewed",
    );

    const rows = db
      .query("SELECT * FROM plan_files WHERE plan_id = ? AND file_path = ?")
      .all(plan.id, "src/main.ts") as Array<{ role: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.role).sort()).toEqual(["input", "modified", "reviewed"]);
  });

  test("created_at column auto-populated on insert", () => {
    const plan = makePlan();
    // strftime('%s','now')*1000 has second-precision (ends in 000ms)
    // so floor before to second boundary for comparison
    const beforeSec = Math.floor(Date.now() / 1000) * 1000;

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/test.ts",
      "input",
    );

    const afterSec = Math.ceil(Date.now() / 1000) * 1000;

    const row = db
      .query("SELECT created_at FROM plan_files WHERE plan_id = ? AND file_path = ?")
      .get(plan.id, "src/test.ts") as { created_at: number };

    expect(row.created_at).toBeGreaterThanOrEqual(beforeSec);
    expect(row.created_at).toBeLessThanOrEqual(afterSec);
  });

  test("query by role filter returns only matching rows", () => {
    const plan = makePlan();

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/a.ts",
      "input",
    );
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/a.ts",
      "modified",
    );
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/b.ts",
      "modified",
    );
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/c.ts",
      "reviewed",
    );

    const modified = db
      .query("SELECT * FROM plan_files WHERE plan_id = ? AND role = ?")
      .all(plan.id, "modified") as Array<{ file_path: string }>;
    expect(modified).toHaveLength(2);
    expect(modified.map((r) => r.file_path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("duplicate (plan_id, file_path, role) triple still throws", () => {
    const plan = makePlan();

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/main.ts",
      "input",
    );

    // Same triple insert should throw (PK violation)
    expect(() => {
      db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
        plan.id,
        "src/main.ts",
        "input",
      );
    }).toThrow();
  });

  test("CASCADE delete removes all role rows for plan files", () => {
    const plan = makePlan({ status: "approved" });

    // Insert same file with 3 roles
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/main.ts",
      "input",
    );
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/main.ts",
      "modified",
    );
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/main.ts",
      "reviewed",
    );
    // Insert different file
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "README.md",
      "reference",
    );

    // Verify 4 rows exist
    const before = db
      .query("SELECT COUNT(*) as count FROM plan_files WHERE plan_id = ?")
      .get(plan.id) as { count: number };
    expect(before.count).toBe(4);

    // Delete plan — CASCADE should remove all plan_files
    deletePlan(db, plan.id, { confirm: true });

    // Verify all gone
    const after = db
      .query("SELECT COUNT(*) as count FROM plan_files WHERE plan_id = ?")
      .get(plan.id) as { count: number };
    expect(after.count).toBe(0);
  });
});
