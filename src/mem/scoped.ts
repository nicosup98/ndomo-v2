/**
 * Project-scoped memory helpers wrapping opencode-mem/tags.
 * Provides convenience functions for tag resolution and memory operations.
 */

import { getProjectTagInfo, getUserTagInfo, getTags } from "opencode-mem/tags";

/**
 * Get the project tag for the current (or specified) working directory.
 *
 * @param cwd - Working directory. Defaults to process.cwd().
 * @returns Project tag string (e.g. "project:ndomo:abc123").
 */
export function getProjectTag(cwd?: string): string {
  return getProjectTagInfo(cwd ?? process.cwd()).tag;
}

/**
 * Get the user tag for the current system user.
 *
 * @returns User tag string (e.g. "user:nico:xyz789").
 */
export function getUserTag(): string {
  return getUserTagInfo().tag;
}

/**
 * Get both user and project tags for a directory.
 *
 * @param cwd - Working directory. Defaults to process.cwd().
 * @returns Object with user and project TagInfo.
 */
export function getAllTags(cwd?: string) {
  return getTags(cwd ?? process.cwd());
}

/**
 * Build options object for a memory search operation.
 *
 * @param query - Search query text.
 * @param scope - Search scope: "project" (default) or "all-projects".
 * @returns Options object for the opencode-mem search API.
 */
export function memorySearchOptions(
  query: string,
  scope: "project" | "all-projects" = "project",
) {
  return {
    mode: "search" as const,
    query,
    scope,
  };
}

/**
 * Build options object for a memory add operation.
 *
 * @param content - Content to store in memory.
 * @param topic - Topic/category for the memory entry.
 * @returns Options object for the opencode-mem add API.
 */
export function memoryAddOptions(content: string, topic: string) {
  return {
    mode: "add" as const,
    content,
    topic,
  };
}
