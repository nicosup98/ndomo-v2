/**
 * ndomo DB — Rollback execution CRUD.
 *
 * All functions take a Database instance and return camelCase TS types.
 */

import type { Database } from "bun:sqlite"
import { rollbackFromRow, type InsertRollback, type RollbackExecution, type RollbackStatus } from "./types.ts"

const MAX_TEXT_BYTES = 16 * 1024

function truncateText(s: string): string {
  if (s.length <= MAX_TEXT_BYTES) return s
  return `${s.slice(0, MAX_TEXT_BYTES)}…[truncated]`
}

const VALID_STATUSES: RollbackStatus[] = ["planned", "approved", "dry_run", "executing", "success", "failed", "cancelled"]

export function recordRollback(
  db: Database,
  input: InsertRollback,
): RollbackExecution {
  // FK: deployment_id required
  const dep = db.query("SELECT id FROM deployments WHERE id = ?").get(input.deploymentId)
  if (!dep) throw new Error(`ndomo: deployment '${input.deploymentId}' not found (FK violation)`)
  // FK: incident_id optional
  if (input.incidentId) {
    const inc = db.query("SELECT id FROM incidents WHERE id = ?").get(input.incidentId)
    if (!inc) throw new Error(`ndomo: incident '${input.incidentId}' not found (FK violation)`)
  }
  // FK: new_deployment_id optional
  if (input.newDeploymentId) {
    const newDep = db.query("SELECT id FROM deployments WHERE id = ?").get(input.newDeploymentId)
    if (!newDep) throw new Error(`ndomo: new_deployment '${input.newDeploymentId}' not found (FK violation)`)
  }
  // Status (default planned)
  const status: RollbackStatus = input.status ?? "planned"
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`ndomo: invalid rollback status '${status}' (must be one of: ${VALID_STATUSES.join(", ")})`)
  }
  // Plan: trim + truncate + validate non-empty
  const plan = truncateText(input.plan.trim())
  if (plan.length === 0) throw new Error("ndomo: rollback plan cannot be empty")
  const id = crypto.randomUUID()
  const now = Date.now()
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null
  db.query(
    `INSERT INTO rollback_executions (id, deployment_id, incident_id, new_deployment_id, status, plan, executed_at, created_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, input.deploymentId, input.incidentId ?? null, input.newDeploymentId ?? null, status, plan, now, metadata)
  return getRollback(db, id)!
}

export function getRollback(db: Database, id: string): RollbackExecution | null {
  const row = db.query("SELECT * FROM rollback_executions WHERE id = ?").get(id)
  return row ? rollbackFromRow(row) : null
}

export function listRollbacksForIncident(db: Database, incidentId: string): RollbackExecution[] {
  const rows = db.query("SELECT * FROM rollback_executions WHERE incident_id = ? ORDER BY created_at DESC").all(incidentId)
  return rows.map(rollbackFromRow)
}

export function listRollbacksForDeployment(db: Database, deploymentId: string): RollbackExecution[] {
  const rows = db.query("SELECT * FROM rollback_executions WHERE deployment_id = ? ORDER BY created_at DESC").all(deploymentId)
  return rows.map(rollbackFromRow)
}
