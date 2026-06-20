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

  test("composite primary key prevents duplicates", () => {
    const plan = makePlan();

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/index.ts",
      "input",
    );

    // Duplicate insert should fail
    expect(() => {
      db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
        plan.id,
        "src/index.ts",
        "output",
      );
    }).toThrow();
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
});
