/**
 * ndomo — OpenCode multi-agent plugin.
 *
 * Entry point. Import as a plugin in opencode.json:
 * ```jsonc
 * { "plugin": ["ndomo"] }
 * ```
 */
export { NdomoPlugin, type NdomoPluginOptions } from "./plugin.ts";
export type {
  RoutingDecision,
  TaskRequest,
  BackgroundTask,
  DispatchOptions,
  TaskResult,
  ReconciliationReport,
  MemoryEntry,
  Worktree,
  WorktreeState,
  IntegrityReport,
} from "./lib.ts";
export {
  routeTask,
  canRunParallel,
  BackgroundDispatcher,
  reconcileResults,
  cavemanCompress,
  prepareForMemory,
  shouldStoreMemory,
  getProjectTag,
  memorySearchOptions,
  createWorktree,
  listActive,
  removeWorktree,
  verifyIntegrity,
} from "./lib.ts";
