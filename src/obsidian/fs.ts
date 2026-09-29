/**
 * ndomo obsidian — filesystem helpers (atomic write, hash, tolerant reads).
 *
 * No DB access: pure fs + crypto utilities shared by the vault writer and the
 * sync-state store. Atomic-write pattern copied from src/db/ledgers.ts
 * (`<file>.<pid>.<date>.<rand>.tmp` + `renameSync` + cleanup on failure).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** `true` when `err` is a Node/Bun errno error carrying the given `code`. */
function isErrno(err: unknown, code: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  return "code" in err && err.code === code;
}

/** Full 64-char lowercase SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** `mkdir -p` (idempotent, recursive). */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Atomically write `content` to `filePath` via temp-file + rename.
 *
 * `rename(2)` is atomic on POSIX when source and destination share a
 * filesystem (they do — the temp lives beside the target), so a crash mid-write
 * never exposes a partially-written note. The parent directory is created if
 * missing and the temp file is unlinked on any failure.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup — temp removal failure is non-fatal.
    }
    throw err;
  }
}

/**
 * Read a UTF-8 file, returning `null` only when it does not exist.
 * Other I/O errors (EACCES, EISDIR…) propagate so callers can map them to
 * the IO_ERROR envelope instead of silently pretending the file is absent.
 */
export function readFileIfExists(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

/**
 * Unlink a file if present.
 * @returns `true` when a file was removed, `false` when it was already gone.
 */
export function deleteFileIfExists(filePath: string): boolean {
  try {
    unlinkSync(filePath);
    return true;
  } catch (err) {
    if (isErrno(err, "ENOENT")) return false;
    throw err;
  }
}
