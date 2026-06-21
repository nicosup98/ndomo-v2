/**
 * ndomo DB — Incident CRUD with transition validation.
 *
 * All functions take a Database instance and return camelCase TS types.
 */

import type { Database } from "bun:sqlite"
import { incidentFromRow, type Incident, type IncidentSeverity, type IncidentStatus, type InsertIncident } from "./types.ts"

const MAX_TEXT_BYTES = 16 * 1024

function truncateText(s: string): string {
  if (s.length <= MAX_TEXT_BYTES) return s
  return `${s.slice(0, MAX_TEXT_BYTES)}…[truncated]`
}

const VALID_SEVERITIES: IncidentSeverity[] = ["sev1", "sev2", "sev3", "sev4"]
const VALID_STATUSES: IncidentStatus[] = ["open", "triaging", "mitigated", "resolved", "postmortem"]

// Valid transitions: forward only, no backward
const VALID_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  open: ["triaging", "mitigated", "resolved"],
  triaging: ["mitigated", "resolved"],
  mitigated: ["resolved"],
  resolved: ["postmortem"],
  postmortem: [], // terminal
}

export function createIncident(
  db: Database,
  input: InsertIncident,
): Incident {
  if (!VALID_SEVERITIES.includes(input.severity)) {
    throw new Error(`ndomo: invalid incident severity '${input.severity}' (must be sev1-4)`)
  }
  const title = input.title.trim()
  if (title.length === 0) throw new Error("ndomo: incident title cannot be empty")
  const summary = input.summary ? truncateText(input.summary.trim()) : null
  if (input.triggeredByDeploymentId) {
    const dep = db.query("SELECT id FROM deployments WHERE id = ?").get(input.triggeredByDeploymentId)
    if (!dep) throw new Error(`ndomo: deployment '${input.triggeredByDeploymentId}' not found (FK violation)`)
  }
  const id = crypto.randomUUID()
  const now = Date.now()
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null
  db.query(
    `INSERT INTO incidents (id, title, severity, status, summary, triggered_by_deployment_id, created_at, updated_at, resolved_at, metadata)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, NULL, ?)`,
  ).run(id, title, input.severity, summary, input.triggeredByDeploymentId ?? null, now, now, metadata)
  return getIncident(db, id)!
}

export function getIncident(db: Database, id: string): Incident | null {
  const row = db.query("SELECT * FROM incidents WHERE id = ?").get(id)
  return row ? incidentFromRow(row) : null
}

export function listIncidents(
  db: Database,
  opts?: { status?: IncidentStatus; severity?: IncidentSeverity; limit?: number },
): Incident[] {
  const limit = opts?.limit ?? 100
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (opts?.status) { clauses.push("status = ?"); params.push(opts.status) }
  if (opts?.severity) { clauses.push("severity = ?"); params.push(opts.severity) }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
  params.push(limit)
  const rows = db.query(`SELECT * FROM incidents ${where} ORDER BY created_at DESC LIMIT ?`).all(...params)
  return rows.map(incidentFromRow)
}

export function updateIncidentStatus(
  db: Database,
  id: string,
  newStatus: IncidentStatus,
): Incident {
  const current = getIncident(db, id)
  if (!current) throw new Error(`ndomo: incident '${id}' not found`)
  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`ndomo: invalid incident status '${newStatus}'`)
  }
  const currentStatus = current.status
  if (currentStatus === newStatus) return current // no-op
  const allowed = VALID_TRANSITIONS[currentStatus]
  if (!allowed.includes(newStatus)) {
    throw new Error(`ndomo: invalid incident transition '${currentStatus}' → '${newStatus}' (allowed: ${allowed.join(", ") || "none (terminal)"})`)
  }
  const now = Date.now()
  const resolvedAt = newStatus === "resolved" || newStatus === "postmortem" ? now : current.resolvedAt
  db.query("UPDATE incidents SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?").run(newStatus, now, resolvedAt, id)
  return getIncident(db, id)!
}
