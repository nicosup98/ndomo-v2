/**
 * ndomo DB — Task CRUD + FTS5 search.
 *
 * All functions take a Database instance and return camelCase TS types.
 * createTasksBatch is transactional.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { escapeFtsQuery } from "./fts-escape.ts";
import { setExecutedByOnce } from "./plans.ts";
import { ensureSession } from "./sessions.ts";
import type { PlanTask, TaskMetadata, TaskStatus } from "./types.ts";
import { taskFromRow } from "./types.ts";

export function createTasksBatch(
  db: Database,
  planId: string,
  tasks: Array<
    Omit<
      PlanTask,
      | "id"
      | "planId"
      | "status"
      | "startedAt"
      | "completedAt"
      | "result"
      | "error"
      | "archivedAt"
      | "originalPlanData"
    >
  >,
): PlanTask[] {
  // v6: soft warning for large task batches
  if (tasks.length > 5) {
    console.warn(
      `ndomo: creating ${tasks.length} tasks in batch for plan ${planId} — consider splitting large plans`,
    );
  }

  // F1: pre-dispatch overlap check — skip tasks with same (planId, agent, description)
  //     that already exist (any status, not archived). Prevents duplicate task creation.
  const existingSignatures = new Set<string>();
  const existingRows = db
    .query("SELECT agent, description FROM plan_tasks WHERE plan_id = ? AND archived_at IS NULL")
    .all(planId) as Array<{ agent: string; description: string }>;
  for (const row of existingRows) {
    existingSignatures.add(`${row.agent}::${row.description}`);
  }

  const results: PlanTask[] = [];
  const txn = db.transaction(() => {
    for (const t of tasks) {
      // Skip if task with same (agent, description) already exists for this plan
      const sig = `${t.agent}::${t.description}`;
      if (existingSignatures.has(sig)) {
        continue;
      }
      const i = results.length;
      const id = crypto.randomUUID();
      const orderIndex = t.orderIndex ?? i;
      // v6: write-once snapshot of task data
      const originalPlanData = JSON.stringify({
        description: t.description,
        agent: t.agent,
        files: t.files ?? [],
        complexity: t.complexity,
        dependencies: t.dependencies ?? [],
        orderIndex,
        createdBy: t.createdBy,
      });
      db.query(
        `INSERT INTO plan_tasks (id, plan_id, order_index, description, agent, files, complexity, status, dependencies, metadata, created_by, updated_by, source_session_id, source_message_id, reviewed_by, tokens_used, duration_ms, artifacts, original_plan_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        planId,
        orderIndex,
        t.description,
        t.agent,
        JSON.stringify(t.files ?? []),
        t.complexity,
        JSON.stringify(t.dependencies ?? []),
        JSON.stringify(t.metadata ?? {}),
        t.createdBy,
        t.updatedBy ?? t.createdBy,
        t.sourceSessionId ?? null,
        t.sourceMessageId ?? null,
        t.reviewedBy ?? null,
        t.tokensUsed ?? null,
        t.durationMs ?? null,
        JSON.stringify(t.artifacts ?? []),
        originalPlanData,
      );
      results.push({
        id,
        planId,
        orderIndex,
        description: t.description,
        agent: t.agent,
        files: t.files ?? [],
        complexity: t.complexity,
        status: "pending",
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        dependencies: t.dependencies ?? [],
        createdBy: t.createdBy,
        updatedBy: t.updatedBy ?? t.createdBy ?? "unknown",
        sourceSessionId: t.sourceSessionId ?? null,
        sourceMessageId: t.sourceMessageId ?? null,
        reviewedBy: t.reviewedBy ?? null,
        tokensUsed: t.tokensUsed ?? null,
        durationMs: t.durationMs ?? null,
        artifacts: t.artifacts ?? [],
        metadata: t.metadata ?? ({} as TaskMetadata),
        archivedAt: null,
        originalPlanData,
      });

      // Track signature to prevent in-batch duplicates
      existingSignatures.add(sig);

      // Issue 4: insert task files into plan_files with role='modified' (spec v2 §7.2)
      if (t.files && t.files.length > 0) {
        for (const filePath of t.files) {
          db.query(
            "INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, 'modified')",
          ).run(planId, filePath);
        }
      }
    }
  });
  txn();
  return results;
}

export function getTask(db: Database, id: string): PlanTask | null {
  const row = db.query("SELECT * FROM plan_tasks WHERE id = ?").get(id);
  return row != null ? taskFromRow(row) : null;
}

export function listTasksByPlan(
  db: Database,
  planId: string,
  opts: { status?: TaskStatus; includeArchived?: boolean } = {},
): PlanTask[] {
  const conditions: string[] = ["plan_id = ?"];
  const params: SQLQueryBindings[] = [planId];

  if (opts.status !== undefined) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (!opts.includeArchived) {
    conditions.push("archived_at IS NULL");
  }

  const rows = db
    .query(`SELECT * FROM plan_tasks WHERE ${conditions.join(" AND ")} ORDER BY order_index`)
    .all(...params);
  return (rows as unknown[]).map(taskFromRow);
}

const MAX_RESULT_BYTES = 16 * 1024;
const TRUNC_SUFFIX = "…[truncated]";

/** Truncate strings exceeding 16 KB to prevent unbounded storage growth. */
function trunc(s: string): string;
function trunc(s: undefined): undefined;
function trunc(s: string | undefined): string | undefined;
function trunc(s?: string): string | undefined {
  if (s === undefined) return undefined;
  return s.length > MAX_RESULT_BYTES
    ? `${s.slice(0, MAX_RESULT_BYTES - TRUNC_SUFFIX.length)}${TRUNC_SUFFIX}`
    : s;
}

