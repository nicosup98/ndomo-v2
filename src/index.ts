/**
 * ndomo — OpenCode multi-agent plugin.
 *
 * Entry point. Import as a plugin in opencode v2 config:
 * ```jsonc
 * { "plugins": ["ndomo"] }
 * ```
 */

export type {
  BackgroundTask,
  DispatchOptions,
  IntegrityReport,
  MemoryEntry,
  ReconciliationReport,
  RoutingDecision,
  TaskRequest,
  TaskResult,
  Worktree,
  WorktreeState,
} from "./lib.ts";
export {
  BackgroundDispatcher,
  canRunParallel,
  cavemanCompress,
  createWorktree,
  getProjectTag,
  listActive,
  memorySearchOptions,
  prepareForMemory,
  reconcileResults,
  removeWorktree,
  routeTask,
  shouldStoreMemory,
  verifyIntegrity,
} from "./lib.ts";
export { NdomoPlugin, type NdomoPluginOptions } from "./plugin.ts";
export { default } from "./plugin.ts";
