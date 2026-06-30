import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { runMigrations } from "./migrations.ts"
import { MIGRATIONS } from "./schema.ts"

describe("migration v16 — plans.owner (ADR-010)", () => {
  let db: Database
  beforeEach(() => {
    db = new Database(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
  })

  test("applies v16 and sets schema_version=16 (latest)", () => {
    runMigrations(db)
    const row = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number }
    expect(row.v).toBe(16)
  })

  test("plans.owner column exists with default 'foreman'", () => {
    runMigrations(db)
    const cols = db.query("PRAGMA table_info(plans)").all() as Array<{ name: string; dflt_value: string | null }>
    const owner = cols.find(c => c.name === "owner")
    expect(owner).toBeDefined()
    expect(owner!.dflt_value).toBe("'foreman'")
  })

  test("v16 is the last entry in MIGRATIONS array", () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1]
    expect(last).toBeDefined()
    expect(last!.version).toBe(16)
  })

  test("idempotent — running migrations twice is a no-op", () => {
    runMigrations(db)
    const v1 = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number }
    runMigrations(db)
    const v2 = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number }
    expect(v2).toEqual(v1)
    const count = db.query("SELECT COUNT(*) as c FROM schema_version WHERE version=16").get() as { c: number }
    expect(count.c).toBe(1)
  })

  test("plans.owner accepts valid enum values", () => {
    runMigrations(db)
    const now = Date.now()
    db.query("INSERT INTO plans (id, slug, title, status, priority, owner, overview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("p1", "s1", "t1", "draft", 2, "foreman", "test", now, now)
    db.query("INSERT INTO plans (id, slug, title, status, priority, owner, overview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("p2", "s2", "t2", "draft", 2, "craftsman", "test", now, now)
    db.query("INSERT INTO plans (id, slug, title, status, priority, owner, overview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("p3", "s3", "t3", "draft", 2, "warden", "test", now, now)
    const rows = db.query("SELECT id, owner FROM plans ORDER BY id").all() as Array<{ id: string; owner: string }>
    expect(rows.length).toBe(3)
    expect(rows.map(r => r.owner).sort()).toEqual(["craftsman", "foreman", "warden"])
  })

  test("plans.owner accepts arbitrary string (CHECK deferred to app layer — document this)", () => {
    // KNOWN LIMITATION: SQLite ALTER TABLE ADD COLUMN cannot include CHECK constraint.
    // Validation is enforced at app layer (T1 CLI, T2 HTTP). This test documents the
    // current behavior so future migrations (v17+) can tighten it via table rebuild.
    runMigrations(db)
    const now = Date.now()
    db.query("INSERT INTO plans (id, slug, title, status, priority, owner, overview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("px", "sx", "tx", "draft", 2, "unknown_agent", "test", now, now)
    const row = db.query("SELECT owner FROM plans WHERE id=?").get("px") as { owner: string }
    expect(row.owner).toBe("unknown_agent")
  })

  test("existing plans get default 'foreman' after migration", () => {
    // Test the column default by omitting owner in INSERT.
    runMigrations(db)
    const now = Date.now()
    db.query("INSERT INTO plans (id, slug, title, status, priority, overview, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("p_default", "default-test", "test", "draft", 2, "test", now, now)
    const row = db.query("SELECT owner FROM plans WHERE id=?").get("p_default") as { owner: string }
    expect(row.owner).toBe("foreman")
  })
})
