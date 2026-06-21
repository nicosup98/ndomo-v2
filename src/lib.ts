/**
 * ndomo — OpenCode multi-agent orchestrator.
 *
 * Entry point that re-exports all public APIs.
 *
 * @example
 * ```ts
 * import { routeTask, BackgroundDispatcher, cavemanCompress } from "ndomo";
 * ```
 */

// Memory: scoped tag helpers
export {
  getAllTags,
  getProjectTag,
  getUserTag,
  memoryAddOptions,
  memorySearchOptions,
} from "./mem/scoped.ts";

// Orchestrator: background dispatcher
export {
  BackgroundDispatcher,
  type BackgroundTask,
  type DispatchOptions,
} from "./orchestrator/background.ts";
// Orchestrator: memory hooks
export {
  cavemanCompress,
  type MemoryEntry,
  prepareForMemory,
  shouldStoreMemory,
} from "./orchestrator/memory-hook.ts";
// Orchestrator: result reconciliation
export {
  type ReconciliationReport,
  reconcileResults,
  type TaskResult,
} from "./orchestrator/reconciler.ts";
// Orchestrator: scheduler
export {
  canRunParallel,
  type RoutingDecision,
  routeTask,
  type TaskRequest,
} from "./orchestrator/scheduler.ts";

// Worktrees: git worktree manager
export {
  cleanup,
  createWorktree,
  getWorktree,
  listActive,
  loadState,
  removeWorktree,
  saveState,
  type Worktree,
  type WorktreeState,
} from "./worktrees/manager.ts";

// Worktrees: integrity verification
export {
  type IntegrityReport,
  verifyIntegrity,
} from "./worktrees/state.ts";