export function updateTaskStatus(
  db: Database,
  id: string,
  status: TaskStatus,
  fields?: { result?: string; error?: string },
  updatedBy?: string,
  ctx?: { agent?: string; sessionId?: string },
): PlanTask | null {
  const now = Date.now();
  const setClauses: string[] = ["status = ?"];
  const params: SQLQueryBindings[] = [status];

  if (status === "running") {
    setClauses.push("started_at = ?");
    params.push(now);

    // Issue 2: write-once executed_by_agent/session on plan when task starts
    if (ctx?.agent) {
      const task = db.query("SELECT plan_id FROM plan_tasks WHERE id = ?").get(id) as
        | { plan_id: string }
        | undefined;
      if (task?.plan_id) {
        // HIGH 3: ensure session exists before FK write
        if (ctx.sessionId) {
          ensureSession(db, ctx.sessionId, "auto-created for task execution", ctx.agent);
        }
        setExecutedByOnce(db, task.plan_id, ctx.agent, ctx.sessionId ?? null);
      }
    }
  }
  if (status === "done" || status === "failed") {
    setClauses.push("completed_at = ?");
    params.push(now);
  }

  // Fix 5: truncate result/error to 16 KB max
  const fieldDefs: Array<[string, string | undefined]> = [
    ["result", fields?.result],
    ["error", fields?.error],
  ];
  for (const [col, val] of fieldDefs) {
    if (val !== undefined) {
      setClauses.push(`${col} = ?`);
      params.push(trunc(val) as SQLQueryBindings);
    }
  }

  if (updatedBy !== undefined) {
    setClauses.push("updated_by = ?");
    params.push(updatedBy);
  }

  params.push(id);
  db.query(`UPDATE plan_tasks SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
  return getTask(db, id);
}

export function searchTasks(
  db: Database,
  query: string,
  limit = 20,
  opts: { includeArchived?: boolean } = {},
): PlanTask[] {
  const archiveFilter = opts.includeArchived ? "" : "AND t.archived_at IS NULL";
  const rows = db
    .query(
      `SELECT t.* FROM plan_tasks t
       JOIN tasks_fts fts ON t.rowid = fts.rowid
       WHERE tasks_fts MATCH ? ${archiveFilter}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(escapeFtsQuery(query), limit);
  return (rows as unknown[]).map(taskFromRow);
}

/**
 * Atomically claim next pending task for agent.
 * Uses transaction (SELECT + UPDATE) to prevent race condition.
 * SQLite transactions are SERIALIZABLE — no concurrent claim possible.
 */
export function nextTaskForAgent(
  db: Database,
  agent: string,
  opts: { planId?: string; includeArchived?: boolean } = {},
): PlanTask | null {
  const now = Date.now();
  const archiveFilter = opts.includeArchived ? "" : "AND archived_at IS NULL";

  return db.transaction(() => {
    if (opts.planId !== undefined) {
      const row = db
        .query(
          `SELECT * FROM plan_tasks
           WHERE agent = ? AND plan_id = ? AND status = 'pending' ${archiveFilter}
           ORDER BY order_index LIMIT 1`,
        )
        .get(agent, opts.planId);
      if (row == null) return null;
      const task = taskFromRow(row);
      db.query(
        `UPDATE plan_tasks SET status = 'running', started_at = ?, updated_by = ? WHERE id = ?`,
      ).run(now, agent, task.id);
      return { ...task, status: "running" as const, startedAt: now, updatedBy: agent };
    }

    const row = db
      .query(
        `SELECT * FROM plan_tasks
         WHERE agent = ? AND status = 'pending' ${archiveFilter}
         ORDER BY order_index LIMIT 1`,
      )
      .get(agent);
    if (row == null) return null;
    const task = taskFromRow(row);
    db.query(
      `UPDATE plan_tasks SET status = 'running', started_at = ?, updated_by = ? WHERE id = ?`,
    ).run(now, agent, task.id);
    return { ...task, status: "running" as const, startedAt: now, updatedBy: agent };
  })();
}

// ─── Tag helpers ─────────────────────────────────────────────────────────────

export function addTaskTag(db: Database, taskId: string, tag: string, addedBy: string): void {
  db.query(
    "INSERT OR IGNORE INTO task_tags (task_id, tag, added_by, added_at) VALUES (?, ?, ?, ?)",
  ).run(taskId, tag, addedBy, Date.now());
}

export function removeTaskTag(db: Database, taskId: string, tag: string): void {
  db.query("DELETE FROM task_tags WHERE task_id = ? AND tag = ?").run(taskId, tag);
}

export function getTaskTags(
  db: Database,
  taskId: string,
): Array<{ tag: string; addedBy: string; addedAt: number }> {
  const rows = db
    .query("SELECT tag, added_by, added_at FROM task_tags WHERE task_id = ? ORDER BY tag")
    .all(taskId) as Array<{ tag: string; added_by: string; added_at: number }>;
  return rows.map((r) => ({ tag: r.tag, addedBy: r.added_by, addedAt: r.added_at }));
}
