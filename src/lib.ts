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

// Orchestrator: scheduler
export {
  routeTask,
  canRunParallel,
  type RoutingDecision,
  type TaskRequest,
} from "./orchestrator/scheduler.ts";

// Orchestrator: background dispatcher
export {
  BackgroundDispatcher,
  type BackgroundTask,
  type DispatchOptions,
} from "./orchestrator/background.ts";

// Orchestrator: result reconciliation
export {
  reconcileResults,
  type TaskResult,
  type ReconciliationReport,
} from "./orchestrator/reconciler.ts";

// Orchestrator: memory hooks
export {
  cavemanCompress,
  prepareForMemory,
  shouldStoreMemory,
  type MemoryEntry,
} from "./orchestrator/memory-hook.ts";

// Memory: scoped tag helpers
export {
  getProjectTag,
  getUserTag,
  getAllTags,
  memorySearchOptions,
  memoryAddOptions,
} from "./mem/scoped.ts";

// Worktrees: git worktree manager
export {
  createWorktree,
  removeWorktree,
  listActive,
  getWorktree,
  cleanup,
  loadState,
  saveState,
  type Worktree,
  type WorktreeState,
} from "./worktrees/manager.ts";

// Worktrees: integrity verification
export {
  verifyIntegrity,
  type IntegrityReport,
} from "./worktrees/state.ts";
