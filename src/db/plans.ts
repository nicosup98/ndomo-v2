/**
 * ndomo DB — Plan CRUD + FTS5 search.
 *
 * All functions take a Database instance and return camelCase TS types.
 * Mutations that touch multiple rows use db.transaction().
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { escapeFtsQuery } from "./fts-escape.ts";
import { ensureSession } from "./sessions.ts";
import type { Plan, PlanCategory, PlanStatus } from "./types.ts";
import { planFromRow, planWithFilesFromRow } from "./types.ts";

export function createPlan(db: Database, plan: Omit<Plan, "createdAt" | "updatedAt">): Plan {
  const now = Date.now();
  // v6: build original_plan_data snapshot (write-once)
  const originalPlanData = JSON.stringify({
    id: plan.id,
    slug: plan.slug,
    title: plan.title,
    overview: plan.overview,
    approach: plan.approach,
    priority: plan.priority,
    complexity: plan.complexity,
    category: plan.category,
    createdBy: plan.createdBy,
    sourceSessionId: plan.sourceSessionId,
    sourceMessageId: plan.sourceMessageId,
    createdAt: now,
  });
  db.query(
    `INSERT INTO plans (id, slug, title, status, priority, created_at, updated_at, approved_at, completed_at, session_id, overview, approach, complexity, metadata, created_by, updated_by, source_session_id, source_message_id, category, original_plan_data, created_by_agent, executed_by_agent, executed_by_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    originalPlanData,
    plan.createdByAgent ?? null,
    plan.executedByAgent ?? null,
    plan.executedBySession ?? null,
  );
  return { ...plan, createdAt: now, updatedAt: now, originalPlanData };
}

export function getPlan(db: Database, id: string): Plan | null {
  const row = db.query("SELECT * FROM plans WHERE id = ?").get(id);
  if (row == null) return null;
  const fileRows = db
    .query("SELECT file_path, role FROM plan_files WHERE plan_id = ? ORDER BY file_path")
    .all(id);
  return planWithFilesFromRow(row, fileRows);
}

export function getPlanBySlug(db: Database, slug: string): Plan | null {
  const row = db.query("SELECT * FROM plans WHERE slug = ?").get(slug);
  if (row == null) return null;
  // Need to get the plan id to query plan_files
  const planId = (row as { id: string }).id;
  const fileRows = db
    .query("SELECT file_path, role FROM plan_files WHERE plan_id = ? ORDER BY file_path")
    .all(planId);
  return planWithFilesFromRow(row, fileRows);
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

  if (rows.length === 0) return [];

  // Get all plan IDs
  const planIds = (rows as Array<{ id: string }>).map((r) => r.id);

  // Fetch all files for these plans in one query
  const placeholders = planIds.map(() => "?").join(",");
  const fileRows = db
    .query(
      `SELECT plan_id, file_path, role FROM plan_files WHERE plan_id IN (${placeholders}) ORDER BY plan_id, file_path`,
    )
    .all(...planIds) as Array<{ plan_id: string; file_path: string; role: string }>;

  // Group files by plan_id
  const filesByPlanId = new Map<string, Array<{ file_path: string; role: string }>>();
  for (const f of fileRows) {
    const existing = filesByPlanId.get(f.plan_id) ?? [];
    existing.push({ file_path: f.file_path, role: f.role });
    filesByPlanId.set(f.plan_id, existing);
  }

  // Map plans with their files
  return (rows as unknown[]).map((row) => {
    const planId = (row as { id: string }).id;
    const planFiles = filesByPlanId.get(planId) ?? [];
    return planWithFilesFromRow(row, planFiles);
  });
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
 * the session is auto-linked to the plan (Fix #8). The sessionId is only
 * validated/auto-created when it will actually be linked (executing/approved);
 * terminal statuses (completed/failed/abandoned) skip FK check since sessionId
 * is just metadata there (Fix #1 hybrid — scoped ensureSession).
 *
 * @see Plan.sessionId — foreign key constraint enforced at app level (Fix #1)
 * @see ensureSession — idempotent auto-creation of session rows (hybrid fix)
 */
