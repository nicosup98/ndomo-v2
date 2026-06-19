/**
 * ndomo DB — Plan CRUD + FTS5 search.
 *
 * All functions take a Database instance and return camelCase TS types.
 * Mutations that touch multiple rows use db.transaction().
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { escapeFtsQuery } from "./fts-escape.ts";
import type { Plan, PlanCategory, PlanStatus } from "./types.ts";
import { planFromRow } from "./types.ts";

export function createPlan(db: Database, plan: Omit<Plan, "createdAt" | "updatedAt">): Plan {
  const now = Date.now();
  db.query(
    `INSERT INTO plans (id, slug, title, status, priority, created_at, updated_at, approved_at, completed_at, session_id, overview, approach, complexity, metadata, created_by, updated_by, source_session_id, source_message_id, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.id,
    plan.slug,
    plan.title,
    plan.status,
    plan.priority,
    now,
    now,
    plan.approvedAt ?? null,
    plan.completedAt ?? null,
    plan.sessionId ?? null,
    plan.overview,
    plan.approach ?? null,
    plan.complexity,
    JSON.stringify(plan.metadata),
    plan.createdBy,
    plan.updatedBy,
    plan.sourceSessionId ?? null,
    plan.sourceMessageId ?? null,
    plan.category ?? null,
  );
  return { ...plan, createdAt: now, updatedAt: now };
}

export function getPlan(db: Database, id: string): Plan | null {
  const row = db.query("SELECT * FROM plans WHERE id = ?").get(id);
  return row != null ? planFromRow(row) : null;
}

export function getPlanBySlug(db: Database, slug: string): Plan | null {
  const row = db.query("SELECT * FROM plans WHERE slug = ?").get(slug);
  return row != null ? planFromRow(row) : null;
}

export function listPlans(
  db: Database,
  opts: { status?: PlanStatus; sessionId?: string; limit?: number; includeArchived?: boolean } = {},
): Plan[] {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (opts.status !== undefined) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts.sessionId !== undefined) {
    conditions.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (!opts.includeArchived) {
    conditions.push("archived_at IS NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 100;

  const rows = db
    .query(`SELECT * FROM plans ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit);
  return (rows as unknown[]).map(planFromRow);
}

export function searchPlans(
  db: Database,
  query: string,
  limit = 20,
  opts: { includeArchived?: boolean } = {},
): Plan[] {
  const archiveFilter = opts.includeArchived ? "" : "AND p.archived_at IS NULL";
  const rows = db
    .query(
      `SELECT p.* FROM plans p
       JOIN plans_fts_v2 fts ON p.id = fts.id
       WHERE plans_fts_v2 MATCH ?
       ${archiveFilter}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(escapeFtsQuery(query), limit);
  return (rows as unknown[]).map(planFromRow);
}

/**
 * Update a plan's status. Optionally links a session and records who made the change.
 *
 * When transitioning to "executing" or "approved" with a sessionId provided,
 * the session is auto-linked to the plan (Fix #8). The sessionId is validated
 * against the sessions table before linking (Fix #1).
 *
 * @see Plan.sessionId — foreign key constraint enforced at app level (Fix #1)
 */
