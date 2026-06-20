/**
 * Git worktree manager for isolated coding lanes.
 *
 * Provides CRUD operations for git worktrees with persistent state tracking.
 * All git operations use async exec to avoid blocking the event loop.
 *
 * @module worktrees/manager
 */

import { exec as execCb } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCb);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Worktree {
  slug: string;
  branch: string;
  path: string;
  createdAt: number;
  status: "active" | "merged" | "abandoned";
  agent?: string | undefined;
  description?: string | undefined;
}

export interface WorktreeState {
  worktrees: Worktree[];
  updatedAt: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STATE_FILE = ".slim/worktrees.json";
const WORKTREE_DIR = ".slim/worktrees";

/** Regex for valid slug/branch names — alphanumeric, hyphens, underscores, slashes */
const SAFE_NAME_RE = /^[a-zA-Z0-9_\-/]+$/;

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate that a string is safe for use in git commands.
 * Prevents shell injection via slug or branch parameters.
 */
function assertSafeName(value: string, label: string): void {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (!SAFE_NAME_RE.test(value)) {
    throw new Error(
      `${label} contains invalid characters: "${value}". Only alphanumeric, hyphens, underscores, and slashes allowed.`,
    );
  }
  if (value.startsWith("-")) {
    throw new Error(`${label} must not start with a hyphen`);
  }
}

// ─── State Persistence ───────────────────────────────────────────────────────

/**
 * Load worktree state from disk.
 * Returns empty state if file doesn't exist or is malformed.
 */
export async function loadState(rootDir: string): Promise<WorktreeState> {
  const statePath = join(rootDir, STATE_FILE);
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as WorktreeState;
    // Defensive: ensure worktrees array exists
    if (!Array.isArray(parsed.worktrees)) {
      return { worktrees: [], updatedAt: Date.now() };
    }
    return parsed;
  } catch {
    return { worktrees: [], updatedAt: Date.now() };
  }
}

/**
 * Save worktree state to disk.
 * Creates .slim/ directory if needed.
 */
export async function saveState(rootDir: string, state: WorktreeState): Promise<void> {
  const slimDir = join(rootDir, ".slim");
  if (!existsSync(slimDir)) {
    await mkdir(slimDir, { recursive: true });
  }
  state.updatedAt = Date.now();
  await writeFile(join(rootDir, STATE_FILE), JSON.stringify(state, null, 2));
}

// ─── Worktree Operations ─────────────────────────────────────────────────────

/**
 * Create a new git worktree.
 *
 * @param rootDir - repository root directory
 * @param slug - short identifier (e.g., "auth-refactor", "fix-login")
 * @param branch - git branch name (created from current HEAD if doesn't exist)
 * @param agent - which agent will work in this worktree (optional)
 * @param description - human-readable description (optional)
 * @returns path to the new worktree
 * @throws if slug contains unsafe characters or worktree already exists
 */
export async function createWorktree(
  rootDir: string,
  slug: string,
  branch: string,
  agent?: string,
  description?: string,
): Promise<string> {
  assertSafeName(slug, "slug");
  assertSafeName(branch, "branch");

  const worktreePath = join(rootDir, WORKTREE_DIR, slug);

  // Check if already exists
  const state = await loadState(rootDir);
  const existing = state.worktrees.find((w) => w.slug === slug && w.status === "active");
  if (existing) {
    throw new Error(`Worktree '${slug}' already exists at ${existing.path}`);
  }

  // Create parent directory
  await mkdir(join(rootDir, WORKTREE_DIR), { recursive: true });

  // Git worktree add — try creating new branch first, fall back to existing branch
  try {
    await exec(`git worktree add -b ${branch} ${worktreePath}`, { cwd: rootDir });
  } catch {
    // Branch might already exist
    await exec(`git worktree add ${worktreePath} ${branch}`, { cwd: rootDir });
  }

  // Update state
  state.worktrees.push({
    slug,
    branch,
    path: worktreePath,
    createdAt: Date.now(),
    status: "active",
    agent,
    description,
  });
  await saveState(rootDir, state);

  return worktreePath;
}

/**
 * Remove a worktree.
 *
 * @param rootDir - repository root directory
 * @param slug - worktree identifier
 * @param abandon - if true, marks as abandoned instead of merged
 * @throws if no active worktree found with the given slug
 */
export async function removeWorktree(
  rootDir: string,
  slug: string,
  abandon = false,
): Promise<void> {
  assertSafeName(slug, "slug");

  const state = await loadState(rootDir);
  const wt = state.worktrees.find((w) => w.slug === slug && w.status === "active");
  if (!wt) {
    throw new Error(`No active worktree found with slug '${slug}'`);
  }

  // Remove git worktree, force if regular remove fails
  try {
    await exec(`git worktree remove ${wt.path}`, { cwd: rootDir });
  } catch {
    await exec(`git worktree remove --force ${wt.path}`, { cwd: rootDir });
  }

  wt.status = abandon ? "abandoned" : "merged";
  await saveState(rootDir, state);
}

/**
 * List all active worktrees.
 */
export async function listActive(rootDir: string): Promise<Worktree[]> {
  const state = await loadState(rootDir);
  return state.worktrees.filter((w) => w.status === "active");
}

/**
 * Get a specific worktree by slug.
 * Returns undefined if not found.
 */
export async function getWorktree(rootDir: string, slug: string): Promise<Worktree | undefined> {
  assertSafeName(slug, "slug");

  const state = await loadState(rootDir);
  return state.worktrees.find((w) => w.slug === slug);
}

/**
 * Cleanup all abandoned/merged worktrees older than maxAge (ms).
 *
 * @param rootDir - repository root directory
 * @param maxAge - max age in milliseconds (default: 7 days)
 * @returns list of removed worktree slugs
 */
export async function cleanup(
  rootDir: string,
  maxAge: number = 7 * 24 * 60 * 60 * 1000,
): Promise<string[]> {
  const state = await loadState(rootDir);
  const now = Date.now();
  const removed: string[] = [];

  for (const wt of state.worktrees) {
    if (wt.status !== "active" && now - wt.createdAt > maxAge) {
      // Remove directory if it still exists
      if (existsSync(wt.path)) {
        await rm(wt.path, { recursive: true, force: true });
      }
      removed.push(wt.slug);
    }
  }

  // Filter out removed entries
  state.worktrees = state.worktrees.filter((w) => !removed.includes(w.slug));
  await saveState(rootDir, state);

  return removed;
}
