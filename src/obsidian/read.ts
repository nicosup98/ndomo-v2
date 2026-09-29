/**
 * ndomo obsidian — `obsidian_read_note` executor (deps injected, never throws).
 *
 * Reads a note back from the vault either by vault-relative `path` or through
 * the sync-state (`entityType` + `entityId`, the same ids passed to
 * `obsidian_export`).
 *
 * Contract (design: `.ndomo/designs/2026-09-25-obsidian-brain-layer-design.md`):
 *
 * - **Never throws** — every failure is an {@link ObsidianEnvelope} error.
 *   `EACCES|EPERM|EROFS` → `VAULT_UNWRITABLE`, other fs errors → `IO_ERROR`
 *   (small mirrors of export.ts helpers: fs.ts stays DB-free and untouched).
 * - **Traversal-safe**: `path` must be vault-relative POSIX; absolute paths,
 *   backslashes and `..` segments are rejected BEFORE touching the fs, and the
 *   resolved absolute path is re-checked for strict lexical containment inside
 *   the vault root → `UNSAFE_PATH`.
 * - **Symlink-safe (realpath containment)**: lexical containment alone is not
 *   enough — `readFileIfExists` follows symlinks, so a note replaced by
 *   `ln -s /etc/passwd <note>` would exfiltrate host content. Every candidate
 *   (the caller `path` AND the sync-state entry path) therefore goes through
 *   {@link containedRealPath} first: `UNSAFE_PATH` when the real target leaves
 *   the real vault root, allowed when it stays inside (a symlink that points
 *   back into the vault is legitimate).
 * - **Known limitation (TOCTOU)**: the realpath check and the read are not
 *   atomic — a symlink swapped in that window could still be followed. The
 *   threat model here is a local, user-owned vault (a note replaced by an
 *   external link), not a racing attacker; a strict fix would need
 *   `O_NOFOLLOW`-style reads.
 * - **Missing file semantics**: a valid request whose file was deleted by hand
 *   still answers `{ok:true}` with `markdown: null` (the sync-state entry is
 *   the source of "where it should be"; the note itself is disposable). Only an
 *   absent sync-state entry is `ENTITY_NOT_FOUND`.
 * - `path` wins over `entityType`+`entityId` when both are supplied.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getProjectTagInfo } from "../mem/tags.ts";
import { readFileIfExists } from "./fs.ts";
import {
  checkVaultGuard,
  resolveVaultRoot,
  toVaultRelative,
  vaultPathShapeError,
} from "./paths.ts";
import { loadSyncState, syncEntryKey } from "./sync-state.ts";
import {
  isObsidianEntityType,
  type ObsidianConfig,
  type ObsidianEntityType,
  type ObsidianEnvelope,
  obsidianError,
} from "./types.ts";

// ─── Public contract ─────────────────────────────────────────────────────────

export type ReadDeps = {
  config: ObsidianConfig;
  projectDir: string;
};

export type ReadRequest = {
  /** Vault-relative POSIX path (`Projects/<tag>/…/<file>.md`). Wins over the entity lookup. */
  path?: string;
  entityType?: ObsidianEntityType;
  entityId?: string;
};

export type ReadData = {
  /** File contents, or `null` when the note no longer exists on disk. */
  markdown: string | null;
  /** Vault-relative path that was resolved. */
  path: string;
};

// ─── Error mapping helpers (mirrors export.ts) ───────────────────────────────

type ErrEnvelope = ReturnType<typeof obsidianError>;

function errnoOf(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code: unknown = err.code;
    if (typeof code === "string") return code;
  }
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * FS read failure → `VAULT_UNWRITABLE` (permission) / `IO_ERROR` (rest).
 * The envelope contract has no read-specific permission code, so a read
 * `EACCES` intentionally maps to `VAULT_UNWRITABLE` as well.
 */
function mapFsError(err: unknown, context: string): ErrEnvelope {
  const code = errnoOf(err);
  const message = `${context}: ${messageOf(err)}`;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return obsidianError(
      "VAULT_UNWRITABLE",
      message,
      "grant read permission on the note file inside the vault (obsidian.vaultPath)",
    );
  }
  return obsidianError(
    "IO_ERROR",
    message,
    "check obsidian.vaultPath and the note path, then retry the read",
  );
}

// ─── Path safety ─────────────────────────────────────────────────────────────

const PATH_HINT = 'pass a vault-relative path like "Projects/<tag>/10-Plans/<slug>.md"';

