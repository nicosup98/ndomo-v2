/**
 * Background task dispatcher for the ndomo orchestrator.
 * Tracks state of tasks delegated to specialist agents.
 *
 * DB-backed via bun:sqlite — persists across restarts.
 * The actual OpenCode task tool call is made by the foreman prompt —
 * this class is a pure state tracker, not an I/O layer.
 */

import type { Database } from "bun:sqlite";

/** Current state of a background task. */
export interface BackgroundTask {
  /** Unique task identifier (UUID v4). */
  id: string;
  /** Agent handling this task. */
  agent: string;
  /** What the agent is doing. */
  description: string;
  /** Lifecycle status. */
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  /** OpenCode session ID once the task is dispatched. */
  sessionId?: string;
  /** Agent output after completion. */
  result?: string;
  /** Epoch ms when the task was dispatched. */
  startedAt?: number;
  /** Epoch ms when the task finished (success or failure). */
  completedAt?: number;
  /** Epoch ms when the task was created. */
  createdAt: number;
  /** Files the agent should focus on. */
  files?: string[];
  /** Git worktree path for isolation. */
  worktree?: string;
}

/** Options for dispatching a new background task. */
export interface DispatchOptions {
  /** Which agent should handle this. */
  agent: string;
  /** Task description for the agent. */
  description: string;
  /** Files the agent should focus on. */
  files?: string[];
  /** Git worktree path for isolation (optional). */
  worktree?: string;
}

/** DB row shape from background_tasks table (snake_case). */
interface BackgroundTaskRow {
  id: string;
  agent: string;
  description: string;
  status: string;
  session_id: string | null;
  result: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  files: string | null;
  worktree: string | null;
}

/**
 * Background task state tracker backed by bun:sqlite.
 *
 * Usage:
 * ```ts
 * const dispatcher = new BackgroundDispatcher(db);
 * const id = dispatcher.dispatch({ agent: "scout", description: "Find auth flow" });
 * // ... later, when the task completes ...
 * dispatcher.markComplete(id, "Found auth in src/auth/middleware.ts");
 * ```
 */
export class BackgroundDispatcher {
  constructor(private db: Database) {}

  /**
   * Convert a DB row to a BackgroundTask object.
   * Deserializes JSON fields (files).
   */
  private rowToTask(row: BackgroundTaskRow): BackgroundTask {
    const task: BackgroundTask = {
      id: row.id,
      agent: row.agent,
      description: row.description,
      status: row.status as BackgroundTask["status"],
      createdAt: row.created_at,
    };
    if (row.session_id != null) task.sessionId = row.session_id;
    if (row.result != null) task.result = row.result;
    if (row.started_at != null) task.startedAt = row.started_at;
    if (row.completed_at != null) task.completedAt = row.completed_at;
    if (row.files != null) {
      try {
        task.files = JSON.parse(row.files) as string[];
      } catch {
        task.files = [];
      }
    }
    if (row.worktree != null) task.worktree = row.worktree;
    return task;
  }

  /**
   * Register a new background task and return its ID.
   * The task starts in "pending" status — the foreman is responsible
   * for calling markRunning() once the OpenCode task tool is invoked.
   *
   * @param options - Task configuration.
   * @returns Unique task ID (UUID v4).
   */
  dispatch(options: DispatchOptions): string {
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO background_tasks (id, agent, description, status, files, worktree) VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .run(
        id,
        options.agent,
        options.description,
        options.files ? JSON.stringify(options.files) : null,
        options.worktree ?? null,
      );
    return id;
  }

  /**
   * Transition a task to "running" status.
   *
   * @param taskId - Task to update.
   * @param sessionId - OpenCode session ID.
   */
  markRunning(taskId: string, sessionId: string): void {
    this.db
      .query(
        "UPDATE background_tasks SET status = 'running', session_id = ?, started_at = ? WHERE id = ?",
      )
      .run(sessionId, Date.now(), taskId);
  }

  /**
   * Get the current state of a task.
   *
   * @param taskId - Task ID to look up.
   * @returns Task state or undefined if not found.
   */
  getStatus(taskId: string): BackgroundTask | undefined {
    const row = this.db
      .query("SELECT * FROM background_tasks WHERE id = ?")
      .get(taskId) as BackgroundTaskRow | null;
    return row ? this.rowToTask(row) : undefined;
  }

  /**
   * Get all tasks that are currently pending or running.
   *
   * @returns Array of active tasks.
   */
  getActive(): BackgroundTask[] {
    const rows = this.db
      .query("SELECT * FROM background_tasks WHERE status IN ('pending', 'running')")
      .all() as BackgroundTaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Mark a task as successfully completed.
   *
   * @param taskId - Task to update.
   * @param result - Agent output.
   */
  markComplete(taskId: string, result: string): void {
    this.db
      .query(
        "UPDATE background_tasks SET status = 'completed', result = ?, completed_at = ? WHERE id = ?",
      )
      .run(result, Date.now(), taskId);
  }

  /**
   * Mark a task as failed.
   *
   * @param taskId - Task to update.
   * @param error - Error description.
   */
  markFailed(taskId: string, error: string): void {
    this.db
      .query(
        "UPDATE background_tasks SET status = 'failed', result = ?, completed_at = ? WHERE id = ?",
      )
      .run(error, Date.now(), taskId);
  }

  /**
   * Return completed or failed tasks that haven't been reconciled yet.
   * After calling this, the caller should process results and clear them.
   *
   * @returns Array of finished tasks.
   */
  reconcile(): BackgroundTask[] {
    const rows = this.db
      .query("SELECT * FROM background_tasks WHERE status IN ('completed', 'failed')")
      .all() as BackgroundTaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  /**
   * Remove a task from tracking (after reconciliation).
   *
   * @param taskId - Task to remove.
   */
  remove(taskId: string): void {
    this.db.query("DELETE FROM background_tasks WHERE id = ?").run(taskId);
  }

  /**
   * Get count of tasks by status.
   */
  stats(): {
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const rows = this.db
      .query("SELECT status, COUNT(*) as count FROM background_tasks GROUP BY status")
      .all() as Array<{ status: string; count: number }>;

    const counts = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of rows) {
      if (row.status in counts) {
        counts[row.status as keyof typeof counts] = row.count;
      }
    }
    return counts;
  }

  /**
   * Cancel a pending or running task.
   *
   * @param taskId - Task to cancel.
   * @returns true if the task was cancelled, false if it was already terminal.
   */
  cancel(taskId: string): boolean {
    const result = this.db
      .query(
        "UPDATE background_tasks SET status = 'cancelled', completed_at = ? WHERE id = ? AND status IN ('pending', 'running')",
      )
      .run(Date.now(), taskId);
    return result.changes > 0;
  }

  /**
   * List all tasks for a specific agent, newest first.
   *
   * @param agent - Agent name to filter by.
   * @returns Array of tasks for that agent.
   */
  listByAgent(agent: string): BackgroundTask[] {
    const rows = this.db
      .query("SELECT * FROM background_tasks WHERE agent = ? ORDER BY created_at DESC")
      .all(agent) as BackgroundTaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }
}
