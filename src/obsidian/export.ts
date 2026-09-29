/**
 * ndomo obsidian — `obsidian_export` executor (deps injected, never throws).
 *
 * Projects plan / task / design / memory rows from the project DB (and the
 * embedded memory DB) into normalized markdown notes inside the external
 * Obsidian vault, tracking every write in the sync-state so re-exports are
 * idempotent (`hash equal → skipped`).
 *
 * Contract (design: `.ndomo/designs/2026-09-25-obsidian-brain-layer-design.md`):
 *
 * - **Never throws.** The whole body runs under one try/catch: any unexpected
 *   failure becomes an {@link ObsidianEnvelope} error so an agent session is
 *   never interrupted. FS failures map `EACCES|EPERM|EROFS` → `VAULT_UNWRITABLE`,
 *   everything else → `IO_ERROR`.
 * - **Deps injected** ({@link ExportDeps}): project DB handle, project dir,
 *   memory storage path and the resolved config — no module-level state, so
 *   the executor runs against tmp dirs in tests.
 * - **Path stability.** The sync-state owns the authoritative note path. A
 *   changed slug does NOT move the file (the entry keeps its `path`); only a
 *   KIND change migrates the note (`entry.kind !== kind` → write the canonical
 *   path and delete the old file, carrying the human section over). Task links
 *   inside a plan note honor the stored path too, so a slug rename never
 *   points a wiki link at a file that does not exist.
 * - **`scope=plan` is fail-fast**: the plan and its non-archived tasks are
 *   projected in order and the FIRST failing entity aborts the whole call with
 *   one error envelope. Each unit persists the sync-state right after writing,
 *   so already-projected notes keep their entry and a retry resumes cleanly.
 * - **`kind?` applies to every entity of the call** (with `scope=plan` that
 *   includes the tasks; otherwise tasks inherit/derive as usual).
 * - `scope=plan` + non-`plan` entityType is a caller error → `IO_ERROR`
 *   (documented decision: `scope` is only meaningful for plans).
 * - `entityId` is the sync-state key exactly as the caller passed it, so
 *   `obsidian_read_note` must be called with the same id.
 */

import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getPlan } from "../db/plans.ts";
import { getTask, listTasksByPlan } from "../db/tasks.ts";
import type { Plan } from "../db/types.ts";
import { getMemory, type MemRecord, openMemDb } from "../mem/store.ts";
import { getProjectTagInfo } from "../mem/tags.ts";
import { type DesignSource, readDesignSource } from "./design-source.ts";
import { sha256Hex } from "./fs.ts";
import {
  resolveMemoryKind,
  resolvePlanKind,
  resolveTaskKind,
  validateKindOverride,
} from "./kind.ts";
import {
  checkVaultGuard,
  designNotePath,
  ensureVaultRoot,
  memoryNotePath,
  planNotePath,
  resolveVaultRoot,
  sanitizeSegment,
  taskNotePath,
  toVaultRelative,
  vaultPathShapeError,
} from "./paths.ts";
import {
  type PlanNoteTaskRef,
  type RenderedNote,
  renderDesignNote,
  renderMemoryNote,
  renderPlanNote,
  renderTaskNote,
  resolveNoteContent,
} from "./render.ts";
import { loadSyncState, saveSyncState, syncEntryKey, upsertEntry } from "./sync-state.ts";
import {
  OBSIDIAN_KINDS,
  type ObsidianConfig,
  type ObsidianEntityType,
  type ObsidianEnvelope,
  type ObsidianKind,
  type ObsidianSyncState,
  obsidianError,
} from "./types.ts";

// ─── Public contract ─────────────────────────────────────────────────────────

/** Everything the executor needs (no globals — the plugin wires these once). */
export type ExportDeps = {
  db: Database;
  projectDir: string;
  memStoragePath: string;
  config: ObsidianConfig;
};

export type ExportRequest = {
  entityType: ObsidianEntityType;
  entityId: string;
  scope?: "single" | "plan";
  kind?: string;
};

export type ExportItemStatus = "exported" | "skipped";

/** One projected entity (or the reason it was skipped). `path` is vault-relative. */
export type ExportItem = {
  entityType: ObsidianEntityType;
  entityId: string;
  status: ExportItemStatus;
  path: string;
  kind: ObsidianKind;
};

export type ExportData = {
  items: ExportItem[];
  /** `loadSyncState` warning (`sync-state missing|corrupt`) or `null`. */
  warning: string | null;
};

