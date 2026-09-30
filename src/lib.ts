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
export { getAllTags, getProjectTag, getUserTag } from "./mem/scoped.ts";
// Orchestrator: agent outcome history (history-aware routing signals)
export {
  type AgentHistory,
  type AgentHistoryOptions,
  type AgentScore,
  type AgentScoreOptions,
  bucketForTask,
  cellKey,
  emptyAgentHistory,
  emptyHistoryCell,
  HISTORY_HALF_LIFE_DAYS,
  HISTORY_MAX_ROWS_PER_CELL,
  HISTORY_MIN_CELL_N,
  HISTORY_PRIORS,
  type HistoryCell,
  type HistoryIntent,
  type HistoryStack,
  intentForAgent,
  loadAgentHistory,
  median,
  scoreAgentForBucket,
  stackBucketForTask,
  stackFromFiles,
} from "./orchestrator/agent-history.ts";
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
  DEFAULT_EXPLORE_EPSILON,
  type RouteOptions,
  type RoutingAlternative,
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