/** Rejection reason for a caller-supplied path, or `null` when shape-safe. */
function validateVaultRelative(raw: string): string | null {
  if (isAbsolute(raw)) return `path must be vault-relative, got absolute path "${raw}"`;
  if (raw.includes("\\")) return `path must use "/" separators (backslash in "${raw}")`;
  if (raw.split("/").some((segment) => segment === "..")) {
    return `path must not contain ".." segments ("${raw}")`;
  }
  return null;
}

/** Strict lexical containment: `target` must sit strictly below `root`. */
function isStrictlyInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "" || isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

type ContainedRealPath = { ok: true; path: string } | { ok: false };

/**
 * Realpath containment check (symlink escape guard).
 *
 * `isStrictlyInside` only compares STRINGS, while the read helper follows
 * symlinks: a note file swapped for `ln -s /etc/passwd <note>` passes the
 * lexical check and would leak host content into the tool response. So the
 * absolute candidate is canonicalized first and compared against the REAL
 * vault root (the root is materialized by `obsidian_export` before any read;
 * when it still cannot be canonicalized — e.g. a component is a dead link —
 * the lexical root is used, which keeps the check strict rather than loose).
 *
 * - File exists → `realpathSync(absolute)` must sit strictly inside the real
 *   root. A symlink that resolves back INSIDE the vault passes.
 * - File does not exist (ENOENT) → `{ok:true, path:absolute}`: there is no
 *   link to follow and the subsequent read answers `null`.
 * - Any other errno (EACCES, ELOOP, …) propagates so {@link mapFsError} keeps
 *   classifying it as `VAULT_UNWRITABLE` / `IO_ERROR`.
 *
 * @param root Vault root (absolute, already guard-checked).
 * @param absolute Candidate absolute path inside `root`.
 * @returns `{ok:false}` when the real target escapes the vault → caller
 *   answers `UNSAFE_PATH`.
 */
function containedRealPath(root: string, absolute: string): ContainedRealPath {
  let realTarget: string;
  try {
    realTarget = realpathSync(absolute);
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return { ok: true, path: absolute };
    throw err;
  }

  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // Fallback: keep the lexical root (still a strict, non-permissive check).
  }

  return isStrictlyInside(realRoot, realTarget) ? { ok: true, path: absolute } : { ok: false };
}

/** `UNSAFE_PATH` for a candidate whose real path leaves the vault. */
function symlinkEscape(rawPath: string, root: string): ErrEnvelope {
  return obsidianError(
    "UNSAFE_PATH",
    `"${rawPath}" resolves outside the vault: the symlink target is not inside ${root}`,
    PATH_HINT,
  );
}

/** Sync-state entries are trusted only as safe vault-relative POSIX paths. */
function isSafeVaultRelative(value: string): boolean {
  if (value.trim() === "" || isAbsolute(value) || value.includes("\\")) return false;
  return !value.split("/").some((segment) => segment === "..");
}

/**
 * Home rooting the sync-state namespace — `process.env.HOME` first (Bun
 * snapshots the env at process start, so an in-process HOME override would
 * otherwise miss it), `os.homedir()` as fallback. Mirrors export.ts so both
 * tools always agree on where the state lives.
 */
