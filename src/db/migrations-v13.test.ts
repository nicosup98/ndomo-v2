import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { runMigrations } from "./migrations.ts"
import { MIGRATIONS } from "./schema.ts"

describe("migration v13 — ops tables (T2)", () => {
  let db: Database
  beforeEach(() => {
    db = new Database(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
  })

  test("applies v13 and sets schema_version=13", () => {
    runMigrations(db)
    const row = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number }
    expect(row.v).toBe(13)
  })

  test("all 5 ops tables exist", () => {
    runMigrations(db)
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('environments','releases','deployments','incidents','rollback_executions') ORDER BY name").all() as Array<{ name: string }>
    expect(tables.map(t => t.name)).toEqual(["deployments", "environments", "incidents", "releases", "rollback_executions"])
  })

  test("idempotent — running migrations twice is a no-op", () => {
    runMigrations(db)
    const v1 = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number }
    runMigrations(db) // second run
    const v2 = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number }
    expect(v2).toEqual(v1)
    // Verify no duplicate schema_version rows
    const count = db.query("SELECT COUNT(*) as c FROM schema_version WHERE version=13").get() as { c: number }
    expect(count.c).toBe(1)
  })

  test("environments table has expected columns", () => {
    runMigrations(db)
    const cols = db.query("PRAGMA table_info(environments)").all() as Array<{ name: string }>
    const names = cols.map(c => c.name)
    expect(names).toContain("id")
    expect(names).toContain("name")
    expect(names).toContain("slug")
    expect(names).toContain("description")
    expect(names).toContain("metadata")
    expect(names).toContain("created_at")
    expect(names).toContain("updated_at")
    expect(names).toContain("archived_at")
  })

  test("releases table has expected columns", () => {
    runMigrations(db)
    const cols = db.query("PRAGMA table_info(releases)").all() as Array<{ name: string }>
    const names = cols.map(c => c.name)
    expect(names).toContain("id")
    expect(names).toContain("version")
    expect(names).toContain("title")
    expect(names).toContain("notes")
    expect(names).toContain("created_at")
    expect(names).toContain("archived_at")
  })

  test("deployments table has FK to releases + environments", () => {
    runMigrations(db)
    const fks = db.query("PRAGMA foreign_key_list(deployments)").all() as Array<{ table: string }>
    const tables = fks.map(f => f.table)
    expect(tables).toContain("releases")
    expect(tables).toContain("environments")
  })

  test("incidents table has FK to deployments (triggered_by_deployment_id)", () => {
    runMigrations(db)
    const fks = db.query("PRAGMA foreign_key_list(incidents)").all() as Array<{ table: string; from: string }>
    const depFk = fks.find(f => f.table === "deployments")
    expect(depFk).toBeDefined()
    expect(depFk?.from).toBe("triggered_by_deployment_id")
  })

  test("rollback_executions has FKs to deployments + incidents", () => {
    runMigrations(db)
    const fks = db.query("PRAGMA foreign_key_list(rollback_executions)").all() as Array<{ table: string; from: string }>
    const tables = fks.map(f => f.table)
    expect(tables).toContain("deployments")
    expect(tables).toContain("incidents")
    // Should have 2 FKs to deployments (deployment_id + new_deployment_id)
    const depFks = fks.filter(f => f.table === "deployments")
    expect(depFks.length).toBe(2)
  })

  test("indices exist on key columns", () => {
    runMigrations(db)
    const indices = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as Array<{ name: string }>
    const names = indices.map(i => i.name)
    expect(names).toContain("idx_environments_slug")
    expect(names).toContain("idx_releases_version")
    expect(names).toContain("idx_deployments_status")
    expect(names).toContain("idx_incidents_severity")
    expect(names).toContain("idx_rollbacks_deployment")
  })

  test("CHECK constraints enforce severity enum", () => {
    runMigrations(db)
    // Insert valid severity
    db.query("INSERT INTO incidents (id, title, severity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("i1", "test", "sev1", "open", Date.now(), Date.now())
    // Invalid severity should fail
    expect(() => {
      db.query("INSERT INTO incidents (id, title, severity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("i2", "test", "sev5", "open", Date.now(), Date.now())
    }).toThrow()
  })

  test("CHECK constraints enforce incident status enum", () => {
    runMigrations(db)
    expect(() => {
      db.query("INSERT INTO incidents (id, title, severity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("i3", "test", "sev1", "invalid_status", Date.now(), Date.now())
    }).toThrow()
  })

  test("CHECK constraints enforce rollback status enum", () => {
    runMigrations(db)
    // Need a deployment first for FK
    db.query("INSERT INTO environments (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("e1", "prod", "prod", Date.now(), Date.now())
    db.query("INSERT INTO releases (id, version, title, created_at) VALUES (?, ?, ?, ?)").run("r1", "1.0.0", "rel", Date.now())
    db.query("INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)").run("d1", "r1", "e1", "planned", Date.now())
    expect(() => {
      db.query("INSERT INTO rollback_executions (id, deployment_id, status, plan, created_at) VALUES (?, ?, ?, ?, ?)").run("rb1", "d1", "invalid_status", "plan", Date.now())
    }).toThrow()
  })

  test("FK constraint — cannot insert deployment with non-existent release", () => {
    runMigrations(db)
    db.query("INSERT INTO environments (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("e1", "prod", "prod", Date.now(), Date.now())
    expect(() => {
      db.query("INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)").run("d1", "nonexistent", "e1", "planned", Date.now())
    }).toThrow()
  })

  test("v13 is the last entry in MIGRATIONS array", () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1]
    expect(last).toBeDefined()
    expect(last!.version).toBe(13)
  })
})