export function updatePlanStatus(
  db: Database,
  id: string,
  status: PlanStatus,
  opts: {
    updatedBy?: string;
    sessionId?: string;
    executedByAgent?: string;
    executedBySession?: string;
  } = {},
): Plan | null {
  const now = Date.now();

  // Fix #1 (scoped): validate sessionId only when status will actually link it (Fix #8)
  if (opts.sessionId !== undefined && (status === "executing" || status === "approved")) {
    ensureSession(db, opts.sessionId, "auto-created for plan transition");
  }

  // Fix #8: auto-link session when entering executing or approved status
  const linkSession =
    (status === "executing" || status === "approved") && opts.sessionId !== undefined;

  // v8: write-once executed_by_agent/session — only set on first executing transition
  const setExecutedBy = status === "executing" && opts.executedByAgent !== undefined;
  // Guaranteed non-undefined inside setExecutedBy branches (see guard above)
  const executedAgent = opts.executedByAgent ?? null;
  const executedSession = opts.executedBySession ?? null;

  if (linkSession) {
    // opts.sessionId is guaranteed non-undefined here (linkSession check above)
    const sid = opts.sessionId as string;
    if (setExecutedBy) {
      db.query(
        `UPDATE plans SET status = ?, updated_at = ?, updated_by = ?, session_id = ?,
         executed_by_agent = COALESCE(executed_by_agent, ?),
         executed_by_session = COALESCE(executed_by_session, ?)
         WHERE id = ?`,
      ).run(status, now, opts.updatedBy ?? "unknown", sid, executedAgent, executedSession, id);
    } else {
      db.query(
        "UPDATE plans SET status = ?, updated_at = ?, updated_by = ?, session_id = ? WHERE id = ?",
      ).run(status, now, opts.updatedBy ?? "unknown", sid, id);
    }
  } else if (opts.updatedBy !== undefined) {
    if (setExecutedBy) {
      db.query(
        `UPDATE plans SET status = ?, updated_at = ?, updated_by = ?,
         executed_by_agent = COALESCE(executed_by_agent, ?),
         executed_by_session = COALESCE(executed_by_session, ?)
         WHERE id = ?`,
      ).run(status, now, opts.updatedBy, executedAgent, executedSession, id);
    } else {
      db.query("UPDATE plans SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(
        status,
        now,
        opts.updatedBy,
        id,
      );
    }
  } else {
    if (setExecutedBy) {
      db.query(
        `UPDATE plans SET status = ?, updated_at = ?,
         executed_by_agent = COALESCE(executed_by_agent, ?),
         executed_by_session = COALESCE(executed_by_session, ?)
         WHERE id = ?`,
      ).run(status, now, executedAgent, executedSession, id);
    } else {
      db.query("UPDATE plans SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    }
  }
  return getPlan(db, id);
}

/**
 * Approve a plan. Optionally links a session (Fix #8) and records who approved it.
 *
 * The sessionId is validated/auto-created when linking (approve always links).
 * Uses ensureSession for idempotent FK integrity (Fix #1 hybrid).
 *
 * @see Plan.sessionId — foreign key constraint enforced at app level (Fix #1)
 * @see ensureSession — idempotent auto-creation of session rows (hybrid fix)
 */
export function approvePlan(
  db: Database,
  id: string,
  opts: { updatedBy?: string; sessionId?: string } = {},
): Plan | null {
  const now = Date.now();

  // Fix #1 (scoped): validate sessionId when linking (Fix #8 — approve always links)
  if (opts.sessionId !== undefined) {
    ensureSession(db, opts.sessionId, "auto-created for plan approval");
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

// ─── Plan deletion ──────────────────────────────────────────────────────────

export interface DeletePlanOpts {
  /** Required confirmation flag — must be true to proceed */
  confirm: boolean;
}

export interface DeletePlanResult {
  planId: string;
  slug: string;
  tasksDeleted: number;
  sessionsUnlinked: number;
  filesDeleted: number;
}

/**
 * Delete a plan and all associated data (CASCADE).
 *
 * Guards:
 * - Requires confirm: true
 * - Rejects if plan.status === 'draft' (use abandonPlan instead)
 * - Rejects if any tasks are 'pending' or 'running'
 *
 * The actual deletion relies on ON DELETE CASCADE in the schema:
 * - plan_tasks (FK plan_id)
 * - plan_files (FK plan_id)
 * - plan_tags (FK plan_id)
 * - sessions.plan_id (SET NULL)
 */
export function deletePlan(db: Database, planId: string, opts: DeletePlanOpts): DeletePlanResult {
  if (!opts.confirm) {
    throw new Error("ndomo: deletePlan requires confirm: true");
  }

  const plan = getPlan(db, planId);
  if (!plan) {
    throw new Error(`ndomo: plan not found: ${planId}`);
  }

  if (plan.status === "draft") {
    throw new Error("ndomo: cannot delete a draft plan — use abandonPlan or approve first");
  }

  // Check for active tasks
  const activeTasks = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ? AND status IN ('pending', 'running') AND archived_at IS NULL",
    )
    .get(planId);

  if (activeTasks && activeTasks.count > 0) {
    throw new Error(
      `ndomo: cannot delete plan with ${activeTasks.count} active task(s) — complete or fail them first`,
    );
  }

  // Count related records before deletion
  const tasksCount =
    db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM plan_tasks WHERE plan_id = ?",
      )
      .get(planId)?.count ?? 0;

  const sessionsCount =
    db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM sessions WHERE plan_id = ?",
      )
      .get(planId)?.count ?? 0;

  const filesCount =
    db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM plan_files WHERE plan_id = ?",
      )
      .get(planId)?.count ?? 0;

  // Delete — CASCADE handles plan_tasks, plan_files, plan_tags
  // sessions.plan_id is SET NULL per schema
  db.query("DELETE FROM plans WHERE id = ?").run(planId);

  return {
    planId,
    slug: plan.slug,
    tasksDeleted: tasksCount,
    sessionsUnlinked: sessionsCount,
    filesDeleted: filesCount,
  };
}

// ─── Write-once executed_by helpers ──────────────────────────────────────────

/**
 * Write-once: set executed_by_agent and executed_by_session on a plan.
 * Uses COALESCE so the first write wins — subsequent calls are no-ops.
 */
export function setExecutedByOnce(
  db: Database,
  planId: string,
  agent: string,
  sessionId?: string | null,
): void {
  db.query(
    `UPDATE plans SET
       executed_by_agent = COALESCE(executed_by_agent, ?),
       executed_by_session = COALESCE(executed_by_session, ?)
     WHERE id = ? AND archived_at IS NULL`,
  ).run(agent, sessionId ?? null, planId);
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
