/**
 * Public DB API for ndomo.
 *
 * Re-exported so custom tools can `import { createPlan, openDb, ... } from "ndomo/db"`.
 * Named re-exports only (no `export *`) for explicitness and tree-shaking clarity.
 */

// ─── Analyses (v14) ────────────────────────────────────────────────────────
export {
  archiveAnalysis,
  createAnalysis,
  getAnalysis,
  getAnalysisBySlug,
  linkAnalysisToPlan,
  listAnalyses,
  searchAnalyses,
  unlinkAnalysisFromPlan,
  updateAnalysis,
} from "./analyses.ts";
// ─── Client ──────────────────────────────────────────────────────────────────
export { closeDb, openDb } from "./client.ts";
export type {
  CriticReview,
  CriticReviewInput,
  CriticScores,
  CriticVerdict,
} from "./critic.ts";
// ─── Critic review protocol (v17 / T2) ─────────────────────────────────────
export {
  buildCriticReview,
  CRITIC_VERDICTS,
  toTaskVerification,
} from "./critic.ts";
// Design types live in designs.ts (filesystem-backed module, not the SQL types file).
export type {
  DesignInput,
  DesignOption,
  DesignResult,
  DesignStatus,
} from "./designs.ts";
// ─── Design documents (filesystem-backed, no DB) ────────────────────────────
export {
  buildDesignFilename,
  createDesign,
  deriveDesignStatus,
  resolveDesignDir,
  sanitizeDesignSlug,
  serializeDesignToMarkdown,
  validateDesignDate,
  validateDesignSlug,
} from "./designs.ts";
export type { LedgerData, LedgerWriteResult } from "./ledgers.ts";
// ─── Session ledgers (filesystem continuity, no DB) ─────────────────────────
export {
  getLedgerFilePath,
  parseLedgerFromMarkdown,
  readLedger,
  readLedgerRaw,
  resolveLedgerDir,
  sanitizeSessionId,
  serializeLedgerToMarkdown,
  sessionToLedgerData,
  validateSessionId,
  writeLedger,
} from "./ledgers.ts";
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
  updatePlanFields,
  updatePlanStatus,
} from "./plans.ts";
export type { ProjectDirContext } from "./resolve-project-dir.ts";
// ─── Project dir resolution ──────────────────────────────────────────────────
export { resolveProjectDir } from "./resolve-project-dir.ts";
export type { CheckpointLedgerOptions } from "./sessions.ts";
// ─── Sessions ────────────────────────────────────────────────────────────────
export {
  appendAgentHistory,
  checkpointSession,
  endSession,
  getSession,
  listSessions,
  startSession,
} from "./sessions.ts";
export type {
  TaskTruncationInfo,
  TaskUpdateResult,
  TaskVerificationResult,
  TaskVerificationVerdict,
} from "./tasks.ts";
// ─── Tasks ───────────────────────────────────────────────────────────────────
export {
  addTaskTag,
  createTask,
  createTasksBatch,
  getTask,
  getTaskTags,
  listTasksByPlan,
  nextTaskForAgent,
  reassignTask,
  recordTaskVerification,
  removeTaskTag,
  searchTasks,
  splitFilesByStack,
  updateTaskStatus,
} from "./tasks.ts";
// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  Analysis,
  InsertAnalysis,
  Plan,
  PlanCategory,
  PlanMetadata,
  PlanOwner,
  PlanStatus,
  PlanTask,
  Session,
  SessionMetadata,
  SessionOutcome,
  TaskMetadata,
  TaskStatus,
  TaskVerificationStatus,
} from "./types.ts";
