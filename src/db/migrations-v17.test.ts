import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { MIGRATIONS } from "./schema.ts";

/**
 * v17 migration: execution gates.
 *
 * Verifies:
 *  - schema_version moves to 17 after runMigrations
 *  - all 5 verification columns exist on plan_tasks with correct defaults
 *  - migration is idempotent (addColumnIfMissing pattern)
 *  - v17 is the last entry in MIGRATIONS
 *  - CHECK on verification_status is app-layer only (documents the same
 *    SQLite limitation as v16 plans.owner)
 */
describe("migration v17 — plan_tasks verification columns (T1)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
  });

  test("applies all migrations up to v17", () => {
    runMigrations(db);
    const row = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    expect(row.v).toBe(17);
  });

  test("v17 is the last entry in MIGRATIONS array", () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    expect(last).toBeDefined();
    expect(last!.version).toBe(17);
  });

  test("verification_required column exists, default 0, NOT NULL", () => {
    runMigrations(db);
    const cols = db.query("PRAGMA table_info(plan_tasks)").all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
      type: string;
    }>;
    const col = cols.find((c) => c.name === "verification_required");
    expect(col).toBeDefined();
    expect(col!.type).toBe("INTEGER");
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toBe("0");
  });

  test("verification_status column exists, default 'not_required', NOT NULL", () => {
    runMigrations(db);
    const cols = db.query("PRAGMA table_info(plan_tasks)").all() as Array<{
      name: string;
      dflt_value: string | null;
      notnull: number;
      type: string;
    }>;
    const col = cols.find((c) => c.name === "verification_status");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toBe("'not_required'");
  });

  test("verification_result / verification_passed_at / verified_by columns exist (nullable)", () => {
    runMigrations(db);
    const cols = db.query("PRAGMA table_info(plan_tasks)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const result = cols.find((c) => c.name === "verification_result");
    const passedAt = cols.find((c) => c.name === "verification_passed_at");
    const verifiedBy = cols.find((c) => c.name === "verified_by");
    expect(result).toBeDefined();
    expect(passedAt).toBeDefined();
    expect(verifiedBy).toBeDefined();
    // All three should accept NULL (no NOT NULL).
    expect(result!.notnull).toBe(0);
    expect(passedAt!.notnull).toBe(0);
    expect(verifiedBy!.notnull).toBe(0);
  });

  test("idempotent — running migrations twice is a no-op", () => {
    runMigrations(db);
    const v1 = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    runMigrations(db);
    const v2 = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    expect(v2).toEqual(v1);
    const count = db.query("SELECT COUNT(*) as c FROM schema_version WHERE version=17").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  test("existing pre-v17 rows are un-gated by default (verification_required=0)", () => {
    runMigrations(db);
    const now = Date.now();
    // Insert a plan first (FK target).
    db.query(
      "INSERT INTO plans (id, slug, title, status, priority, overview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "s1", "t1", "draft", 2, "test", now, now);
    // Insert a task omitting all verification columns. metadata='{}' avoids
    // tripping the v4 trg_tasks_metadata_default trigger during raw INSERT.
    db.query(
      `INSERT INTO plan_tasks (id, plan_id, order_index, description, agent, files, complexity, status, dependencies, created_by, updated_by, metadata)
       VALUES (?, ?, ?, ?, ?, '[]', 1, 'pending', '[]', ?, ?, '{}')`,
    ).run("tk1", "p1", 0, "legacy task", "smith", "cli", "cli");

    const row = db
      .query("SELECT verification_required, verification_status FROM plan_tasks WHERE id=?")
      .get("tk1") as {
      verification_required: number;
      verification_status: string;
    };
    expect(row.verification_required).toBe(0);
    expect(row.verification_status).toBe("not_required");
  });

  test("CHECK on verification_status is app-layer only (SQLite ADD COLUMN limitation)", () => {
    // KNOWN LIMITATION: SQLite ALTER TABLE ADD COLUMN cannot include CHECK.
    // Same constraint as v16 plans.owner. Validation is enforced in
    // recordTaskVerification (src/db/tasks.ts). This test documents the
    // current behavior so a future v18 table-rebuild can tighten it.
    runMigrations(db);
    const now = Date.now();
    db.query(
      "INSERT INTO plans (id, slug, title, status, priority, overview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("p2", "s2", "t2", "draft", 2, "test", now, now);
    db.query(
      `INSERT INTO plan_tasks (id, plan_id, order_index, description, agent, files, complexity, status, dependencies, created_by, updated_by, metadata, verification_status)
       VALUES (?, ?, ?, ?, ?, '[]', 1, 'pending', '[]', ?, ?, '{}', 'bogus_status')`,
    ).run("tk2", "p2", 0, "test", "smith", "cli", "cli");
    const row = db.query("SELECT verification_status FROM plan_tasks WHERE id=?").get("tk2") as {
      verification_status: string;
    };
    // DB accepts any string — recordTaskVerification + taskFromRow sanitize it.
    expect(row.verification_status).toBe("bogus_status");
  });
});