function resolveSyncHome(): string {
  const home = process.env.HOME;
  return home !== undefined && home.trim() !== "" ? home.trim() : homedir();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Read one note from the vault.
 *
 * @returns `{ok:true,data:{markdown,path}}` — `markdown` is `null` when the
 *   file is gone — or an error envelope. NEVER throws.
 */
export async function obsidianReadNote(
  deps: ReadDeps,
  req: ReadRequest,
): Promise<ObsidianEnvelope<ReadData>> {
  try {
    return readNote(deps, req);
  } catch (err) {
    return mapFsError(err, "obsidian_read_note failed");
  }
}

/** Synchronous core of {@link obsidianReadNote}. */
function readNote(deps: ReadDeps, req: ReadRequest): ObsidianEnvelope<ReadData> {
  if (deps.config.vaultPath.trim() === "") {
    return obsidianError(
      "NOT_CONFIGURED",
      "obsidian vaultPath is not configured",
      "set obsidian.vaultPath in ndomo.json or the NDOMO_OBSIDIAN_VAULT_PATH env var",
    );
  }
  if (!deps.config.enabled) {
    return obsidianError(
      "DISABLED",
      "obsidian projection is disabled (obsidian.enabled=false)",
      "set obsidian.enabled=true in ndomo.json to read projected notes",
    );
  }

  // Shape check FIRST: resolveVaultRoot() anchors a relative vaultPath to the
  // CWD, which would defeat checkVaultGuard()'s own UNSAFE_PATH branch.
  // A3: `expandHome(vaultPath)` + `isAbsolute` are evaluated on the CONFIGURED
  // string (vaultPathShapeError), i.e. before any absolutization, so
  // `vaultPath: "vault-rel"` reaches UNSAFE_PATH instead of being materialized
  // under the process CWD.
  const shapeError = vaultPathShapeError(deps.config.vaultPath);
  if (shapeError !== null) {
    return obsidianError(
      "UNSAFE_PATH",
      shapeError,
      "obsidian.vaultPath must be an absolute path (use ~/… for a home-relative vault)",
    );
  }

  let root: string;
  try {
    root = resolveVaultRoot(deps.config);
  } catch {
    return obsidianError(
      "NOT_CONFIGURED",
      "obsidian vaultPath is not configured",
      "set obsidian.vaultPath in ndomo.json or the NDOMO_OBSIDIAN_VAULT_PATH env var",
    );
  }

  const guard = checkVaultGuard(root, deps.projectDir, deps.config.allowInsideRepo);
  if (!guard.ok) {
    const hint =
      guard.code === "INSIDE_REPO"
        ? "point obsidian.vaultPath outside the repo, or set obsidian.allowInsideRepo=true when a vault inside the repo is intended"
        : "obsidian.vaultPath must be an absolute path (use ~/… for a home-relative vault)";
    return obsidianError(guard.code, guard.message, hint);
  }

  // 1) explicit vault-relative path.
  const rawPath = typeof req.path === "string" ? req.path.trim() : "";
  if (rawPath !== "") {
    const rejected = validateVaultRelative(rawPath);
    if (rejected !== null) return obsidianError("UNSAFE_PATH", rejected, PATH_HINT);

    const absolute = resolve(root, rawPath);
    if (!isStrictlyInside(root, absolute)) {
      return obsidianError("UNSAFE_PATH", `path escapes the vault ("${rawPath}")`, PATH_HINT);
    }
    // Symlink check BEFORE the read: `readFileIfExists` would happily follow a
    // note replaced by a link pointing outside the vault.
    if (!containedRealPath(root, absolute).ok) return symlinkEscape(rawPath, root);

    let markdown: string | null;
    try {
      markdown = readFileIfExists(absolute);
    } catch (err) {
      return mapFsError(err, `obsidian_read_note could not read "${rawPath}"`);
    }
    return { ok: true, data: { markdown, path: toVaultRelative(root, absolute) } };
  }

  // 2) entity lookup through the sync-state.
  const entityId = typeof req.entityId === "string" ? req.entityId.trim() : "";
  if (req.entityType === undefined || entityId === "") {
    return obsidianError(
      "IO_ERROR",
      "provide path or entityType+entityId",
      'pass a vault-relative `path`, or both `entityType` ("plan"|"task"|"design"|"memory") and `entityId`',
    );
  }
  if (!isObsidianEntityType(req.entityType)) {
    return obsidianError(
      "IO_ERROR",
      `invalid entityType "${String(req.entityType)}"`,
      "entityType must be one of: plan|task|design|memory",
    );
  }

  const entityType: ObsidianEntityType = req.entityType;
  const tag = getProjectTagInfo(deps.projectDir).tag;
  const { state } = loadSyncState(tag, resolveSyncHome());
  const entry = state.entries[syncEntryKey(entityType, entityId)];
  if (entry === undefined) {
    return obsidianError(
      "ENTITY_NOT_FOUND",
      `no exported note for ${entityType}:${entityId}`,
      "run obsidian_export for this entity first",
    );
  }
  if (!isSafeVaultRelative(entry.path)) {
    return obsidianError(
      "UNSAFE_PATH",
      `sync-state holds an unsafe path for ${entityType}:${entityId} ("${entry.path}")`,
      "delete that sync-state entry (~/.ndomo/obsidian/projects/<tag>/sync-state.json) and re-export",
    );
  }

  let markdown: string | null;
  const absolute = join(root, entry.path);
  // Same symlink guard as the `path` branch: the sync-state path is validated
  // as vault-relative, but the file behind it could still be a link pointing
  // out of the vault (human or another process replaced it).
  if (!containedRealPath(root, absolute).ok) {
    return obsidianError(
      "UNSAFE_PATH",
      `note for ${entityType}:${entityId} resolves outside the vault ("${entry.path}" is a symlink whose target is not inside ${root})`,
      `delete that sync-state entry (~/.ndomo/obsidian/projects/<tag>/sync-state.json), remove the stray symlink in the vault and re-export`,
    );
  }
  try {
    markdown = readFileIfExists(absolute);
  } catch (err) {
    return mapFsError(err, `obsidian_read_note could not read ${entityType}:${entityId}`);
  }
  return { ok: true, data: { markdown, path: entry.path } };
}