// ─── Internal shapes ─────────────────────────────────────────────────────────

/** Error branch of the envelope, narrowed without re-declaring the union. */
type ErrEnvelope = ReturnType<typeof obsidianError>;

/** A fully resolved entity: what to write and where (canonical, vault-relative). */
type ResolvedUnit = {
  entityType: ObsidianEntityType;
  entityId: string;
  kind: ObsidianKind;
  canonicalPath: string;
  generated: RenderedNote;
};

type ResolveResult = ResolvedUnit | ErrEnvelope;

type Target = { entityType: ObsidianEntityType; entityId: string };

/** `true` when resolution produced an error envelope. */
function isErr(result: ResolveResult): result is ErrEnvelope {
  return "ok" in result;
}

// ─── Error mapping helpers ───────────────────────────────────────────────────

/** Node/Bun errno string (`"EACCES"`, …) when the error carries one. */
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
 * FS/DB failure → `VAULT_UNWRITABLE` (permission) / `IO_ERROR` (rest).
 *
 * `hint` is contextual on purpose: "read the entity", "open the embedded
 * memory DB" and "write the vault" are three different repairs, and a single
 * generic hint would send an operator to the wrong file. The CODE never
 * changes with the context (stable contract).
 */
function mapFsError(err: unknown, context: string, hint?: string): ErrEnvelope {
  const code = errnoOf(err);
  const message = `${context}: ${messageOf(err)}`;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return obsidianError(
      "VAULT_UNWRITABLE",
      message,
      hint ??
        "grant read/write permission on the vault directory (obsidian.vaultPath), or point it at a writable location",
    );
  }
  return obsidianError("IO_ERROR", message, hint ?? WRITE_VAULT_HINT);
}

/** Hint for failures while READING an entity from the project DB / design dir. */
const READ_ENTITY_HINT =
  "check that the entity exists (plan_list / task_list / mem_list, or a file inside .ndomo/designs/) and that the project state.db is readable";

/** Hint for failures while OPENING the embedded memory DB. */
const MEM_DB_HINT =
  "check NDOMO_MEM_STORAGE_PATH (or ndomo.json mem.storagePath): the memory DB file or its directory must be readable";

/** Hint for failures while WRITING a note into the vault. */
const WRITE_VAULT_HINT =
  "grant write permission on the vault directory (obsidian.vaultPath), check free space, then retry the export";

/**
 * A sync-state `path` is trusted only when it is a vault-relative POSIX path:
 * a hand-edited entry with `..` or an absolute path must never be joined to
 * the vault root (it would escape it). Unsafe entries are treated as absent.
 */
function isSafeVaultRelative(value: string): boolean {
  if (value.trim() === "" || isAbsolute(value) || value.includes("\\")) return false;
  return !value.split("/").some((segment) => segment === "..");
}

/** First ATX heading (`# …`) of a document, trimmed; none → `null`. */
function firstHeading(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return null;
}

/**
 * Home directory that roots the sync-state namespace (`~/.ndomo/obsidian/…`).
 *
 * `process.env.HOME` wins over `os.homedir()`: Bun snapshots the environment at
 * process start, so a test that rewrites HOME in-process would otherwise still
 * resolve the real home and write sync-state into the developer's `~/.ndomo`.
 * Outside tests HOME and `homedir()` agree; `homedir()` remains the fallback
 * (e.g. Windows, where HOME may be unset).
 */
function resolveSyncHome(): string {
  const home = process.env.HOME;
  return home !== undefined && home.trim() !== "" ? home.trim() : homedir();
}

// ─── Memory DB handle (mirrors plugin.withMemDb — open/close around one call) ─

