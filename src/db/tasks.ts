/**
 * ndomo DB — Task CRUD + FTS5 search.
 *
 * All functions take a Database instance and return camelCase TS types.
 * createTasksBatch is transactional.
 *
 * Post-commit hooks: mutations emit typed events on the in-process bus
 * (`src/events/bus.ts`) so SSE subscribers (`src/http/routes/events.ts`)
 * receive live updates without polling. Bus emits happen AFTER the DB
 * transaction commits so subscribers never see unpublished state.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { bus } from "../events/bus.ts";
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
      | "orderIndex"
    > & {
      /** Preferred order_index slot. If omitted or occupied, core allocates dynamically. */
      orderIndex?: number;
    }
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

  // ─── order_index collision-safe allocation (fix: UNIQUE constraint on retries) ──
  // The UNIQUE(plan_id, order_index) constraint covers ALL rows (archived or not).
  // Callers may pass t.orderIndex as a preferred slot, but it's only a hint —
  // the core reassigns if the slot is occupied. This makes task_create_batch safe
  // to call 2+ times on the same plan (retry, cross-step dispatch, etc.).
  const MAX_RETRIES = 10;

  // Collect ALL existing order_indices (including archived) for collision detection.
  const usedOrderIndices = new Set<number>();
  const allOrderRows = db
    .query("SELECT order_index FROM plan_tasks WHERE plan_id = ?")
    .all(planId) as Array<{ order_index: number }>;
  for (const row of allOrderRows) {
    usedOrderIndices.add(row.order_index);
  }

  // nextFreeInteger starts after the MAX of non-archived tasks (so new tasks
  // fill in after the active set, not after archived outliers).
  const maxRow = db
    .query("SELECT MAX(order_index) as m FROM plan_tasks WHERE plan_id = ? AND archived_at IS NULL")
    .get(planId) as { m: number | null } | undefined;
  let nextFreeInteger = Math.floor(maxRow?.m ?? -1) + 1;

  /**
   * Allocate a unique order_index.
   * Tries the preferred slot first; if occupied (or undefined), falls back to
   * nextFreeInteger, incrementing until a free slot is found.
   * Marks the slot as used in usedOrderIndices before returning.
   */
  function allocateOrderIndex(preferred: number | undefined): number {
    if (preferred !== undefined && !usedOrderIndices.has(preferred)) {
      usedOrderIndices.add(preferred);
      if (Math.floor(preferred) >= nextFreeInteger) {
        nextFreeInteger = Math.floor(preferred) + 1;
      }
      return preferred;
    }
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const candidate = nextFreeInteger;
      if (!usedOrderIndices.has(candidate)) {
        usedOrderIndices.add(candidate);
        nextFreeInteger = candidate + 1;
        return candidate;
      }
      nextFreeInteger++;
    }
    throw new Error(
      `ndomo: could not allocate unique order_index after ${MAX_RETRIES} retries for plan ${planId}`,
    );
  }

  /**
   * Allocate order_index for a split sub-task.
   * stackIdx=0 → parent slot (integer).
   * stackIdx>0 → parentOrder + stackIdx*0.1 (decimal); if occupied, escalate
   * to next free integer (no further decimal attempts).
   */
  function allocateSplitOrderIndex(parentOrder: number, stackIdx: number): number {
    if (stackIdx === 0) {
      // parentOrder was already allocated and marked as used in the pre-loop.
      // Return directly — do NOT re-allocate (would see slot as occupied).
      return parentOrder;
    }
    const decimalCandidate = parentOrder + stackIdx * 0.1;
    if (!usedOrderIndices.has(decimalCandidate)) {
      usedOrderIndices.add(decimalCandidate);
      return decimalCandidate;
    }
    // Decimal occupied → escalate to next free integer
    return allocateOrderIndex(undefined);
  }

  const results: PlanTask[] = [];
  const txn = db.transaction(() => {
    for (const t of tasks) {
      // M7: split cross-stack files into sub-tasks
      const filesByStack = t.files && t.files.length > 1 ? splitFilesByStack(t.files) : null;
      const stackKeys = filesByStack ? Object.keys(filesByStack) : [];
      const needsSplit = filesByStack !== null && stackKeys.length > 1;

      // For split tasks: allocate parent order_index first (used as base for decimals).
      // For non-split tasks: orderIndex is allocated per sub-task below.
      const parentOrder = needsSplit ? allocateOrderIndex(t.orderIndex) : undefined;

      // Generate sub-tasks: either the original or split children
      // (orderIndex is allocated below via helpers — not set here)
      const subTasks = needsSplit
        ? stackKeys.map((stack) => ({
            ...t,
            description: t.description,
            agent: STACK_AGENT_MAP[stack] ?? "smith",
            files: filesByStack[stack] ?? [],
            metadata: {
              ...t.metadata,
              splitFrom: null as string | null, // filled after first insert
              splitReason: "cross-stack" as const,
            },
          }))
        : [t];

      let firstSubTaskId: string | null = null;

      for (let stackIdx = 0; stackIdx < subTasks.length; stackIdx++) {
        const effectiveTask = subTasks[stackIdx];
        if (effectiveTask === undefined) continue;

        // Skip if task with same (agent, description) already exists for this plan
        const sig = `${effectiveTask.agent}::${effectiveTask.description}`;
        if (existingSignatures.has(sig)) {
          continue;
        }

        // Allocate order_index via collision-safe helpers
        const orderIndex = needsSplit
          ? allocateSplitOrderIndex(parentOrder as number, stackIdx)
          : allocateOrderIndex(effectiveTask.orderIndex);

        const id = crypto.randomUUID();

        // Wire splitFrom to first sub-task id
        if (needsSplit && firstSubTaskId === null) {
          firstSubTaskId = id;
        }
        const taskMetadata = needsSplit
          ? { ...effectiveTask.metadata, splitFrom: firstSubTaskId }
          : (effectiveTask.metadata ?? {});

        // Defense-in-depth: try/catch UNIQUE constraint with retry on order_index.
        // The pre-loop allocation should prevent collisions, but if a race or
        // edge case triggers SQLITE_CONSTRAINT, reassign order_index and retry.
        let currentOrderIndex = orderIndex;
        let originalPlanData = JSON.stringify({
          description: effectiveTask.description,
          agent: effectiveTask.agent,
          files: effectiveTask.files ?? [],
          complexity: effectiveTask.complexity,
          dependencies: effectiveTask.dependencies ?? [],
          metadata: taskMetadata,
          orderIndex: currentOrderIndex,
          createdBy: effectiveTask.createdBy,
        });
        let inserted = false;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          try {
            db.query(
              `INSERT INTO plan_tasks (id, plan_id, order_index, description, agent, files, complexity, status, dependencies, metadata, created_by, updated_by, source_session_id, source_message_id, reviewed_by, tokens_used, duration_ms, artifacts, original_plan_data)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              id,
              planId,
              currentOrderIndex,
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
            inserted = true;
            break;
          } catch (err) {
            if (
              attempt < MAX_RETRIES - 1 &&
              err instanceof Error &&
              err.message.includes("UNIQUE")
            ) {
              // order_index collision — reassign and rebuild snapshot
              currentOrderIndex = allocateOrderIndex(undefined);
              originalPlanData = JSON.stringify({
                description: effectiveTask.description,
                agent: effectiveTask.agent,
                files: effectiveTask.files ?? [],
                complexity: effectiveTask.complexity,
                dependencies: effectiveTask.dependencies ?? [],
                metadata: taskMetadata,
                orderIndex: currentOrderIndex,
                createdBy: effectiveTask.createdBy,
              });
              continue;
            }
            throw err;
          }
        }
        if (!inserted) {
          throw new Error(
            `ndomo: failed to insert task after ${MAX_RETRIES} retries for plan ${planId}`,
          );
        }

        results.push({
          id,
          planId,
          orderIndex: currentOrderIndex,
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

  // Live-reactivity hook: notify subscribers for each newly-created task.
  // Emit OUTSIDE the transaction so subscribers never observe in-flight
  // batches that could roll back.
  const ts = Date.now();
  for (const task of results) {
    bus.emit({
      type: "task.created",
      taskId: task.id,
      planId: task.planId,
      agent: task.agent,
      description: task.description,
      timestamp: ts,
    });
  }

  return results;
}

/**
 * Create a single task on a plan.
 * Thin wrapper around createTasksBatch — auto-allocates next order_index.
 */
export function createTask(
  db: Database,
  planId: string,
  task: Omit<
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
    | "orderIndex"
  >,
): PlanTask {
  const created = createTasksBatch(db, planId, [{ ...task }]);
  return created[0]!;
}

/**
 * Reassign a task to a different agent (ADR-010 orchestration).
 * Updates agent + bumps updated_at. Emits task.updated event.
 */
export function reassignTask(
  db: Database,
  taskId: string,
  newAgent: string,
  opts: { updatedBy: string },
): PlanTask | null {
  if (!newAgent || typeof newAgent !== "string") {
    throw new Error("invalid agent — must be non-empty string");
  }
  const now = Date.now();
  // plan_tasks has created_by/updated_by (v3 audit fixes) but no updated_at column.
  // The original_plan_data JSON snapshot (v6) captures the agent at creation time.
  db.query("UPDATE plan_tasks SET agent = ?, updated_by = ? WHERE id = ?")
    .run(newAgent, opts.updatedBy, taskId);
  bus.emit({
    type: "task.updated",
    taskId: taskId,
    planId: "", // will be filled by getTask
    agent: newAgent,
    status: "pending", // will be filled by getTask
    timestamp: now,
  });
  return getTask(db, taskId);
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

/**
 * Deep merge source into target. Nested objects merge recursively,
 * arrays are replaced (not concatenated), primitives overwrite.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Truncate artifacts array so JSON.stringify fits within MAX_RESULT_BYTES.
 * Keeps first N elements that fit. Returns [truncatedArray, wasTruncated].
 */
function truncateArtifacts(artifacts: string[]): [string[], boolean] {
  const fullJson = JSON.stringify(artifacts);
  if (fullJson.length <= MAX_RESULT_BYTES) return [artifacts, false];
  const truncated: string[] = [];
  for (const item of artifacts) {
    const candidate = [...truncated, item];
    if (JSON.stringify(candidate).length > MAX_RESULT_BYTES) break;
    truncated.push(item);
  }
  return [truncated, true];
}

export function updateTaskStatus(
  db: Database,
  id: string,
  status: TaskStatus,
  fields?: {
    result?: string;
    error?: string;
    artifacts?: string[];
    metadataPatch?: Record<string, unknown>;
    reviewedBy?: string;
    reviewedVerdict?: string;
  },
  updatedBy?: string,
  ctx?: { agent?: string; sessionId?: string },
): TaskUpdateResult {
  // Capture prior status + planId BEFORE the UPDATE for status_changed emit
  // and so we always have the FK even when the UPDATE returns no row.
  const priorRow = db
    .query("SELECT status, plan_id FROM plan_tasks WHERE id = ?")
    .get(id) as { status: TaskStatus; plan_id: string } | undefined;
  const previousStatus = priorRow?.status;
  const planId = priorRow?.plan_id;

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

  // T1: artifacts — JSON.stringify, truncate array if >16KB
  if (fields?.artifacts !== undefined) {
    const [truncatedArr, wasTruncated] = truncateArtifacts(fields.artifacts);
    if (wasTruncated) {
      truncationInfo.truncated = true;
      truncationInfo.originalLength = JSON.stringify(fields.artifacts).length;
      truncationInfo.truncatedLength = MAX_RESULT_BYTES;
      console.warn(
        `ndomo: task_update_status ${id} — artifacts truncated from ${truncationInfo.originalLength} to ${MAX_RESULT_BYTES} bytes`,
      );
    }
    setClauses.push("artifacts = ?");
    params.push(JSON.stringify(truncatedArr));
  }

  // T1: reviewed_by column
  if (fields?.reviewedBy !== undefined) {
    setClauses.push("reviewed_by = ?");
    params.push(fields.reviewedBy);
  }

  // T1: metadataPatch (deep merge) + reviewedVerdict (stored in metadata)
  if (fields?.metadataPatch !== undefined || fields?.reviewedVerdict !== undefined) {
    const currentRow = db.query("SELECT metadata FROM plan_tasks WHERE id = ?").get(id) as
      | { metadata: string | null }
      | undefined;
    const currentMetadata: Record<string, unknown> = currentRow?.metadata
      ? JSON.parse(currentRow.metadata)
      : {};
    const patch: Record<string, unknown> = { ...(fields.metadataPatch ?? {}) };
    if (fields?.reviewedVerdict !== undefined) {
      patch.reviewedVerdict = fields.reviewedVerdict;
    }
    const merged = deepMerge(currentMetadata, patch);
    setClauses.push("metadata = ?");
    params.push(JSON.stringify(merged));
  }

  if (updatedBy !== undefined) {
    setClauses.push("updated_by = ?");
    params.push(updatedBy);
  }

  params.push(id);
  db.query(`UPDATE plan_tasks SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
  const task = getTask(db, id);
  if (!task) return null;

  // Live-reactivity hook: notify subscribers that the task changed.
  // task.updated always (catches result/error/metadataPatch changes);
  // task.status_changed only on actual status transitions.
  if (planId) {
    const ts = Date.now();
    bus.emit({
      type: "task.updated",
      taskId: task.id,
      planId,
      agent: task.agent,
      status: task.status,
      timestamp: ts,
    });
    if (previousStatus !== undefined && previousStatus !== status) {
      bus.emit({
        type: "task.status_changed",
        taskId: task.id,
        planId,
        agent: task.agent,
        previousStatus,
        status: task.status,
        timestamp: ts,
      });
    }
  }

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
 * Resolve a task's dependencies: classify each dep ID by its current status.
 * Throws if taskId is not found in the database.
 *
 * @returns Object with `canStart` (true iff all deps are 'done') and
 *   arrays categorizing each dep by status.
 */
export function resolveTaskDependencies(
  db: Database,
  taskId: string,
): {
  canStart: boolean;
  pendingDeps: string[];
  runningDeps: string[];
  failedDeps: string[];
  blockedDeps: string[];
  doneDeps: string[];
  missingDeps: string[];
  dependencies: string[];
} {
  const row = db
    .query("SELECT dependencies FROM plan_tasks WHERE id = ?")
    .get(taskId) as { dependencies: string } | undefined;
  if (!row) throw new Error(`ndomo: task ${taskId} not found`);

  const dependencies: string[] = (JSON.parse(row.dependencies) as string[]) ?? [];
  if (dependencies.length === 0) {
    return {
      canStart: true,
      pendingDeps: [],
      runningDeps: [],
      failedDeps: [],
      blockedDeps: [],
      doneDeps: [],
      missingDeps: [],
      dependencies,
    };
  }

  const pendingDeps: string[] = [];
  const runningDeps: string[] = [];
  const failedDeps: string[] = [];
  const blockedDeps: string[] = [];
  const doneDeps: string[] = [];
  const missingDeps: string[] = [];

  // Batch-fetch all dep statuses in one query
  const placeholders = dependencies.map(() => "?").join(",");
  const depRows = db
    .query(`SELECT id, status FROM plan_tasks WHERE id IN (${placeholders})`)
    .all(...dependencies) as Array<{ id: string; status: string }>;

  const statusMap = new Map<string, string>();
  for (const dr of depRows) {
    statusMap.set(dr.id, dr.status);
  }

  for (const depId of dependencies) {
    const st = statusMap.get(depId);
    if (st === undefined) {
      missingDeps.push(depId);
    } else if (st === "done") {
      doneDeps.push(depId);
    } else if (st === "pending") {
      pendingDeps.push(depId);
    } else if (st === "running") {
      runningDeps.push(depId);
    } else if (st === "failed") {
      failedDeps.push(depId);
    } else if (st === "blocked") {
      blockedDeps.push(depId);
    }
  }

  const canStart =
    doneDeps.length === dependencies.length;

  return {
    canStart,
    pendingDeps,
    runningDeps,
    failedDeps,
    blockedDeps,
    doneDeps,
    missingDeps,
    dependencies,
  };
}

/**
 * Atomically claim next pending task for agent.
 * Uses transaction (SELECT + UPDATE) to prevent race condition.
 * SQLite transactions are SERIALIZABLE — no concurrent claim possible.
 *
 * Respects task dependencies: a pending task is only claimed if all
 * entries in its `dependencies` JSON array have status='done'.
 */
export function nextTaskForAgent(
  db: Database,
  agent: string,
  opts: { planId?: string; includeArchived?: boolean } = {},
): PlanTask | null {
  const now = Date.now();
  const archiveFilter = opts.includeArchived ? "" : "AND archived_at IS NULL";

  return db.transaction(() => {
    // Fetch candidate pending tasks (cap at 100 for efficiency)
    const rows =
      opts.planId !== undefined
        ? (db
            .query(
              `SELECT * FROM plan_tasks
               WHERE agent = ? AND plan_id = ? AND status = 'pending' ${archiveFilter}
               ORDER BY order_index LIMIT 100`,
            )
            .all(agent, opts.planId) as unknown[])
        : (db
            .query(
              `SELECT * FROM plan_tasks
               WHERE agent = ? AND status = 'pending' ${archiveFilter}
               ORDER BY order_index LIMIT 100`,
            )
            .all(agent) as unknown[]);

    for (const row of rows) {
      const task = taskFromRow(row);

      // Check dependencies: all must be 'done'
      if (task.dependencies.length > 0) {
        const placeholders = task.dependencies.map(() => "?").join(",");
        const depRows = db
          .query(`SELECT id, status FROM plan_tasks WHERE id IN (${placeholders})`)
          .all(...task.dependencies) as Array<{ id: string; status: string }>;

        const statusMap = new Map<string, string>();
        for (const dr of depRows) {
          statusMap.set(dr.id, dr.status);
        }

        const allDone = task.dependencies.every((depId) => statusMap.get(depId) === "done");
        if (!allDone) continue; // skip — deps not met
      }

      // Claim this task
      db.query(
        `UPDATE plan_tasks SET status = 'running', started_at = ?, updated_by = ? WHERE id = ?`,
      ).run(now, agent, task.id);
      return { ...task, status: "running" as const, startedAt: now, updatedBy: agent };
    }

    return null;
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
