/**
 * Resolve the project directory for ndomo DB operations.
 *
 * Chains `worktree → directory → process.cwd()`, picking the first VALID
 * path (absolute, non-root, non-empty). When the opencode SDK passes an
 * invalid path (e.g. `ctx.directory="/"` for an empty project without
 * `.opencode/`, as observed with pgadmin), falls back to `process.cwd()`
 * so `.ndomo/` gets created in the user's actual CWD rather than at the
 * filesystem root (which would EACCES on `/.ndomo`).
 *
 * Validation in `openDb()` remains as a final defense-in-depth guard —
 * this helper is the "smart" layer, `openDb` is the "strict" layer.
 *
 * See plan bb805ff9 (auto-bootstrap-ndomo-dir-with-cwd-fallback).
 */

import { isAbsolute } from "node:path";

/**
 * Minimal slice of an opencode tool/plugin context that carries project
 * path hints. Both `worktree` and `directory` are optional in the SDK
 * (an empty project may yield `directory="/"`).
 */
export interface ProjectDirContext {
  worktree?: string | undefined;
  directory?: string | undefined;
}

/**
 * A path is "valid" for `.ndomo/` placement when it is:
 *   - a string (not undefined/null)
 *   - non-empty
 *   - not the filesystem root "/"
 *   - absolute (so `.ndomo` lands at a deterministic location)
 */
function isValidPath(p: string | undefined | null): p is string {
  return typeof p === "string" && p !== "" && p !== "/" && isAbsolute(p);
}

/**
 * Resolve the project directory to use for `.ndomo/state.db`.
 *
 * Resolution order:
 *   1. `ctx.worktree`  (git worktree root, when set)
 *   2. `ctx.directory` (opencode project directory)
 *   3. `process.cwd()` (default flow for projects without `.opencode/`,
 *      e.g. pgadmin — the SDK passes `directory="/"` and CWD is the
 *      expected, normal resolution, NOT an exception)
 *   4. throw — only if even `process.cwd()` is invalid (extremely unlikely;
 *      would indicate a misconfigured shell/env).
 *
 * Emits a `console.warn` only when `ctx.worktree` is present but invalid
 * (anomalous SDK config). The CWD fallback is silent because it is the
 * expected default for marker-only / no-`.opencode/` projects.
 */
export function resolveProjectDir(ctx: ProjectDirContext): string {
  if (isValidPath(ctx.worktree)) {
    return ctx.worktree;
  }
  if (isValidPath(ctx.directory)) {
    if (ctx.worktree) {
      console.warn(
        `[ndomo] ctx.worktree=${JSON.stringify(ctx.worktree)} invalid, using ctx.directory=${JSON.stringify(ctx.directory)}`,
      );
    }
    return ctx.directory;
  }
  const cwd = process.cwd();
  if (isValidPath(cwd)) {
    return cwd;
  }
  throw new Error(
    `resolveProjectDir: no valid project directory — ctx.worktree=${JSON.stringify(ctx.worktree)}, ctx.directory=${JSON.stringify(ctx.directory)}, process.cwd()=${JSON.stringify(cwd)}`,
  );
}
