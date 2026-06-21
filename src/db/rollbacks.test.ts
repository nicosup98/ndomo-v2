import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { createIncident } from "./incidents.ts"
import { runMigrations } from "./migrations.ts"
import { getRollback, listRollbacksForDeployment, listRollbacksForIncident, recordRollback } from "./rollbacks.ts"

function createTestDeployment(db: Database, id = "d1"): string {
  const now = Date.now()
  db.query("INSERT OR IGNORE INTO environments (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("e1", "prod", "prod", now, now)
  db.query("INSERT OR IGNORE INTO releases (id, version, title, created_at) VALUES (?, ?, ?, ?)").run("r1", "1.0.0", "rel", now)
  db.query("INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)").run(id, "r1", "e1", "planned", now)
  return id
}

describe("rollbacks.ts", () => {
  let db: Database
  beforeEach(() => {
    db = new Database(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
    runMigrations(db)
  })

  describe("recordRollback", () => {
    test("happy path — defaults to status=planned", () => {
      createTestDeployment(db)
      const rb = recordRollback(db, { deploymentId: "d1", plan: "Revert to previous version" })
      expect(rb.id).toBeTruthy()
      expect(rb.deploymentId).toBe("d1")
      expect(rb.status).toBe("planned")
      expect(rb.plan).toBe("Revert to previous version")
      expect(rb.incidentId).toBeNull()
      expect(rb.newDeploymentId).toBeNull()
      expect(rb.executedAt).toBeNull()
      expect(rb.createdAt).toBeGreaterThan(0)
    })

    test("with explicit status", () => {
      createTestDeployment(db)
      const rb = recordRollback(db, { deploymentId: "d1", plan: "Approved rollback", status: "approved" })
      expect(rb.status).toBe("approved")
    })

    test("with metadata", () => {
      createTestDeployment(db)
      const rb = recordRollback(db, { deploymentId: "d1", plan: "Meta test", metadata: { reason: "regression" } })
      expect(rb.metadata).toEqual({ reason: "regression" })
    })

    test("throws on invalid status", () => {
      createTestDeployment(db)
      expect(() => recordRollback(db, { deploymentId: "d1", plan: "Bad", status: "invalid" as any })).toThrow("invalid rollback status")
    })

    test("throws on empty plan (whitespace only)", () => {
      createTestDeployment(db)
      expect(() => recordRollback(db, { deploymentId: "d1", plan: "   " })).toThrow("rollback plan cannot be empty")
    })

    test("trims plan", () => {
      createTestDeployment(db)
      const rb = recordRollback(db, { deploymentId: "d1", plan: "  trimmed  " })
      expect(rb.plan).toBe("trimmed")
    })

    test("truncates plan >16KB", () => {
      createTestDeployment(db)
      const bigPlan = "x".repeat(20_000)
      const rb = recordRollback(db, { deploymentId: "d1", plan: bigPlan })
      expect(rb.plan.length).toBeLessThan(20_000)
      expect(rb.plan).toContain("…[truncated]")
    })

    test("FK validation — non-existent deployment_id throws", () => {
      expect(() => recordRollback(db, { deploymentId: "nonexistent", plan: "test" })).toThrow("deployment 'nonexistent' not found")
    })

    test("FK validation — non-existent incident_id throws", () => {
      createTestDeployment(db)
      expect(() => recordRollback(db, { deploymentId: "d1", plan: "test", incidentId: "nonexistent" })).toThrow("incident 'nonexistent' not found")
    })

    test("FK validation — non-existent new_deployment_id throws", () => {
      createTestDeployment(db)
      expect(() => recordRollback(db, { deploymentId: "d1", plan: "test", newDeploymentId: "nonexistent" })).toThrow("new_deployment 'nonexistent' not found")
    })

    test("with valid incident_id", () => {
      createTestDeployment(db)
      const inc = createIncident(db, { title: "Test incident", severity: "sev1" })
      const rb = recordRollback(db, { deploymentId: "d1", plan: "Rollback for incident", incidentId: inc.id })
      expect(rb.incidentId).toBe(inc.id)
    })

    test("with valid new_deployment_id", () => {
      createTestDeployment(db, "d1")
      createTestDeployment(db, "d2")
      const rb = recordRollback(db, { deploymentId: "d1", plan: "Roll forward", newDeploymentId: "d2" })
      expect(rb.newDeploymentId).toBe("d2")
    })
  })

  describe("getRollback", () => {
    test("returns existing rollback", () => {
      createTestDeployment(db)
      const created = recordRollback(db, { deploymentId: "d1", plan: "Find me" })
      const found = getRollback(db, created.id)
      expect(found).not.toBeNull()
      expect(found!.plan).toBe("Find me")
    })

    test("returns null for non-existent id", () => {
      expect(getRollback(db, "nonexistent")).toBeNull()
    })
  })

  describe("listRollbacksForIncident", () => {
    test("returns rollbacks linked to incident", () => {
      createTestDeployment(db)
      const inc = createIncident(db, { title: "Inc", severity: "sev1" })
      recordRollback(db, { deploymentId: "d1", plan: "RB1", incidentId: inc.id })
      recordRollback(db, { deploymentId: "d1", plan: "RB2", incidentId: inc.id })
      recordRollback(db, { deploymentId: "d1", plan: "RB3", incidentId: inc.id })
      const rbs = listRollbacksForIncident(db, inc.id)
      expect(rbs.length).toBe(3)
    })

    test("returns empty for incident with no rollbacks", () => {
      createTestDeployment(db)
      const inc = createIncident(db, { title: "Empty", severity: "sev1" })
      const rbs = listRollbacksForIncident(db, inc.id)
      expect(rbs.length).toBe(0)
    })
  })

  describe("listRollbacksForDeployment", () => {
    test("returns rollbacks for deployment", () => {
      createTestDeployment(db)
      recordRollback(db, { deploymentId: "d1", plan: "RB1" })
      recordRollback(db, { deploymentId: "d1", plan: "RB2" })
      const rbs = listRollbacksForDeployment(db, "d1")
      expect(rbs.length).toBe(2)
    })

    test("returns empty for deployment with no rollbacks", () => {
      createTestDeployment(db)
      const rbs = listRollbacksForDeployment(db, "d1")
      expect(rbs.length).toBe(0)
    })
  })
})
