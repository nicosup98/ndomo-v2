/**
 * ndomo obsidian — shared contract types for the projection layer.
 *
 * DB-free (no SQLite, no fs): type declarations, two closed vocabularies and
 * tiny runtime helpers used by path builders / sync-state / export tools.
 *
 * Errors surface as {@link ObsidianEnvelope} values instead of thrown strings
 * so the `obsidian_*` tools never break the agent session (design:
 * `.ndomo/designs/2026-09-25-obsidian-brain-layer-design.md`).
 */

/** Folder-classification taxonomy (maps 1:1 to `FOLDER_BY_KIND`). */
export type ObsidianKind =
  | "feature"
  | "bugfix"
  | "refactor"
  | "infra"
  | "design"
  | "docs"
  | "research"
  | "other";

/** Entity families that can be projected to the vault. */
export type ObsidianEntityType = "plan" | "task" | "design" | "memory";

/**
 * Config block resolved once at plugin setup (loader lives in
 * src/config/schema.ts). `vaultPath` is mandatory and must point OUTSIDE the
 * repo unless `allowInsideRepo` is explicitly true.
 */
export type ObsidianConfig = {
  enabled: boolean;
  vaultPath: string;
  allowInsideRepo: boolean;
};

/** Closed kind vocabulary — validates the optional `kind?` tool override. */
export const OBSIDIAN_KINDS: readonly ObsidianKind[] = [
  "feature",
  "bugfix",
  "refactor",
  "infra",
  "design",
  "docs",
  "research",
  "other",
];

/** Closed entity vocabulary — validates sync-state `type:id` keys. */
export const OBSIDIAN_ENTITY_TYPES: readonly ObsidianEntityType[] = [
  "plan",
  "task",
  "design",
  "memory",
];

/** Type guard for caller-supplied kind overrides. */
export function isObsidianKind(value: unknown): value is ObsidianKind {
  return typeof value === "string" && OBSIDIAN_KINDS.some((kind) => kind === value);
}

/** Type guard for caller-supplied entity types (sync-state keys, read_note). */
export function isObsidianEntityType(value: unknown): value is ObsidianEntityType {
  return typeof value === "string" && OBSIDIAN_ENTITY_TYPES.some((type) => type === value);
}

/** Stable error codes returned by the obsidian tools (never thrown). */
export type ObsidianErrorCode =
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "INSIDE_REPO"
  | "ENTITY_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "UNSAFE_PATH"
  | "INVALID_KIND"
  | "VAULT_UNWRITABLE"
  | "IO_ERROR";

/**
 * Result envelope. `hint` is optional: build it with a conditional spread or
 * with {@link obsidianError} (never `hint: undefined` — exactOptionalPropertyTypes).
 */
export type ObsidianEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ObsidianErrorCode; message: string; hint?: string } };

/**
 * Build an error envelope, omitting `hint` entirely when not provided.
 * Synchronous/pure helper so every tool can answer with a uniform shape.
 */
export function obsidianError(
  code: ObsidianErrorCode,
  message: string,
  hint?: string,
): { ok: false; error: { code: ObsidianErrorCode; message: string; hint?: string } } {
  return {
    ok: false,
    error: hint === undefined ? { code, message } : { code, message, hint },
  };
}

/** One projected note tracked in sync-state (hash = auto-payload SHA-256). */
export type ObsidianSyncEntry = {
  path: string;
  kind: ObsidianKind;
  hash: string;
  createdAt: number;
  updatedAt: number;
  lastCheckedAt: number;
};

/** Persisted mapping `${entityType}:${entityId}` → {@link ObsidianSyncEntry}. */
export type ObsidianSyncState = {
  version: 1;
  projectTag: string;
  entries: Record<string, ObsidianSyncEntry>;
};
