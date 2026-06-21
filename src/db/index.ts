/**
 * Public DB API for ndomo.
 *
 * Re-exported so custom tools can `import { createPlan, openDb, ... } from "ndomo/db"`.
 * Named re-exports only (no `export *`) for explicitness and tree-shaking clarity.
 */

// ─── Client ──────────────────────────────────────────────────────────────────
export { closeDb, openDb } from "./client.ts";

// ─── Migrations ──────────────────────────────────────────────────────────────
export { runMigrations } from "./migrations.ts";
export type { ArchiveResult } from "./plan-archive.ts";
// ─── Plan Archive ────────────────────────────────────────────────────────────
export { archivePlan, resolveArchiveDir } from "./plan-archive.ts";
export type { PlanProgress } from "./plans.ts";
// ─── Plans ───────────────────────────────────────────────────────────────────
export {
  addPlanTag,
  approvePlan,
  createPlan,
  findPlansByCategory,
  findPlansByTag,
  getPlan,
  getPlanBySlug,
  getPlanProgress,
  getPlanTags,
  listPlans,
  removePlanTag,
  searchPlans,
  updatePlanStatus,
} from "./plans.ts";
// ─── Sessions ────────────────────────────────────────────────────────────────
export {
  appendAgentHistory,
  checkpointSession,
  endSession,
  getSession,
  listSessions,
  startSession,
} from "./sessions.ts";
export type { TaskTruncationInfo, TaskUpdateResult } from "./tasks.ts";
// ─── Tasks ───────────────────────────────────────────────────────────────────
export {
  addTaskTag,
  createTasksBatch,
  getTask,
  getTaskTags,
  listTasksByPlan,
  nextTaskForAgent,
  removeTaskTag,
  searchTasks,
  splitFilesByStack,
  updateTaskStatus,
} from "./tasks.ts";

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  Plan,
  PlanCategory,
  PlanMetadata,
  PlanStatus,
  PlanTask,
  Session,
  SessionMetadata,
  SessionOutcome,
  TaskMetadata,
  TaskStatus,
} from "./types.ts";
