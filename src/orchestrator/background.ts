/**
 * Background task dispatcher for the ndomo orchestrator.
 * Tracks state of tasks delegated to specialist agents.
 *
 * The actual OpenCode task tool call is made by the foreman prompt —
 * this class is a pure state tracker, not an I/O layer.
 */

/** Current state of a background task. */
export interface BackgroundTask {
  /** Unique task identifier (UUID). */
  id: string;
  /** Agent handling this task. */
  agent: string;
  /** What the agent is doing. */
  description: string;
  /** Lifecycle status. */
  status: "pending" | "running" | "completed" | "failed";
  /** OpenCode session ID once the task is dispatched. */
  sessionId?: string;
  /** Agent output after completion. */
  result?: string;
  /** Epoch ms when the task was dispatched. */
  startedAt?: number;
  /** Epoch ms when the task finished (success or failure). */
  completedAt?: number;
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

/**
 * Generates a simple unique ID without external dependencies.
 * 8 hex chars from crypto gives 4 billion combinations — enough for task IDs.
 */
function generateId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Background task state tracker.
 *
 * Usage:
 * ```ts
 * const dispatcher = new BackgroundDispatcher();
 * const id = dispatcher.dispatch({ agent: "scout", description: "Find auth flow" });
 * // ... later, when the task completes ...
 * dispatcher.markComplete(id, "Found auth in src/auth/middleware.ts");
 * ```
 */
export class BackgroundDispatcher {
  private tasks: Map<string, BackgroundTask> = new Map();

  /**
   * Register a new background task and return its ID.
   * The task starts in "pending" status — the foreman is responsible
   * for calling markRunning() once the OpenCode task tool is invoked.
   *
   * @param options - Task configuration.
   * @returns Unique task ID.
   */
  dispatch(options: DispatchOptions): string {
    const id = generateId();
    const task: BackgroundTask = {
      id,
      agent: options.agent,
      description: options.description,
      status: "pending",
    };
    this.tasks.set(id, task);
    return id;
  }

  /**
   * Transition a task to "running" status.
   *
   * @param taskId - Task to update.
   * @param sessionId - OpenCode session ID.
   */
  markRunning(taskId: string, sessionId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "running";
    task.sessionId = sessionId;
    task.startedAt = Date.now();
  }

  /**
   * Get the current state of a task.
   *
   * @param taskId - Task ID to look up.
   * @returns Task state or undefined if not found.
   */
  getStatus(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks that are currently pending or running.
   *
   * @returns Array of active tasks.
   */
  getActive(): BackgroundTask[] {
    const active: BackgroundTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "pending" || task.status === "running") {
        active.push(task);
      }
    }
    return active;
  }

  /**
   * Mark a task as successfully completed.
   *
   * @param taskId - Task to update.
   * @param result - Agent output.
   */
  markComplete(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "completed";
    task.result = result;
    task.completedAt = Date.now();
  }

  /**
   * Mark a task as failed.
   *
   * @param taskId - Task to update.
   * @param error - Error description.
   */
  markFailed(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "failed";
    task.result = error;
    task.completedAt = Date.now();
  }

  /**
   * Return completed or failed tasks that haven't been reconciled yet.
   * After calling this, the caller should process results and clear them.
   *
   * @returns Array of finished tasks.
   */
  reconcile(): BackgroundTask[] {
    const finished: BackgroundTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === "completed" || task.status === "failed") {
        finished.push(task);
      }
    }
    return finished;
  }

  /**
   * Remove a task from tracking (after reconciliation).
   *
   * @param taskId - Task to remove.
   */
  remove(taskId: string): void {
    this.tasks.delete(taskId);
  }

  /**
   * Get count of tasks by status.
   */
  stats(): { pending: number; running: number; completed: number; failed: number } {
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case "pending":
          pending++;
          break;
        case "running":
          running++;
          break;
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
      }
    }

    return { pending, running, completed, failed };
  }
}