export function updatePlanStatus(
  db: Database,
  id: string,
  status: PlanStatus,
  opts: { updatedBy?: string; sessionId?: string } = {},
): Plan | null {
  const now = Date.now();

  // Fix #1: validate sessionId exists if provided
  if (opts.sessionId !== undefined) {
    const exists = db.query("SELECT 1 FROM sessions WHERE id = ?").get(opts.sessionId);
    if (!exists) throw new Error(`ndomo: session_id does not exist: ${opts.sessionId}`);
  }

  // Fix #8: auto-link session when entering executing or approved status
  const linkSession =
    (status === "executing" || status === "approved") && opts.sessionId !== undefined;

  if (linkSession) {
    // opts.sessionId is guaranteed non-undefined here (linkSession check above)
    const sid = opts.sessionId as string;
    db.query(
      "UPDATE plans SET status = ?, updated_at = ?, updated_by = ?, session_id = ? WHERE id = ?",
    ).run(status, now, opts.updatedBy ?? "unknown", sid, id);
  } else if (opts.updatedBy !== undefined) {
    db.query("UPDATE plans SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(
      status,
      now,
      opts.updatedBy,
      id,
    );
  } else {
    db.query("UPDATE plans SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  }
  return getPlan(db, id);
}

/**
 * Approve a plan. Optionally links a session (Fix #8) and records who approved it.
 *
 * @see Plan.sessionId — foreign key constraint enforced at app level (Fix #1)
 */
export function approvePlan(
  db: Database,
  id: string,
  opts: { updatedBy?: string; sessionId?: string } = {},
): Plan | null {
  const now = Date.now();

  // Fix #1: validate sessionId exists if provided
  if (opts.sessionId !== undefined) {
    const exists = db.query("SELECT 1 FROM sessions WHERE id = ?").get(opts.sessionId);
    if (!exists) throw new Error(`ndomo: session_id does not exist: ${opts.sessionId}`);
  }

  // Fix #8: auto-link session when approving
  if (opts.sessionId !== undefined) {
    db.query(
      "UPDATE plans SET status = 'approved', approved_at = ?, updated_at = ?, updated_by = ?, session_id = ? WHERE id = ?",
    ).run(now, now, opts.updatedBy ?? "unknown", opts.sessionId, id);
  } else if (opts.updatedBy !== undefined) {
    db.query(
      "UPDATE plans SET status = 'approved', approved_at = ?, updated_at = ?, updated_by = ? WHERE id = ?",
    ).run(now, now, opts.updatedBy, id);
  } else {
    db.query(
      "UPDATE plans SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, id);
  }
  return getPlan(db, id);
}

// ─── Tag helpers ─────────────────────────────────────────────────────────────

export function addPlanTag(db: Database, planId: string, tag: string, addedBy: string): void {
  db.query(
    "INSERT OR IGNORE INTO plan_tags (plan_id, tag, added_by, added_at) VALUES (?, ?, ?, ?)",
  ).run(planId, tag, addedBy, Date.now());
}

export function removePlanTag(db: Database, planId: string, tag: string): void {
  db.query("DELETE FROM plan_tags WHERE plan_id = ? AND tag = ?").run(planId, tag);
}

export function getPlanTags(
  db: Database,
  planId: string,
): Array<{ tag: string; addedBy: string; addedAt: number }> {
  const rows = db
    .query("SELECT tag, added_by, added_at FROM plan_tags WHERE plan_id = ? ORDER BY tag")
    .all(planId) as Array<{ tag: string; added_by: string; added_at: number }>;
  return rows.map((r) => ({ tag: r.tag, addedBy: r.added_by, addedAt: r.added_at }));
}

export function findPlansByTag(
  db: Database,
  tag: string,
  limit = 20,
  opts: { includeArchived?: boolean } = {},
): Plan[] {
  const archiveFilter = opts.includeArchived ? "" : "AND p.archived_at IS NULL";
  const rows = db
    .query(
      `SELECT p.* FROM plans p
       JOIN plan_tags pt ON p.id = pt.plan_id
       WHERE pt.tag = ? ${archiveFilter}
       ORDER BY p.created_at DESC
       LIMIT ?`,
    )
    .all(tag, limit);
  return (rows as unknown[]).map(planFromRow);
}

export function findPlansByCategory(
  db: Database,
  category: PlanCategory,
  limit = 20,
  opts: { includeArchived?: boolean } = {},
): Plan[] {
  const archiveFilter = opts.includeArchived ? "" : "AND archived_at IS NULL";
  const rows = db
    .query(
      `SELECT * FROM plans WHERE category = ? ${archiveFilter} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(category, limit);
  return (rows as unknown[]).map(planFromRow);
}

// ─── Plan progress (v4) ──────────────────────────────────────────────────────

export interface PlanProgress {
  planId: string;
  slug: string;
  title: string;
  status: string;
  totalTasks: number;
  done: number;
  failed: number;
  running: number;
  pending: number;
  blocked: number;
  progressPct: number;
}

interface PlanProgressRow {
  plan_id: string;
  slug: string;
  title: string;
  status: string;
  total_tasks: number;
  done: number;
  failed: number;
  running: number;
  pending: number;
  blocked: number;
  progress_pct: number;
}

function planProgressFromRow(row: unknown): PlanProgress {
  const r = row as PlanProgressRow;
  return {
    planId: r.plan_id,
    slug: r.slug,
    title: r.title,
    status: r.status,
    totalTasks: r.total_tasks,
    done: r.done,
    failed: r.failed,
    running: r.running,
    pending: r.pending,
    blocked: r.blocked,
    progressPct: r.progress_pct,
  };
}

/**
 * Query the plan_progress view for task aggregation.
 *
 * @param db   - Database instance
 * @param planId - optional plan id to filter by; omit for all plans
 */
export function getPlanProgress(db: Database, planId?: string): PlanProgress[] {
  const sql =
    planId !== undefined
      ? "SELECT * FROM plan_progress WHERE plan_id = ?"
      : "SELECT * FROM plan_progress";
  const rows = planId !== undefined ? db.query(sql).all(planId) : db.query(sql).all();
  return (rows as unknown[]).map(planProgressFromRow);
}