function withMemDb<T>(projectTag: string, storagePath: string, fn: (db: Database) => T): T {
  const db = openMemDb(projectTag, storagePath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ─── Entity resolution (DB/file → render input + kind + canonical path) ──────

/** Plan note + its task references (non-archived, sorted by `orderIndex`). */
function resolvePlanUnit(
  deps: ExportDeps,
  plan: Plan,
  entityId: string,
  tag: string,
  root: string,
  state: ObsidianSyncState,
  kindOverride: ObsidianKind | null,
): ResolvedUnit {
  const kind = kindOverride ?? resolvePlanKind(plan);

  const tasks: PlanNoteTaskRef[] = listTasksByPlan(deps.db, plan.id)
    .filter((task) => task.archivedAt === null)
    .map((task) => {
      const taskKind = resolveTaskKind(task, kind);
      const canonical = toVaultRelative(
        root,
        taskNotePath(root, tag, taskKind, plan.slug, task.orderIndex, task.id),
      );
      // Path stability applies to the links too: when the task note already
      // lives at its stored path (same kind), link to THAT file instead of the
      // canonical one a later slug rename would produce.
      const stored = state.entries[syncEntryKey("task", task.id)];
      const path =
        stored !== undefined && stored.kind === taskKind && isSafeVaultRelative(stored.path)
          ? stored.path
          : canonical;
      return {
        id: task.id,
        orderIndex: task.orderIndex,
        description: task.description,
        status: task.status,
        kind: taskKind,
        path,
      };
    });

  const generated = renderPlanNote({
    id: plan.id,
    slug: plan.slug,
    title: plan.title,
    status: plan.status,
    priority: plan.priority,
    kind,
    overview: plan.overview,
    approach: plan.approach,
    complexity: plan.complexity,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    approvedAt: plan.approvedAt,
    completedAt: plan.completedAt,
    projectTag: tag,
    tasks,
  });

  return {
    entityType: "plan",
    entityId,
    kind,
    canonicalPath: toVaultRelative(root, planNotePath(root, tag, plan.slug)),
    generated,
  };
}

/** Task note. `planSlug` falls back to the sanitized planId when the plan is gone. */
function resolveTaskUnit(
  deps: ExportDeps,
  entityId: string,
  tag: string,
  root: string,
  kindOverride: ObsidianKind | null,
): ResolveResult {
  const task = getTask(deps.db, entityId);
  if (task === null) {
    return obsidianError(
      "ENTITY_NOT_FOUND",
      `task ${entityId} not found`,
      "use task_list / task_create_batch to get an existing task id",
    );
  }

  const parent = task.planId !== "" ? getPlan(deps.db, task.planId) : null;
  const parentKind: ObsidianKind = parent !== null ? resolvePlanKind(parent) : "other";
  const kind = kindOverride ?? resolveTaskKind(task, parentKind);
  const planSlug = parent !== null ? parent.slug : sanitizeSegment(task.planId);

  const generated = renderTaskNote({
    id: task.id,
    planId: task.planId,
    planSlug,
    orderIndex: task.orderIndex,
    description: task.description,
    agent: task.agent,
    status: task.status,
    complexity: task.complexity,
    result: task.result,
    error: task.error,
    files: task.files,
    kind,
    projectTag: tag,
    completedAt: task.completedAt,
  });

  return {
    entityType: "task",
    entityId,
    kind,
    canonicalPath: toVaultRelative(
      root,
      taskNotePath(root, tag, kind, planSlug, task.orderIndex, task.id),
    ),
    generated,
  };
}

/**
 * Design note from the `.ndomo/designs/` source artifact. The source carries no
 * DB row here, so `ndomoId`/`slug` fall back to the filename stem and `date`
 * to a `YYYY-MM-DD` prefix when present.
 */
function resolveDesignUnit(
  projectDir: string,
  entityId: string,
  tag: string,
  root: string,
  kindOverride: ObsidianKind | null,
): ResolveResult {
  const source: DesignSource | null = readDesignSource(projectDir, entityId);
  if (source === null) {
    return obsidianError(
      "SOURCE_NOT_FOUND",
      `design source "${entityId}" not found in .ndomo/designs/`,
      "pass the design filename (…-design.md) or its slug as entityId",
    );
  }

  const kind: ObsidianKind = kindOverride ?? "design";
  const stem = source.filename.replace(/\.md$/i, "");
  const datePrefix = /^(\d{4}-\d{2}-\d{2})/.exec(stem);

  const generated = renderDesignNote({
    id: stem,
    slug: stem,
    title: firstHeading(source.content) ?? stem,
    date: datePrefix?.[1] ?? "",
    projectPath: projectDir,
    sourceFilename: source.filename,
    sourcePath: source.sourcePath,
    body: source.content,
    kind,
    projectTag: tag,
  });

  return {
    entityType: "design",
    entityId,
    kind,
    canonicalPath: toVaultRelative(root, designNotePath(root, tag, source.filename)),
    generated,
  };
}

/** Memory note (95-Memories) — read from the embedded memory DB. */
function resolveMemoryUnit(
  deps: ExportDeps,
  entityId: string,
  tag: string,
  root: string,
  kindOverride: ObsidianKind | null,
): ResolveResult {
  // Context matters: a failure HERE is about the memory store (open + query),
  // not about the project DB and not about the vault — see MEM_DB_HINT.
  let memory: MemRecord | null;
  try {
    memory = withMemDb(tag, deps.memStoragePath, (memDb) => getMemory(memDb, entityId));
  } catch (err) {
    return mapFsError(
      err,
      `obsidian_export could not read memory ${entityId} from the embedded memory DB`,
      MEM_DB_HINT,
    );
  }
  if (memory === null) {
    return obsidianError(
      "ENTITY_NOT_FOUND",
      `memory ${entityId} not found for this project`,
      "use mem_list to get an existing memory id (mem_add returns it)",
    );
  }

  const kind: ObsidianKind = kindOverride ?? resolveMemoryKind(memory);
  const generated = renderMemoryNote({
    id: memory.id,
    content: memory.content,
    type: memory.type,
    tags: memory.tags,
    source: memory.source,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    kind,
    projectTag: tag,
  });

  return {
    entityType: "memory",
    entityId,
    kind,
    canonicalPath: toVaultRelative(root, memoryNotePath(root, tag, memory.content, memory.id)),
    generated,
  };
}

/** Dispatch by entity type. Returns an error envelope when the entity is absent. */
function resolveUnit(
  deps: ExportDeps,
  target: Target,
  tag: string,
  root: string,
  state: ObsidianSyncState,
  kindOverride: ObsidianKind | null,
): ResolveResult {
  switch (target.entityType) {
    case "plan": {
      const plan = getPlan(deps.db, target.entityId);
      if (plan === null) {
        return obsidianError(
          "ENTITY_NOT_FOUND",
          `plan ${target.entityId} not found`,
          "use plan_create / plan_list to get an existing plan id",
        );
      }
      return resolvePlanUnit(deps, plan, target.entityId, tag, root, state, kindOverride);
    }
    case "task":
      return resolveTaskUnit(deps, target.entityId, tag, root, kindOverride);
    case "design":
      return resolveDesignUnit(deps.projectDir, target.entityId, tag, root, kindOverride);
    case "memory":
      return resolveMemoryUnit(deps, target.entityId, tag, root, kindOverride);
  }
}

// ─── Projection (path stability + idempotency + write) ───────────────────────

/**
 * Write one resolved unit and persist its sync-state entry.
 *
 * - `entry.kind === kind` → keep the STORED path (a slug rename does not move
 *   the file; the frontmatter shows the current slug).
 * - `entry.kind !== kind` → canonical path becomes the target and the stored
 *   path is the migration source (`resolveNoteContent` carries the human
 *   section over and deletes the old file).
 * - `entry.hash === hash` → no write at all, only `lastCheckedAt`.
 *
 * @throws Whatever the fs helpers throw — mapped by {@link mapFsError}.
 */
function projectUnit(
  state: ObsidianSyncState,
  tag: string,
  syncHome: string,
  root: string,
  unit: ResolvedUnit,
): ExportItem {
  const entry = state.entries[syncEntryKey(unit.entityType, unit.entityId)];
  const stored = entry !== undefined && isSafeVaultRelative(entry.path) ? entry : undefined;

  const path = stored !== undefined && stored.kind === unit.kind ? stored.path : unit.canonicalPath;
  const oldPath = stored !== undefined && stored.kind !== unit.kind ? stored.path : null;
  const hash = sha256Hex(unit.generated.autoPayload);

  let status: ExportItemStatus;
  if (stored !== undefined && stored.hash === hash) {
    status = "skipped";
  } else {
    resolveNoteContent({
      vaultRoot: root,
      newPath: join(root, path),
      oldPath: oldPath === null ? null : join(root, oldPath),
      generated: unit.generated,
    });
    status = "exported";
  }

  upsertEntry(state, unit.entityType, unit.entityId, { path, kind: unit.kind, hash });
  saveSyncState(tag, state, syncHome);

  return {
    entityType: unit.entityType,
    entityId: unit.entityId,
    status,
    path,
    kind: unit.kind,
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Project one entity (or a whole plan with its tasks) into the vault.
 *
 * @returns `{ok:true,data:{items,warning}}` on success — `warning` mirrors
 *   `loadSyncState` (`"sync-state missing"` on a first export, `"sync-state
 *   corrupt"` when entries were dropped, else `null`) — or an error envelope.
 *   NEVER throws (fail-fast applies inside `scope=plan` only).
 */
export async function obsidianExport(
  deps: ExportDeps,
  req: ExportRequest,
): Promise<ObsidianEnvelope<ExportData>> {
  try {
    return projectAll(deps, req);
  } catch (err) {
    // Last-resort net for failures OUTSIDE the contextualized stages (config
    // handling, tag resolution, sync-state): keep the message broad.
    return mapFsError(
      err,
      "obsidian_export failed",
      "check the obsidian config (vaultPath/allowInsideRepo), the project state.db and vault permissions, then retry",
    );
  }
}

/** Synchronous core of {@link obsidianExport} (all steps are local/DB/fs). */
function projectAll(deps: ExportDeps, req: ExportRequest): ObsidianEnvelope<ExportData> {
  // (a) config — empty vaultPath means "not configured" before anything else.
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
      "set obsidian.enabled=true in ndomo.json to project notes",
    );
  }

  // (h) documented decision: `scope=plan` only makes sense for plans.
  if (req.scope === "plan" && req.entityType !== "plan") {
    return obsidianError(
      "IO_ERROR",
      "scope=plan requires entityType=plan",
      "export tasks/designs/memories with scope=single (or omit scope)",
    );
  }

  // kind? override — validated once, before any IO.
  let kindOverride: ObsidianKind | null = null;
  if (req.kind !== undefined) {
    const validated = validateKindOverride(req.kind);
    if (!validated.ok) {
      return obsidianError(
        "INVALID_KIND",
        validated.message,
        `valid kinds: ${OBSIDIAN_KINDS.join("|")}`,
      );
    }
    kindOverride = validated.kind;
  }

  // (b) vault root + guard + materialization.
  // Shape check FIRST: resolveVaultRoot() anchors a relative vaultPath to the
  // CWD, which would defeat checkVaultGuard()'s own UNSAFE_PATH branch.
  // A3: the configured STRING is validated (expandHome + isAbsolute) before
  // any absolutization, so `vaultPath: "vault-rel"` reaches UNSAFE_PATH
  // instead of being silently materialized under the process CWD.
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

  try {
    ensureVaultRoot(deps.config);
  } catch (err) {
    return obsidianError(
      "VAULT_UNWRITABLE",
      `cannot create vault root ${root}: ${messageOf(err)}`,
      "check permissions on the parent directory of obsidian.vaultPath",
    );
  }

  // (c) project namespace + tolerant sync-state.
  const tag = getProjectTagInfo(deps.projectDir).tag;
  const syncHome = resolveSyncHome();
  const { state, warning } = loadSyncState(tag, syncHome);

  // targets — `scope=plan` expands to the plan + its non-archived tasks.
  let targets: Target[];
  if (req.scope === "plan") {
    const plan = getPlan(deps.db, req.entityId);
    if (plan === null) {
      return obsidianError(
        "ENTITY_NOT_FOUND",
        `plan ${req.entityId} not found`,
        "use plan_create / plan_list to get an existing plan id",
      );
    }
    targets = [{ entityType: "plan", entityId: req.entityId }];
    for (const task of listTasksByPlan(deps.db, plan.id)) {
      if (task.archivedAt === null) targets.push({ entityType: "task", entityId: task.id });
    }
  } else {
    targets = [{ entityType: req.entityType, entityId: req.entityId }];
  }

  // (d)…(i) resolve → project, fail-fast.
  // Three failure contexts, three hints (stable codes): READ_ENTITY_HINT /
  // MEM_DB_HINT (inside resolveMemoryUnit) / WRITE_VAULT_HINT.
  const items: ExportItem[] = [];
  for (const target of targets) {
    // (context 1) resolving = READING the entity (project DB / designs dir /
    // memory DB): a failure here must not look like a vault problem.
    let resolved: ResolveResult;
    try {
      resolved = resolveUnit(deps, target, tag, root, state, kindOverride);
    } catch (err) {
      return mapFsError(
        err,
        `obsidian_export could not read ${target.entityType}:${target.entityId}`,
        READ_ENTITY_HINT,
      );
    }
    if (isErr(resolved)) return resolved;
    try {
      items.push(projectUnit(state, tag, syncHome, root, resolved));
    } catch (err) {
      return mapFsError(
        err,
        `obsidian_export could not write ${target.entityType}:${target.entityId}`,
        WRITE_VAULT_HINT,
      );
    }
  }

  return { ok: true, data: { items, warning } };
}
