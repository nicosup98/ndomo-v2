/**
 * Public DB API for ndomo.
 *
 * Re-exported so custom tools can `import { createPlan, openDb, ... } from "ndomo/db"`.
 * Named re-exports only (no `export *`) for explicitness and tree-shaking clarity.
 */

// ─── Client ──────────────────────────────────────────────────────────────────
export { openDb, closeDb } from "./client.ts";

// ─── Migrations ──────────────────────────────────────────────────────────────
export { runMigrations } from "./migrations.ts";

// ─── Plans ───────────────────────────────────────────────────────────────────
export {
  createPlan,
  getPlan,
  getPlanBySlug,
  listPlans,
  searchPlans,
  approvePlan,
  updatePlanStatus,
  addPlanTag,
  removePlanTag,
  getPlanTags,
  findPlansByTag,
  findPlansByCategory,
  getPlanProgress,
} from "./plans.ts";
export type { PlanProgress } from "./plans.ts";

// ─── Plan Archive ────────────────────────────────────────────────────────────
export { archivePlan, resolveArchiveDir } from "./plan-archive.ts";
export type { ArchiveResult } from "./plan-archive.ts";

// ─── Tasks ───────────────────────────────────────────────────────────────────
export {
  createTasksBatch,
  getTask,
  listTasksByPlan,
  updateTaskStatus,
  searchTasks,
  nextTaskForAgent,
  addTaskTag,
  removeTaskTag,
  getTaskTags,
  splitFilesByStack,
} from "./tasks.ts";
export type { TaskUpdateResult, TaskTruncationInfo } from "./tasks.ts";

// ─── Sessions ────────────────────────────────────────────────────────────────
export {
  startSession,
  getSession,
  listSessions,
  checkpointSession,
  appendAgentHistory,
  endSession,
} from "./sessions.ts";

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  Plan,
  PlanStatus,
  PlanCategory,
  PlanMetadata,
  PlanTask,
  TaskStatus,
  TaskMetadata,
  Session,
  SessionOutcome,
  SessionMetadata,
} from "./types.ts";
