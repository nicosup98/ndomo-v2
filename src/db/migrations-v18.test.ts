import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { MIGRATIONS } from "./schema.ts";

/**
 * v18 migration: routing_events — route decision log (fase 2).
 *
 * Verifies:
 *  - schema_version moves to >= 18 after runMigrations
 *  - exactly one schema_version row for version 18
 *  - routing_events table exists with the full 16-column shape
 *  - the 3 expected indexes exist
 *  - migration is idempotent (CREATE ... IF NOT EXISTS + version guard)
 *  - MIGRATIONS carries the version 18 entry
 *
 * Pure DDL: no addColumnIfMissing special-case in runMigrations() — the
 * generic hasStatements path executes SCHEMA_V18_SQL.
 */
describe("migration v18 — routing_events (fase 2 harness-intelligence)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
  });

  test("applies v18 (and any later migrations) — schema_version >= 18", () => {
    runMigrations(db);
    const row = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    expect(row.v).toBeGreaterThanOrEqual(18);
  });

  test("exactly one schema_version row for version 18", () => {
    runMigrations(db);
    const count = db.query("SELECT COUNT(*) as c FROM schema_version WHERE version=18").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  test("routing_events table exists", () => {
    runMigrations(db);
    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='routing_events' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(["routing_events"]);
  });

  test("routing_events has the expected 16 columns", () => {
    runMigrations(db);
    const cols = db.query("PRAGMA table_info(routing_events)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of [
      "id",
      "created_at",
      "session_id",
      "agent",
      "source",
      "intent",
      "stack",
      "risk",
      "confidence",
      "fallback",
      "explore",
      "task_id",
      "task_status",
      "verification_status",
      "linked_at",
      "link_source",
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.length).toBe(16);
  });

  test("routing_events required columns are NOT NULL / defaulted", () => {
    runMigrations(db);
    const cols = db.query("PRAGMA table_info(routing_events)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("created_at")?.notnull).toBe(1);
    expect(byName.get("agent")?.notnull).toBe(1);
    expect(byName.get("source")?.notnull).toBe(1);
    expect(byName.get("fallback")?.notnull).toBe(1);
    expect(byName.get("fallback")?.dflt_value).toBe("0");
    expect(byName.get("explore")?.notnull).toBe(1);
    expect(byName.get("explore")?.dflt_value).toBe("0");
    expect(byName.get("session_id")?.notnull).toBe(0);
    expect(byName.get("task_id")?.notnull).toBe(0);
    expect(byName.get("confidence")?.type).toBe("REAL");
  });

  test("indexes idx_routing_events_created/agent/task exist", () => {
    runMigrations(db);
    const indices = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_routing_events_%'",
      )
      .all() as Array<{ name: string }>;
    const names = indices.map((i) => i.name);
    expect(names).toContain("idx_routing_events_created");
    expect(names).toContain("idx_routing_events_agent");
    expect(names).toContain("idx_routing_events_task");
    expect(names.length).toBe(3);
  });

  test("idempotent — running migrations twice is a no-op", () => {
    runMigrations(db);
    const v1 = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    runMigrations(db);
    const v2 = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
    expect(v2).toEqual(v1);
    expect(v1.v).toBeGreaterThanOrEqual(18);
    const count = db.query("SELECT COUNT(*) as c FROM schema_version WHERE version=18").get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  test("MIGRATIONS contains version 18", () => {
    const v18 = MIGRATIONS.find((m) => m.version === 18);
    expect(v18).toBeDefined();
    expect(v18?.version).toBe(18);
    expect(v18?.sql).toContain("CREATE TABLE IF NOT EXISTS routing_events");
  });
});
