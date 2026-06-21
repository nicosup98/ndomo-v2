import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { createIncident, getIncident, listIncidents, updateIncidentStatus } from "./incidents.ts"
import { runMigrations } from "./migrations.ts"

function createTestDeployment(db: Database): string {
  const now = Date.now()
  db.query("INSERT INTO environments (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("e1", "prod", "prod", now, now)
  db.query("INSERT INTO releases (id, version, title, created_at) VALUES (?, ?, ?, ?)").run("r1", "1.0.0", "rel", now)
  db.query("INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)").run("d1", "r1", "e1", "planned", now)
  return "d1"
}

describe("incidents.ts", () => {
  let db: Database
  beforeEach(() => {
    db = new Database(":memory:")
    db.exec("PRAGMA foreign_keys = ON")
    runMigrations(db)
  })

  describe("createIncident", () => {
    test("happy path — creates incident with status=open", () => {
      const inc = createIncident(db, { title: "DB down", severity: "sev1", summary: "Production DB unreachable" })
      expect(inc.id).toBeTruthy()
      expect(inc.title).toBe("DB down")
      expect(inc.severity).toBe("sev1")
      expect(inc.status).toBe("open")
      expect(inc.summary).toBe("Production DB unreachable")
      expect(inc.triggeredByDeploymentId).toBeNull()
      expect(inc.createdAt).toBeGreaterThan(0)
      expect(inc.updatedAt).toBeGreaterThan(0)
      expect(inc.resolvedAt).toBeNull()
    })

    test("creates incident without optional fields", () => {
      const inc = createIncident(db, { title: "Minor issue", severity: "sev4" })
      expect(inc.summary).toBeNull()
      expect(inc.triggeredByDeploymentId).toBeNull()
      expect(inc.metadata).toBeNull()
    })

    test("creates incident with metadata", () => {
      const inc = createIncident(db, { title: "Test", severity: "sev2", metadata: { region: "us-east-1" } })
      expect(inc.metadata).toEqual({ region: "us-east-1" })
    })

    test("throws on invalid severity", () => {
      expect(() => createIncident(db, { title: "Bad", severity: "sev5" as any })).toThrow("invalid incident severity")
    })

    test("throws on empty title (whitespace only)", () => {
      expect(() => createIncident(db, { title: "   ", severity: "sev1" })).toThrow("title cannot be empty")
    })

    test("trims title", () => {
      const inc = createIncident(db, { title: "  spaced  ", severity: "sev1" })
      expect(inc.title).toBe("spaced")
    })

    test("truncates summary >16KB", () => {
      const bigSummary = "x".repeat(20_000)
      const inc = createIncident(db, { title: "Big", severity: "sev1", summary: bigSummary })
      expect(inc.summary!.length).toBeLessThan(20_000)
      expect(inc.summary!).toContain("…[truncated]")
    })

    test("FK validation — triggeredByDeploymentId non-existent throws", () => {
      expect(() => createIncident(db, { title: "FK test", severity: "sev1", triggeredByDeploymentId: "nonexistent" })).toThrow("deployment 'nonexistent' not found")
    })

    test("FK validation — valid triggeredByDeploymentId succeeds", () => {
      createTestDeployment(db)
      const inc = createIncident(db, { title: "Dep linked", severity: "sev2", triggeredByDeploymentId: "d1" })
      expect(inc.triggeredByDeploymentId).toBe("d1")
    })
  })

  describe("getIncident", () => {
    test("returns existing incident", () => {
      const created = createIncident(db, { title: "Find me", severity: "sev3" })
      const found = getIncident(db, created.id)
      expect(found).not.toBeNull()
      expect(found!.title).toBe("Find me")
    })

    test("returns null for non-existent id", () => {
      expect(getIncident(db, "nonexistent")).toBeNull()
    })
  })

  describe("listIncidents", () => {
    test("returns all incidents", () => {
      createIncident(db, { title: "A", severity: "sev1" })
      createIncident(db, { title: "B", severity: "sev2" })
      const all = listIncidents(db)
      expect(all.length).toBe(2)
    })

    test("filters by severity", () => {
      createIncident(db, { title: "Sev1", severity: "sev1" })
      createIncident(db, { title: "Sev2", severity: "sev2" })
      createIncident(db, { title: "Sev1b", severity: "sev1" })
      const sev1 = listIncidents(db, { severity: "sev1" })
      expect(sev1.length).toBe(2)
      expect(sev1.every(i => i.severity === "sev1")).toBe(true)
    })

    test("filters by status", () => {
      const a = createIncident(db, { title: "A", severity: "sev1" })
      createIncident(db, { title: "B", severity: "sev1" })
      updateIncidentStatus(db, a.id, "triaging")
      const open = listIncidents(db, { status: "open" })
      const triaging = listIncidents(db, { status: "triaging" })
      expect(open.length).toBe(1)
      expect(triaging.length).toBe(1)
    })

    test("respects limit", () => {
      for (let i = 0; i < 5; i++) createIncident(db, { title: `I${i}`, severity: "sev1" })
      const limited = listIncidents(db, { limit: 2 })
      expect(limited.length).toBe(2)
    })
  })

  describe("updateIncidentStatus", () => {
    test("valid transition chain: open→triaging→mitigated→resolved→postmortem", () => {
      const inc = createIncident(db, { title: "Chain", severity: "sev1" })
      expect(inc.status).toBe("open")

      const t1 = updateIncidentStatus(db, inc.id, "triaging")
      expect(t1.status).toBe("triaging")

      const t2 = updateIncidentStatus(db, inc.id, "mitigated")
      expect(t2.status).toBe("mitigated")

      const t3 = updateIncidentStatus(db, inc.id, "resolved")
      expect(t3.status).toBe("resolved")
      expect(t3.resolvedAt).toBeGreaterThan(0)

      const t4 = updateIncidentStatus(db, inc.id, "postmortem")
      expect(t4.status).toBe("postmortem")
    })

    test("open→mitigated (skip triaging) is valid", () => {
      const inc = createIncident(db, { title: "Skip", severity: "sev1" })
      const updated = updateIncidentStatus(db, inc.id, "mitigated")
      expect(updated.status).toBe("mitigated")
    })

    test("open→resolved (skip both) is valid", () => {
      const inc = createIncident(db, { title: "Fast", severity: "sev1" })
      const updated = updateIncidentStatus(db, inc.id, "resolved")
      expect(updated.status).toBe("resolved")
    })

    test("throws on invalid transition: open→postmortem", () => {
      const inc = createIncident(db, { title: "Bad", severity: "sev1" })
      expect(() => updateIncidentStatus(db, inc.id, "postmortem")).toThrow("invalid incident transition")
    })

    test("throws on backward transition: resolved→mitigated", () => {
      const inc = createIncident(db, { title: "Back", severity: "sev1" })
      updateIncidentStatus(db, inc.id, "resolved")
      expect(() => updateIncidentStatus(db, inc.id, "mitigated")).toThrow("invalid incident transition")
    })

    test("sets resolved_at when transitioning to resolved", () => {
      const inc = createIncident(db, { title: "Resolve", severity: "sev1" })
      expect(inc.resolvedAt).toBeNull()
      const updated = updateIncidentStatus(db, inc.id, "resolved")
      expect(updated.resolvedAt).toBeGreaterThan(0)
    })

    test("preserves resolved_at when going to postmortem", () => {
      const inc = createIncident(db, { title: "PM", severity: "sev1" })
      const resolved = updateIncidentStatus(db, inc.id, "resolved")
      const resolvedAt = resolved.resolvedAt!
      const pm = updateIncidentStatus(db, inc.id, "postmortem")
      expect(pm.resolvedAt).toBe(resolvedAt)
    })

    test("no-op when same status", () => {
      const inc = createIncident(db, { title: "Same", severity: "sev1" })
      const same = updateIncidentStatus(db, inc.id, "open")
      expect(same.id).toBe(inc.id)
      expect(same.status).toBe("open")
    })

    test("throws on non-existent incident", () => {
      expect(() => updateIncidentStatus(db, "nonexistent", "triaging")).toThrow("incident 'nonexistent' not found")
    })

    test("postmortem is terminal — no further transitions", () => {
      const inc = createIncident(db, { title: "Terminal", severity: "sev1" })
      updateIncidentStatus(db, inc.id, "resolved")
      updateIncidentStatus(db, inc.id, "postmortem")
      expect(() => updateIncidentStatus(db, inc.id, "resolved")).toThrow("invalid incident transition")
    })
  })
})
