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

// ─── M7: Cross-stack file splitting ─────────────────────────────────────────

/** Map file extension → stack key. Unrecognized extensions → 'other'. */
const STACK_MAP: Record<string, string> = {
  ".go": "go",
  ".vue": "vue",
  ".ts": "js",
  ".tsx": "js",
  ".js": "js",
  ".jsx": "js",
  ".py": "python",
  ".rs": "rust",
  ".zig": "zig",
};

/** Map stack key → default agent for that stack. */
const STACK_AGENT_MAP: Record<string, string> = {
  go: "go-smith",
  vue: "js-smith",
  js: "js-smith",
  python: "python-smith",
  rust: "rust-smith",
  zig: "zig-smith",
  other: "smith",
};

/**
 * Group files by their stack (determined by extension).
 * Returns a record of stackKey → file paths.
 *
 * @example splitFilesByStack(["main.go", "app.ts"]) → { go: ["main.go"], js: ["app.ts"] }
 */
export function splitFilesByStack(files: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const f of files) {
    const dotIdx = f.lastIndexOf(".");
    const ext = dotIdx >= 0 ? f.slice(dotIdx).toLowerCase() : "";
    const stack = STACK_MAP[ext] ?? "other";
    if (!result[stack]) result[stack] = [];
    result[stack].push(f);
  }
  return result;
}

// ─── M6: Truncation types ───────────────────────────────────────────────────

/** Metadata returned when result/error is truncated to 16 KB. */
export interface TaskTruncationInfo {
  truncated: boolean;
  originalLength?: number;
  truncatedLength?: number;
}

