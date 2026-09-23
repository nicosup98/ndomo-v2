/**
 * Project-scoped memory helpers over the ndomo identity tags (src/mem/tags.ts).
 * Provides convenience functions for tag resolution.
 */

import { getProjectTagInfo, getTags, getUserTagInfo } from "./tags.ts";

/**
 * Get the project tag for the current (or specified) working directory.
 *
 * @param cwd - Working directory. Defaults to process.cwd().
 * @returns Project tag string (e.g. "ndomo_project_3630017a493b9b23").
 */
export function getProjectTag(cwd?: string): string {
  return getProjectTagInfo(cwd ?? process.cwd()).tag;
}

/**
 * Get the user tag for the current system user.
 *
 * @returns User tag string (e.g. "ndomo_user_b3f8b37e159f9b98").
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
