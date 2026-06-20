/**
 * Worktree integrity verification.
 *
 * Checks that active worktrees have valid directories, branches,
 * and are properly registered with git.
 *
 * @module worktrees/state
 */

import { exec as execCb } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Worktree, WorktreeState } from "./manager.js";
import { loadState } from "./manager.js";

const exec = promisify(execCb);

export type { Worktree, WorktreeState };

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IntegrityReport {
  slug: string;
  pathExists: boolean;
  branchValid: boolean;
  gitWorktreeValid: boolean;
  issues: string[];
}

// ─── Integrity Checks ────────────────────────────────────────────────────────

/**
 * Verify integrity of all active worktrees.
 *
 * Checks per worktree:
 * 1. Directory exists on disk
 * 2. Branch exists in git
 * 3. Worktree is registered in `git worktree list`
 *
 * @param rootDir - repository root directory
 * @returns array of integrity reports (only for active worktrees)
 */
export async function verifyIntegrity(rootDir: string): Promise<IntegrityReport[]> {
  const state = await loadState(rootDir);
  const reports: IntegrityReport[] = [];

  // Get git worktree list once (not per-worktree)
  let gitWorktreeOutput = "";
  try {
    const { stdout } = await exec("git worktree list", { cwd: rootDir });
    gitWorktreeOutput = stdout;
  } catch {
    // If this fails, all worktrees will report the issue
  }

  for (const wt of state.worktrees) {
    if (wt.status !== "active") continue;

    const issues: string[] = [];
    const pathExists = existsSync(wt.path);

    // Check if worktree path appears in git worktree list
    const gitWorktreeValid = gitWorktreeOutput.includes(wt.path);

    // Check branch exists
    let branchValid = false;
    try {
      await exec(`git rev-parse --verify ${wt.branch}`, { cwd: rootDir });
      branchValid = true;
    } catch {
      issues.push(`branch '${wt.branch}' not found`);
    }

    if (!pathExists) issues.push(`directory '${wt.path}' missing`);
    if (!gitWorktreeValid) issues.push("worktree not registered with git");

    reports.push({
      slug: wt.slug,
      pathExists,
      branchValid,
      gitWorktreeValid,
      issues,
    });
  }

  return reports;
}
