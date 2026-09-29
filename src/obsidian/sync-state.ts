/**
 * ndomo obsidian — sync-state store (`~/.ndomo/obsidian/projects/<tag>/sync-state.json`).
 *
 * Lives OUTSIDE the vault: it is ndomo's own bookkeeping (which note was
 * written for each entity, and with which content hash), never human-editable
 * vault content. Keyed by `${entityType}:${entityId}` so a note keeps its path
 * even when the plan slug or kind changes later.
 *
 * DB-free + tolerant by contract: `loadSyncState` NEVER throws — a missing or
 * corrupt file degrades to a fresh empty state plus a warning string, so a
 * destroyed sync-state only means "re-project everything".
 * Writes go through the atomic temp+rename helper from ./fs.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "../mem/store.ts";
import { atomicWriteFileSync, readFileIfExists } from "./fs.ts";
import { sanitizeSegment } from "./paths.ts";
import {
  isObsidianEntityType,
  isObsidianKind,
  type ObsidianEntityType,
  type ObsidianKind,
  type ObsidianSyncEntry,
  type ObsidianSyncState,
} from "./types.ts";

/** Warning emitted when no sync-state file exists yet. */
const WARNING_MISSING = "sync-state missing";

/** Warning emitted for unparseable JSON or invalid shape. */
const WARNING_CORRUPT = "sync-state corrupt";

/** `${entityType}:${entityId}` — the sync-state map key. */
export function syncEntryKey(entityType: ObsidianEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** Empty state for a project (version 1, no entries). */
export function freshSyncState(projectTag: string): ObsidianSyncState {
  return { version: 1, projectTag, entries: {} };
}

/**
 * Absolute path of the sync-state file for a project tag.
 * `homeDir` defaults to the user home and is expanded (`~/…`) when given, so
 * tests can pass an isolated tmp dir and never touch the real `~`.
 */
export function syncStatePath(projectTag: string, homeDir?: string): string {
  const home = expandHome(homeDir ?? homedir());
  return join(
    home,
    ".ndomo",
    "obsidian",
    "projects",
    sanitizeSegment(projectTag),
    "sync-state.json",
  );
}

/** Narrowing helper for JSON values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `plan|task|design|memory:id` — anything else is dropped as corrupt. */
function isValidKey(key: string): boolean {
  const sepIndex = key.indexOf(":");
  if (sepIndex <= 0) return false;
  return isObsidianEntityType(key.slice(0, sepIndex)) && key.slice(sepIndex + 1).length > 0;
}

/** Validate one serialized entry; `null` means "drop it". */
function parseEntry(value: unknown): ObsidianSyncEntry | null {
  if (!isRecord(value)) return null;
  const { path, kind, hash, createdAt, updatedAt, lastCheckedAt } = value;
  if (typeof path !== "string" || path.length === 0) return null;
  if (!isObsidianKind(kind)) return null;
  if (typeof hash !== "string" || hash.length === 0) return null;
  if (!isFiniteNumber(createdAt) || !isFiniteNumber(updatedAt) || !isFiniteNumber(lastCheckedAt)) {
    return null;
  }
  return { path, kind, hash, createdAt, updatedAt, lastCheckedAt };
}

/**
 * Load the sync-state for a project. NEVER throws.
 *
 * Missing file → fresh state + `"sync-state missing"`.
 * Invalid JSON / top-level shape → fresh state + `"sync-state corrupt"`.
 * Individual bad entries are dropped (partial state preserved) and reported
 * with the same corrupt warning.
 *
 * @param projectTag Container tag (`ndomo_project_<hash>`); sanitized for the
 *   directory name only — `state.projectTag` is always normalized to this tag.
 */
export function loadSyncState(
  projectTag: string,
  homeDir?: string,
): { state: ObsidianSyncState; warning: string | null } {
  const fresh = freshSyncState(projectTag);
  const raw = readFileIfExists(syncStatePath(projectTag, homeDir));
  if (raw === null) return { state: fresh, warning: WARNING_MISSING };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: fresh, warning: WARNING_CORRUPT };
  }

  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) {
    return { state: fresh, warning: WARNING_CORRUPT };
  }

  const entries: Record<string, ObsidianSyncEntry> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (!isValidKey(key)) {
      dropped += 1;
      continue;
    }
    const entry = parseEntry(value);
    if (entry === null) {
      dropped += 1;
      continue;
    }
    entries[key] = entry;
  }

  return {
    state: { version: 1, projectTag, entries },
    warning: dropped > 0 ? WARNING_CORRUPT : null,
  };
}

/** Persist a state atomically (temp + rename) under the project namespace. */
export function saveSyncState(
  projectTag: string,
  state: ObsidianSyncState,
  homeDir?: string,
): void {
  atomicWriteFileSync(syncStatePath(projectTag, homeDir), `${JSON.stringify(state, null, 2)}\n`);
}

/** Idempotency probe: does the stored entry already carry `hash`? */
export function hashEquals(
  state: ObsidianSyncState,
  entityType: ObsidianEntityType,
  entityId: string,
  hash: string,
): boolean {
  const entry = state.entries[syncEntryKey(entityType, entityId)];
  return entry !== undefined && entry.hash === hash;
}

/**
 * Insert or update one entry in place (caller persists via {@link saveSyncState}).
 *
 * - `createdAt` is preserved from the existing entry (falls back to the patch
 *   value, then to `now`) so note age survives re-exports.
 * - `updatedAt` only advances when the content hash actually changed.
 * - `lastCheckedAt` always advances (evidence of a fresh check).
 * - `now` is injectable so tests stay deterministic.
 */
export function upsertEntry(
  state: ObsidianSyncState,
  entityType: ObsidianEntityType,
  entityId: string,
  patch: { path: string; kind: ObsidianKind; hash: string; createdAt?: number },
  now?: number,
): void {
  const stamp = now ?? Date.now();
  const key = syncEntryKey(entityType, entityId);
  const previous = state.entries[key];
  const hashChanged = previous === undefined || previous.hash !== patch.hash;

  state.entries[key] = {
    path: patch.path,
    kind: patch.kind,
    hash: patch.hash,
    createdAt: previous?.createdAt ?? patch.createdAt ?? stamp,
    updatedAt: hashChanged ? stamp : (previous?.updatedAt ?? stamp),
    lastCheckedAt: stamp,
  };
}