/** Return type for updateTaskStatus — includes truncation metadata. */
export type TaskUpdateResult = (PlanTask & { truncation: TaskTruncationInfo }) | null;

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
      // M7: split cross-stack files into sub-tasks
      const filesByStack = t.files && t.files.length > 1 ? splitFilesByStack(t.files) : null;
      const stackKeys = filesByStack ? Object.keys(filesByStack) : [];
      const needsSplit = filesByStack !== null && stackKeys.length > 1;

      // Generate sub-tasks: either the original or split children
      const subTasks = needsSplit
        ? stackKeys.map((stack, stackIdx) => ({
            ...t,
            description: t.description,
            agent: STACK_AGENT_MAP[stack] ?? "smith",
            files: filesByStack[stack] ?? [],
            orderIndex: (t.orderIndex ?? results.length) + stackIdx * 0.1,
            metadata: {
              ...t.metadata,
              splitFrom: null as string | null, // filled after first insert
              splitReason: "cross-stack" as const,
            },
          }))
        : [t];

      let firstSubTaskId: string | null = null;

      for (const effectiveTask of subTasks) {
        // Skip if task with same (agent, description) already exists for this plan
        const sig = `${effectiveTask.agent}::${effectiveTask.description}`;
        if (existingSignatures.has(sig)) {
          continue;
        }
        const i = results.length;
        const id = crypto.randomUUID();

        // Wire splitFrom to first sub-task id
        if (needsSplit && firstSubTaskId === null) {
          firstSubTaskId = id;
        }
        const taskMetadata = needsSplit
          ? { ...effectiveTask.metadata, splitFrom: firstSubTaskId }
          : (effectiveTask.metadata ?? {});

        const orderIndex = effectiveTask.orderIndex ?? i;
        // v6: write-once snapshot of task data (M5: added metadata)
        const originalPlanData = JSON.stringify({
          description: effectiveTask.description,
          agent: effectiveTask.agent,
          files: effectiveTask.files ?? [],
          complexity: effectiveTask.complexity,
          dependencies: effectiveTask.dependencies ?? [],
          metadata: taskMetadata,
          orderIndex,
          createdBy: effectiveTask.createdBy,
        });
        db.query(
          `INSERT INTO plan_tasks (id, plan_id, order_index, description, agent, files, complexity, status, dependencies, metadata, created_by, updated_by, source_session_id, source_message_id, reviewed_by, tokens_used, duration_ms, artifacts, original_plan_data)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          planId,
          orderIndex,
          effectiveTask.description,
          effectiveTask.agent,
          JSON.stringify(effectiveTask.files ?? []),
          effectiveTask.complexity,
          JSON.stringify(effectiveTask.dependencies ?? []),
          JSON.stringify(taskMetadata),
          effectiveTask.createdBy,
          effectiveTask.updatedBy ?? effectiveTask.createdBy,
          effectiveTask.sourceSessionId ?? null,
          effectiveTask.sourceMessageId ?? null,
          effectiveTask.reviewedBy ?? null,
          effectiveTask.tokensUsed ?? null,
          effectiveTask.durationMs ?? null,
          JSON.stringify(effectiveTask.artifacts ?? []),
          originalPlanData,
        );
        results.push({
          id,
          planId,
          orderIndex,
          description: effectiveTask.description,
          agent: effectiveTask.agent,
          files: effectiveTask.files ?? [],
          complexity: effectiveTask.complexity,
          status: "pending",
          startedAt: null,
          completedAt: null,
          result: null,
          error: null,
          dependencies: effectiveTask.dependencies ?? [],
          createdBy: effectiveTask.createdBy,
          updatedBy: effectiveTask.updatedBy ?? effectiveTask.createdBy ?? "unknown",
          sourceSessionId: effectiveTask.sourceSessionId ?? null,
          sourceMessageId: effectiveTask.sourceMessageId ?? null,
          reviewedBy: effectiveTask.reviewedBy ?? null,
          tokensUsed: effectiveTask.tokensUsed ?? null,
          durationMs: effectiveTask.durationMs ?? null,
          artifacts: effectiveTask.artifacts ?? [],
          metadata: taskMetadata as TaskMetadata,
          archivedAt: null,
          originalPlanData,
        });

        // Track signature to prevent in-batch duplicates
        existingSignatures.add(sig);

        // Issue 4: insert task files into plan_files with role='modified' (spec v2 §7.2)
        if (effectiveTask.files && effectiveTask.files.length > 0) {
          for (const filePath of effectiveTask.files) {
            db.query(
              "INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, 'modified')",
            ).run(planId, filePath);
          }
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

/**
 * Truncate strings exceeding 16 KB to prevent unbounded storage growth.
 * Returns [truncated, wasTruncated] tuple for metadata tracking.
 */
function truncWithInfo(s: string | undefined): [string | undefined, boolean, number | undefined] {
  if (s === undefined) return [undefined, false, undefined];
  if (s.length > MAX_RESULT_BYTES) {
    const truncated = `${s.slice(0, MAX_RESULT_BYTES - TRUNC_SUFFIX.length)}${TRUNC_SUFFIX}`;
    return [truncated, true, s.length];
  }
  return [s, false, undefined];
}

export function updateTaskStatus(
  db: Database,
  id: string,
  status: TaskStatus,
  fields?: { result?: string; error?: string },
  updatedBy?: string,
  ctx?: { agent?: string; sessionId?: string },
): TaskUpdateResult {
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

  // M6: truncate result/error to 16 KB max with warning + metadata
  const truncationInfo: TaskTruncationInfo = { truncated: false };
  const fieldDefs: Array<[string, string | undefined]> = [
    ["result", fields?.result],
    ["error", fields?.error],
  ];
  for (const [col, val] of fieldDefs) {
    if (val !== undefined) {
      const [truncated, wasTruncated, originalLength] = truncWithInfo(val);
      if (wasTruncated) {
        truncationInfo.truncated = true;
        if (originalLength !== undefined) truncationInfo.originalLength = originalLength;
        truncationInfo.truncatedLength = MAX_RESULT_BYTES;
        console.warn(
          `ndomo: task_update_status ${id} — ${col} truncated from ${originalLength} to ${MAX_RESULT_BYTES} bytes`,
        );
      }
      setClauses.push(`${col} = ?`);
      params.push(truncated as SQLQueryBindings);
    }
  }

  if (updatedBy !== undefined) {
    setClauses.push("updated_by = ?");
    params.push(updatedBy);
  }

  params.push(id);
  db.query(`UPDATE plan_tasks SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
  const task = getTask(db, id);
  if (!task) return null;
  return { ...task, truncation: truncationInfo };
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
