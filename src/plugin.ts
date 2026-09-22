/**
 * ndomo — OpenCode plugin implementation.
 *
 * Wraps ndomo's orchestrator, worktree, and memory libraries as
 * OpenCode hooks and tools. All state lives in closures created
 * when the plugin is instantiated — no module-level globals.
 *
 * v2: the plugin is defined with `Plugin.define({ id: "ndomo", setup })`
 * from `@opencode/plugin` (installed alongside the user's
 * `config/ndomo.config.json`).
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import { loadHttpConfig, loadJevConfig } from "./config/schema.ts";
import {
  archiveAnalysis,
  createAnalysis,
  getAnalysis,
  linkAnalysisToPlan,
  listAnalyses,
  searchAnalyses,
  unlinkAnalysisFromPlan,
  updateAnalysis,
  validateAnalysisFindings,
} from "./db/analyses.ts";
import { AutoCheckpointDispatcher } from "./db/auto-checkpoint.ts";
import {
  CIRCUIT_BREAKER_ERROR,
  CircuitBreaker,
  resolveCircuitBreakerTaskFailure,
} from "./db/circuit-breaker.ts";
import { closeDb, openDb } from "./db/client.ts";
import { buildCriticReview, toTaskVerification } from "./db/critic.ts";
import { createDesign, type DesignInput, type DesignOption } from "./db/designs.ts";
import { createIncident } from "./db/incidents.ts";
import { type LedgerData, readLedger, readLedgerRaw, writeLedger } from "./db/ledgers.ts";
import { runMigrations } from "./db/migrations.ts";
import { resolveArchiveDir } from "./db/plan-archive.ts";
import { planCreateExecutor } from "./db/plan-create.ts";
import { planUpdateStatusExecutor } from "./db/plan-update-status.ts";
import {
  approvePlan,
  deletePlan,
  getPlan,
  getPlanBySlug,
  listPlans,
  searchPlans,
} from "./db/plans.ts";
import { resolveProjectDir } from "./db/resolve-project-dir.ts";
import { recordRollback } from "./db/rollbacks.ts";
import { checkpointSession, endSession, listSessions, startSession } from "./db/sessions.ts";
import { registerShutdownHandlers } from "./db/shutdown.ts";
import {
  createTasksBatch,
  listTasksByPlan,
  nextTaskForAgent,
  recordTaskVerification,
  resolveTaskDependencies,
  searchTasks,
  type TaskCreateInput,
  updateTaskStatus,
} from "./db/tasks.ts";
import type {
  IncidentSeverity,
  InsertIncident,
  InsertRollback,
  PlanMetadata,
  PlanStatus,
  RollbackStatus,
  SessionMetadata,
  TaskMetadata,
  TaskStatus,
} from "./db/types.ts";
import { type HttpServerHandle, startHttpServer } from "./http/server.ts";
import type { RoutingDecision } from "./lib.ts";
import {
  BackgroundDispatcher,
  canRunParallel,
  cavemanCompress,
  createWorktree,
  getProjectTag,
  listActive,
  memorySearchOptions,
  removeWorktree,
  routeTask,
  verifyIntegrity,
} from "./lib.ts";
import { getSdkClient } from "./sdk/client.ts";

// ─── v1 → v2 tool adapter ────────────────────────────────────────────────────

/**
 * Legacy tool context (v1 shape). v2's `Tool.Context` dropped `directory` and
 * `worktree` (they live on the plugin context), so the adapter re-injects both
 * from the setup closure alongside the fields v2 does provide.
 */
type LegacyToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  callID: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
};

/** v1-style tool definition: zod raw shape + execute over the inferred args. */
type LegacyToolDef = {
  description: string;
  args: z.ZodRawShape;
  execute: (args: any, context: LegacyToolContext) => unknown;
};

/**
 * Identity helper mirroring the v1 `tool()` constructor so the tool map keeps
 * its original shape (and the zod-inferred `args` types).
 */
function tool<Args extends z.ZodRawShape>(input: {
  description: string;
  args: Args;
  execute: (
    args: z.infer<z.ZodObject<Args>>,
    context: LegacyToolContext,
  ) => Promise<unknown> | unknown;
}): typeof input {
  return input;
}

/**
 * Register v1-style definitions on the v2 tool editor:
 *  - zod shapes are valid v2 `ValueSchema` inputs (StandardSchemaV1)
 *  - executor results are wrapped into v2 `{ content }` results
 *  - the legacy context fields (directory/worktree/callID) are injected
 */
export function registerTools(
  editor: ToolEditor,
  tools: Record<string, LegacyToolDef>,
  base: { directory: string; worktree: string },
): void {
  for (const [name, def] of Object.entries(tools)) {
    editor.add({
      name,
      description: def.description,
      input: z.object(def.args),
      execute: async (input, context): Promise<{ content: string }> => {
        const legacyCtx: LegacyToolContext = {
          sessionID: context.sessionID,
          messageID: context.messageID,
          agent: context.agent,
          callID: context.id,
          directory: base.directory,
          worktree: base.worktree,
          abort: context.signal,
        };
        const out: unknown = await def.execute(input, legacyCtx);
        return { content: typeof out === "string" ? out : JSON.stringify(out) };
      },
    });
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Safely extract a filepath from tool args (write/edit tools).
 * The SDK types `args` as `any` — it can be null, undefined, or any shape.
 * Returns `undefined` when filepath is absent, null, or not a string.
 */
function extractFilePath(args: unknown): string | undefined {
  if (args == null || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const fp = record.filePath ?? record.filepath;
  return typeof fp === "string" ? fp : undefined;
}

/**
 * Pure mapper: convert a `task_create_batch` tool arg into the
 * {@link TaskCreateInput} shape consumed by {@link createTasksBatch}.
 *
 * Extracted from the tool's `execute` closure so the v17/T1
 * `verificationRequired` forwarding (and the legacy metadata fallback) can be
 * unit-tested without instantiating the OpenCode plugin runtime, which
 * requires the OpenCode plugin runtime/SDK wiring.
 *
 * Forwards the explicit `verificationRequired` flag when present. The
 * `metadata.verificationRequired === true` fallback continues to be honored
 * inside createTasksBatch (backwards-compatible opt-in), so callers using
 * either path are gated correctly.
 */
export function mapTaskCreateBatchArg(
  t: {
    description: string;
    agent: string;
    files?: string[] | undefined;
    complexity?: number | undefined;
    dependencies?: string[] | undefined;
    metadata?: Record<string, unknown> | undefined;
    verificationRequired?: boolean | undefined;
  },
  auditCtx: {
    createdBy: string;
    updatedBy: string;
    sourceSessionId?: string | null;
    sourceMessageId?: string | null;
  },
): TaskCreateInput {
  const typedMeta = (t.metadata ?? {}) as TaskMetadata;
  return {
    // orderIndex intentionally omitted — createTasksBatch allocates dynamically
    // via SELECT MAX+1 to avoid UNIQUE constraint collisions on retries/splits.
    // Caller-provided idx was the root cause of the UNIQUE constraint bug
    // (plan ca69222a).
    description: t.description,
    agent: t.agent,
    files: t.files ?? [],
    complexity: t.complexity ?? 3,
    dependencies: t.dependencies ?? [],
    ...auditCtx,
    reviewedBy: typedMeta.reviewedBy ?? null,
    tokensUsed: typedMeta.tokensUsed ?? null,
    durationMs: typedMeta.durationMs ?? null,
    artifacts: typedMeta.artifacts ?? [],
    metadata: typedMeta,
    // Forward the explicit gate flag when present. Omit otherwise so the
    // metadata.verificationRequired fallback inside createTasksBatch stays
    // the source of truth for legacy callers.
    ...(t.verificationRequired !== undefined
      ? { verificationRequired: t.verificationRequired }
      : {}),
  };
}

/**
 * File lock registry for write/edit tools — replaces the raw `Map<string, string>`
 * that previously held activeWrites. Each entry is stamped with the time it was
 * acquired so a TTL sweep can recover from SDK hook-chain breaks where
 * `tool.execute.after` never fires (regression: leaked write locks blocked
 * subsequent writes indefinitely).
 *
 * Public API:
 *  - acquire(fp, key): null if can lock, or the existing holder's key.
 *  - release(fp, key): drop the lock IF caller is the holder (else no-op).
 *  - forceRelease(fp): admin override — drops the lock regardless of holder.
 *  - sweep(): prune entries older than ttlMs. Returns count removed.
 *
 * `acquire` auto-sweeps before checking so a stale lock never blocks a fresh
 * caller — covers the "SDK never fired after-hook" scenario.
 */
export class FileLock {
  private map = new Map<string, { key: string; setAt: number }>();

  constructor(private readonly ttlMs: number) {}

  acquire(filepath: string, key: string): string | null {
    this.sweep();
    const existing = this.map.get(filepath);
    if (existing != null && existing.key !== key) return existing.key;
    this.map.set(filepath, { key, setAt: Date.now() });
    return null;
  }

  release(filepath: string, key: string): void {
    const existing = this.map.get(filepath);
    if (existing?.key === key) this.map.delete(filepath);
  }

  forceRelease(filepath: string): boolean {
    return this.map.delete(filepath);
  }

  sweep(): number {
    const cutoff = Date.now() - this.ttlMs;
    let swept = 0;
    for (const [fp, entry] of this.map) {
      if (entry.setAt < cutoff) {
        this.map.delete(fp);
        swept++;
      }
    }
    return swept;
  }

  has(filepath: string): boolean {
    return this.map.has(filepath);
  }

  size(): number {
    return this.map.size;
  }

  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

// ─── Escalation helper (M2) ──────────────────────────────────────────────────

/**
 * Escalate a task from craftsman to foreman by creating a stub plan
 * and optionally a foreman task, then checkpointing the session.
 *
 * Pure function taking `db` — testable via in-memory SQLite.
 */
export function escalateToForeman(
  db: Database,
  ctx: { agent?: string; sessionID?: string; messageID?: string; projectDir?: string },
  args: {
    sourcePlanId?: string;
    sourceTaskId?: string;
    reason: string;
    suggestedApproach?: string;
  },
): { escalationPlanId: string; notificationSent: boolean } {
  const escalationId = crypto.randomUUID();
  const slug = `escalation-${escalationId.slice(0, 8)}`;

  // 1. Create stub plan with escalation metadata
  const plan = planCreateExecutor(
    db,
    {
      slug,
      title: `Escalation: ${args.reason.slice(0, 80)}`,
      overview: args.reason,
      priority: 3, // mid-priority for escalation stubs
      ...(args.suggestedApproach !== undefined && { approach: args.suggestedApproach }),
      metadata: {
        escalatedFrom: args.sourcePlanId ?? null,
        escalatedBy: "craftsman",
        reason: args.reason,
      } as PlanMetadata & Record<string, unknown>,
    },
    ctx,
  );

  // 2. If sourceTaskId, create a foreman task in the escalation plan
  if (args.sourceTaskId) {
    createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: args.reason,
        agent: "foreman",
        files: [],
        complexity: 3,
        dependencies: [],
        createdBy: ctx.agent ?? "unknown",
        updatedBy: ctx.agent ?? "unknown",
        sourceSessionId: ctx.sessionID ?? null,
        sourceMessageId: ctx.messageID ?? null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
    ]);
  }

  // 3. Session checkpoint with escalation note
  if (ctx.sessionID) {
    checkpointSession(
      db,
      ctx.sessionID,
      { escalated: true, escalationPlanId: plan.id },
      `escalated by craftsman: ${args.reason}`,
      ctx.projectDir ? { projectDir: ctx.projectDir } : undefined,
    );
  }

  return { escalationPlanId: plan.id, notificationSent: true };
}

// ─── Reconcile helper (M3) ───────────────────────────────────────────────────

/**
 * Reconcile plans that were left in 'executing' or 'approved' status
 * when a session ends. Marks them as 'abandoned' with metadata reason.
 *
 * Pure function taking `db` — testable via in-memory SQLite.
 */
export function reconcileAbandonedPlans(db: Database, sessionId: string, endedBy: string): number {
  // Find plans in non-terminal statuses belonging to this session
  const rows = db
    .query(
      `SELECT id, metadata FROM plans
       WHERE session_id = ? AND status IN ('executing', 'approved') AND archived_at IS NULL`,
    )
    .all(sessionId) as Array<{ id: string; metadata: string | null }>;

  const now = Date.now();
  for (const row of rows) {
    // Merge reason into existing metadata
    const existingMeta = row.metadata ? JSON.parse(row.metadata) : {};
    const updatedMeta = {
      ...existingMeta,
      reason: "session_ended",
      endedBy,
    };

    db.query(
      `UPDATE plans SET status = 'abandoned', updated_at = ?, updated_by = ?, metadata = ?
       WHERE id = ?`,
    ).run(now, endedBy, JSON.stringify(updatedMeta), row.id);
  }

  return rows.length;
}

// ─── Public types ────────────────────────────────────────────────────────────

export type NdomoPluginOptions = {
  preset?: "default" | "budget" | undefined;
};

export type NdomoConfig = {
  $schema: string;
  preset?: "default" | "budget" | undefined;
  plugins: string[];
  optionalPlugins?: string[] | undefined;
  agentRouting: Record<
    string,
    { description: string; mode: "primary" | "subagent" | "all"; delegates_to: string[] }
  >;
  protectedTools: string[];
  caveman: { intensity: "lite" | "full" | "ultra"; autoClarity: boolean };
  presets: Record<
    string,
    Record<string, { model: string; temperature: number; reasoning_effort?: string }>
  >;
  dcp_overrides?: Record<string, { minContextLimit: number; maxContextLimit: number }> | undefined;
  mem: {
    storagePath: string;
    defaultScope: "project" | "all-projects";
    autoCaptureEnabled: boolean;
    cavemanCompress: boolean;
  };
  autoCheckpoint?: {
    enabled?: boolean;
    triggers?: string[];
    minIntervalMs?: number;
    captureState?: {
      completedTasks?: boolean;
      currentPhase?: boolean;
      blockers?: boolean;
    };
  };
  backgroundRetention?: {
    softCap?: number;
    maxAgeMs?: number;
  };
  fileLock?: {
    /** TTL for write/edit locks in ms. Stale entries auto-release via sweep. */
    ttlMs?: number;
  };
  /**
   * Circuit breaker for tool-call loops. Trips when a session emits too many
   * total tool calls (default 4000) or too many consecutive IDENTICAL calls
   * (default 20). On trip: warns, optionally fails the relevant task, and
   * blocks further calls with {@link CIRCUIT_BREAKER_ERROR}. One-shot per
   * session. Only `threshold` (total) is configurable here; the identical
   * threshold keeps its default.
   */
  circuitBreaker?: {
    /** Total tool calls per session before the breaker trips. Default 4000. */
    threshold?: number;
  };
  /** HTTP server configuration. Loaded from environment variables if not set. */
  http?: import("./config/schema.ts").HttpConfig;
};

/**
 * Load ndomo.json from the user's OpenCode config directory.
 * Returns null if the file is missing or invalid; logs a warning either way.
 */
export function loadNdomoConfig(configPath?: string): NdomoConfig | null {
  const path = configPath ?? join(homedir(), ".config", "opencode", "ndomo.json");
  try {
    if (!existsSync(path)) {
      console.warn(`[ndomo] config not found at ${path} — using built-in defaults`);
      return null;
    }
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as NdomoConfig;
    // Minimal validation: plugins array is the only hard requirement
    if (!parsed.plugins || !Array.isArray(parsed.plugins)) {
      console.warn(`[ndomo] invalid config at ${path}: missing plugins array`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(
      `[ndomo] failed to load config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Validate an agent name to prevent path traversal via malicious preset keys.
 * Rejects names containing path separators, "..", or other unsafe characters.
 */
function validateAgentName(name: string): void {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`[ndomo] invalid agent name "${name}" — must match [a-zA-Z0-9_-]+`);
  }
}

/**
 * Sync agent `.md` frontmatter (model, temperature) from ndomo config presets.
 * Allows hot-swapping agent models by editing `ndomo.json::presets[preset][agent].model`
 * so the next OpenCode session picks up the new values via rewrite of
 * `~/.config/opencode/agent/<agent>.md` frontmatter.
 *
 * Opt out via env `NDOMO_SKIP_FRONTMATTER_SYNC=1`.
 * Also syncs reasoningEffort: (camelCase) when spec.reasoning_effort (snake_case) is set.
 */
export function syncAgentFrontmatter(
  ndomoConfig: NdomoConfig,
  effectivePreset: string,
  agentsDir?: string,
): { synced: number; skipped: number; errors: number } {
  let synced = 0;
  let skipped = 0;
  let errors = 0;
  if (process.env.NDOMO_SKIP_FRONTMATTER_SYNC === "1") {
    console.log("[ndomo] frontmatter sync skipped (NDOMO_SKIP_FRONTMATTER_SYNC=1)");
    return { synced, skipped, errors };
  }
  const dir = agentsDir ?? join(homedir(), ".config", "opencode", "agent");
  const preset = ndomoConfig?.presets?.[effectivePreset];
  if (!preset || typeof preset !== "object") {
    console.warn(`[ndomo] frontmatter sync: preset '${effectivePreset}' not found in config`);
    return { synced, skipped, errors };
  }
  for (const [agentName, spec] of Object.entries(preset)) {
    try {
      validateAgentName(agentName);
    } catch (err) {
      console.warn(err instanceof Error ? err.message : String(err));
      skipped++;
      continue;
    }
    const agentPath = join(dir, `${agentName}.md`);
    if (!existsSync(agentPath)) {
      console.warn(`[ndomo] frontmatter sync: agent file not found ${agentPath}`);
      errors++;
      continue;
    }
    try {
      const original = readFileSync(agentPath, "utf-8");
      let updated = original;
      if (spec?.model != null) {
        const newModelLine = `model: ${spec.model}`;
        const cur = original.match(/^model:.*$/m)?.[0];
        if (cur !== newModelLine) {
          updated = updated.replace(/^model:.*$/m, newModelLine);
        }
      }
      if (spec?.temperature != null) {
        const newTempLine = `temperature: ${spec.temperature}`;
        const cur = original.match(/^temperature:.*$/m)?.[0];
        if (cur !== newTempLine) {
          updated = updated.replace(/^temperature:.*$/m, newTempLine);
        }
      }
      if (spec?.reasoning_effort != null && spec.reasoning_effort !== "") {
        const newEffortLine = `reasoningEffort: ${spec.reasoning_effort}`;
        const cur = original.match(/^reasoningEffort:.*$/m)?.[0];
        if (cur === newEffortLine) {
          // already in sync, no-op
        } else if (cur != null) {
          // line exists with a different value → update in place
          updated = updated.replace(/^reasoningEffort:.*$/m, newEffortLine);
        } else {
          // line missing → insert after temperature: line (or after model: if no temperature, or after the opening --- as last resort)
          if (updated.match(/^temperature:.*$/m)) {
            updated = updated.replace(/^(temperature:.*)$/m, `$1\n${newEffortLine}`);
          } else if (updated.match(/^model:.*$/m)) {
            updated = updated.replace(/^(model:.*)$/m, `$1\n${newEffortLine}`);
          } else {
            updated = updated.replace(/^(---.*)$/m, `$1\n${newEffortLine}`);
          }
        }
      }
      if (updated === original) {
        skipped++;
      } else {
        writeFileSync(agentPath, updated, "utf-8");
        synced++;
      }
    } catch (err) {
      console.warn(
        `[ndomo] frontmatter sync: failed to sync ${agentName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      errors++;
    }
  }
  console.log(
    `[ndomo] frontmatter sync: preset=${effectivePreset} synced=${synced} skipped=${skipped} errors=${errors}`,
  );
  return { synced, skipped, errors };
}

// ─── Plugin entry ────────────────────────────────────────────────────────────

export const NdomoPlugin = Plugin.define({
  id: "ndomo",
  async setup(ctx) {
    // v2: the plugin context owns the location; tool execution contexts do
    // not, so resolve both roots once and thread them through the closures.
    const directory = ctx.location.directory;
    const worktree = ctx.location.project.directory;
    const opts = (ctx.options ?? {}) as NdomoPluginOptions;

    // Load ndomo.json config (gracefully degrades to null if missing/corrupt)
    const ndomoConfig = loadNdomoConfig();
    const effectivePreset = opts.preset ?? ndomoConfig?.preset ?? "default";
    if (ndomoConfig) {
      console.log(
        `[ndomo] loaded config: preset=${effectivePreset} agents=${Object.keys(ndomoConfig.agentRouting).length} plugins=${ndomoConfig.plugins.length}`,
      );
    }
    if (ndomoConfig) {
      syncAgentFrontmatter(ndomoConfig, effectivePreset);
    }

    // HTTP config — merge from ndomoConfig.http or load from environment variables
    const httpConfig = ndomoConfig?.http ?? loadHttpConfig();
    if (httpConfig.enabled) {
      console.log(
        `[ndomo] HTTP server enabled: port=${httpConfig.port} auth=${httpConfig.auth.required} cors_origins=${httpConfig.cors.origins.length}`,
      );
    }

    // JEV config — per-field resolution from ndomo.json with defaults.
    // The API key lives in TYPESAFE_API_KEY; without it JEV is silently skipped.
    const jevConfig = loadJevConfig();
    if (jevConfig.enabled) {
      console.log(
        `[ndomo] JEV routing enabled: model=${jevConfig.model} timeoutMs=${jevConfig.timeoutMs}`,
      );
    }

    // Shared state — lives for the lifetime of the plugin instance
    // Single resolution point: projectDir is reused for the DB, the
    // auto-checkpoint ledger wiring, and the session_checkpoint tool so all
    // session checkpoints persist a portable filesystem ledger.
    const projectDir = resolveProjectDir({ worktree, directory });
    const db: Database = openDb(projectDir);
    runMigrations(db);
    registerShutdownHandlers(db);
    const dispatcher = new BackgroundDispatcher(db);

    // ─── SDK Client (for SSE events) ─────────────────────────────────────────────
    let sdkClient: import("./sdk/client.ts").OpenCodeClient | null = null;
    if (httpConfig.enabled) {
      try {
        const handle = await getSdkClient();
        sdkClient = handle.client;
        console.log(`[ndomo] OpenCode SDK client connected: ${handle.baseUrl}`);
      } catch (err) {
        console.warn(
          `[ndomo] OpenCode SDK client unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.warn(`[ndomo] /api/events will return 503 until SDK becomes reachable`);
      }
    }

    // ─── HTTP Server ──────────────────────────────────────────────────────────
    let httpServerHandle: HttpServerHandle | null = null;
    if (httpConfig.enabled) {
      try {
        httpServerHandle = await startHttpServer({
          db,
          httpConfig,
          ...(sdkClient ? { sdkClient } : {}),
        });
        console.log(`[ndomo] HTTP server listening on port ${httpServerHandle.port}`);
      } catch (err) {
        console.error(
          `[ndomo] HTTP server failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // HTTP shutdown — separate from DB shutdown (registerShutdownHandlers uses process.once
    // which self-removes; adding our own listener avoids modifying shared shutdown module).
    let httpStopped = false;
    const stopHttpServer = (): Promise<void> => {
      if (httpStopped || !httpServerHandle) return Promise.resolve();
      httpStopped = true;
      return httpServerHandle.stop().catch(() => {});
    };
    const onProcessSignal = (): void => {
      void stopHttpServer();
    };
    process.on("SIGINT", onProcessSignal);
    process.on("SIGTERM", onProcessSignal);

    // Background task retention — auto-finalize terminal tasks when row count
    // exceeds soft cap. Defaults: soft cap 1000 rows, max age 24h. Prevents
    // unbounded growth of background_tasks on long-running installs (audit
    // finding fcb12dc5 #1).
    const retentionSoftCap = ndomoConfig?.backgroundRetention?.softCap ?? 1000;
    const retentionMaxAgeMs = ndomoConfig?.backgroundRetention?.maxAgeMs ?? 24 * 60 * 60 * 1000;
    const totalRows =
      dispatcher.stats().pending +
      dispatcher.stats().running +
      dispatcher.stats().completed +
      dispatcher.stats().failed +
      dispatcher.stats().cancelled;
    if (totalRows > retentionSoftCap) {
      const deleted = dispatcher.finalize(retentionMaxAgeMs);
      if (deleted > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[ndomo] background retention: pruned ${deleted} terminal tasks older than ${retentionMaxAgeMs}ms (rows were ${totalRows} > soft cap ${retentionSoftCap})`,
        );
      }
    }

    /** filepath → `${sessionID}:${callID}` of the task that locked it. */
    const fileLockTtlMs = ndomoConfig?.fileLock?.ttlMs ?? 60_000;
    const activeWrites = new FileLock(fileLockTtlMs);

    // Circuit breaker for tool-call loops. Config option `circuitBreaker.threshold`
    // overrides the TOTAL per-session threshold only; the consecutive-identical
    // threshold keeps its default (20). Absent/invalid config → built-in default
    // (4000), so protection can never be silently disabled by a malformed value.
    const circuitBreaker = new CircuitBreaker(
      ndomoConfig?.circuitBreaker?.threshold !== undefined
        ? { totalThreshold: ndomoConfig.circuitBreaker.threshold }
        : {},
    );
    if (httpConfig.enabled) {
      console.log(
        `[ndomo] circuit breaker: totalThreshold=${circuitBreaker.config.totalThreshold} identicalThreshold=${circuitBreaker.config.identicalThreshold}`,
      );
    }

    // Auto-checkpoint dispatcher (T3.3). projectDir threads through so each
    // auto-checkpoint also persists a filesystem ledger (continuity across
    // process restarts / DB rebuilds).
    const autoCheckpoint = new AutoCheckpointDispatcher(db, {
      ...ndomoConfig?.autoCheckpoint,
      projectDir,
    });

    // ─── Hooks (v2 domain registration) ─────────────────────────────────────

    // (a) Inject orchestrator state into session compaction context.
    //     v2 removed v1's `output.context.push`; the supported analog is
    //     appending a text SystemPart to the outgoing compaction request.
    await ctx.session.hook("compaction", async (event) => {
      // Sweep stale write locks before snapshotting state — surfaces the
      // true current lock count after any prior hook-miss leaks.
      const swept = activeWrites.sweep();
      const count = dispatcher.getActive().length;
      const paths = activeWrites.keys().join(", ");
      if (swept > 0) {
        // eslint-disable-next-line no-console
        console.log(`[ndomo] file-lock: swept ${swept} stale entries during compaction`);
      }
      event.system.push({
        type: "text",
        text: [
          "",
          "## ndomo orchestrator state",
          `- Active tasks: ${count}`,
          `- Active writes: ${paths || "(none)"}`,
          `- Project: ${worktree || directory}`,
          "",
        ].join("\n"),
      });

      // Enrich compaction context with DB state
      try {
        const sessionId = event.sessionID ?? "";
        if (sessionId) {
          const activePlans = listPlans(db, { sessionId }).filter(
            (p) => p.status === "approved" || p.status === "executing",
          );
          if (activePlans.length > 0) {
            event.system.push({
              type: "text",
              text: `\n## ndomo active plans\n${JSON.stringify(
                activePlans.map((p) => ({
                  id: p.id,
                  slug: p.slug,
                  title: p.title,
                  status: p.status,
                  tasks: listTasksByPlan(db, p.id).length,
                })),
                null,
                2,
              )}`,
            });
          }
        }
        const recentSessions = listSessions(db, { limit: 3 });
        if (recentSessions.length > 0) {
          event.system.push({
            type: "text",
            text: `\n## ndomo recent sessions\n${JSON.stringify(
              recentSessions.map((s) => ({
                id: s.id,
                goal: s.goal.slice(0, 100),
                endedAt: s.endedAt,
                keyDecisions: s.keyDecisions?.slice(0, 200) ?? null,
              })),
              null,
              2,
            )}`,
          });
        }
      } catch (err) {
        // DB errors should not break compaction
        console.log("ndomo: compaction DB enrichment failed", (err as Error).message);
      }
    });

    // (b) Circuit breaker (runs for EVERY tool call) + no-overlap rule for
    //     write/edit tools. The breaker check happens first so a tripped
    //     session short-circuits before any lock is acquired — preserving
    //     the existing FileLock lifecycle for healthy sessions.
    await ctx.tool.hook("execute.before", async (event) => {
      // ── Circuit breaker: count every call, evaluate thresholds ─────────
      const cb = circuitBreaker.check(event.sessionID, event.tool, event.input);
      if (cb.trippedNow) {
        // One-shot edge: this is the single call that crossed a threshold.
        // Emit ONE warning + (optionally) fail the relevant task, then throw.
        const taskToFail = resolveCircuitBreakerTaskFailure(event.tool, event.input);
        console.error(
          `[ndomo] circuit breaker TRIPPED — session=${event.sessionID} tool=${event.tool} reason=${cb.reason} calls=${cb.callCount} identical=${cb.identicalCount}${taskToFail ? ` failingTask=${taskToFail}` : " (no task target)"}`,
        );
        if (taskToFail) {
          try {
            updateTaskStatus(
              db,
              taskToFail,
              "failed",
              { error: CIRCUIT_BREAKER_ERROR },
              "ndomo-circuit-breaker",
              { agent: "ndomo-circuit-breaker", sessionId: event.sessionID },
            );
          } catch (err) {
            // A failed task-write (e.g. missing row) must NOT mask the
            // circuit-breaker throw itself. Log and continue to the throw.
            console.warn(
              `[ndomo] circuit breaker: could not mark task ${taskToFail} failed: ${(err as Error).message}`,
            );
          }
        }
        throw new Error(CIRCUIT_BREAKER_ERROR);
      }
      if (cb.blocked) {
        // Session already tripped on an earlier call — block silently so the
        // log isn't spammed (one-shot, no re-warn / re-fail).
        throw new Error(CIRCUIT_BREAKER_ERROR);
      }

      // ── File-lock enforcement (existing behavior, unchanged) ───────────
      if (event.tool !== "write" && event.tool !== "edit") return;

      const filepath = extractFilePath(event.input);
      if (!filepath) return;

      const key = `${event.sessionID}:${event.id}`;
      const blockedBy = activeWrites.acquire(filepath, key);
      if (blockedBy != null) {
        throw new Error(`ndomo: file locked by active task ${blockedBy}`);
      }
    });

    // (c) Remove filepath from activeWrites after tool completes — wrapped in
    //     try/finally so the lock releases even if downstream hook logic throws
    //     or the SDK aborts the chain mid-way (regression: lock leaks blocked
    //     subsequent writes indefinitely).
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        // (future) post-write hooks (audit, git staging) go here
      } finally {
        if (event.tool === "write" || event.tool === "edit") {
          const filepath = extractFilePath(event.input);
          if (filepath) {
            const key = `${event.sessionID}:${event.id}`;
            activeWrites.release(filepath, key);
          }
        }
      }
    });

    // (d) Note: v2 exposes no dedicated `file.edited` hook either. Post-write
    //     logging must ride on `tool.execute.after` (filtered by tool name).

    // (e) Inject ndomo env vars into shell sessions
    await ctx.shell.hook("create.before", (event) => {
      event.env.NDOMO_PRESET = opts.preset ?? "default";
      event.env.NDOMO_PROJECT = worktree || directory;
    });

    // ─── Tools ───────────────────────────────────────────────────────────

    const toolDefs: Record<string, LegacyToolDef> = {
      // ── Routing ────────────────────────────────────────────────────────

      route: tool({
        description: "Route a task to the appropriate specialist agent.",
        args: {
          description: z.string(),
          type: z.enum([
            "implement",
            "explore",
            "research",
            "design",
            "debug",
            "audit",
            "document",
            "debate",
          ]),
          stack: z.enum(["go", "vue", "js", "python", "zig", "generic", "unknown"]).optional(),
          risk: z.enum(["low", "medium", "high"]).optional(),
          files: z.array(z.string()).optional(),
        },
        execute: async (args) => {
          const decision = await routeTask(
            {
              description: args.description,
              type: args.type,
              stack: args.stack ?? "unknown",
              risk: args.risk ?? "low",
              files: args.files ?? [],
            },
            { jev: jevConfig },
          );
          return JSON.stringify(decision);
        },
      }),

      can_parallel: tool({
        description: "Check whether a set of routing decisions can run in parallel.",
        args: {
          tasks: z.string(),
        },
        execute: async (args) => {
          let parsed: RoutingDecision[];
          try {
            parsed = JSON.parse(args.tasks) as RoutingDecision[];
          } catch {
            throw new Error(
              "ndomo: invalid JSON in tasks parameter — expected array of RoutingDecision",
            );
          }
          const parallel = canRunParallel(parsed);
          return JSON.stringify({ parallel });
        },
      }),

      // ── Background dispatch ────────────────────────────────────────────

      dispatch: tool({
        description: "Dispatch a background task to a specialist agent and return its task ID.",
        args: {
          agent: z.string(),
          description: z.string(),
          files: z.array(z.string()).optional(),
          worktree: z.string().optional(),
        },
        execute: async (args) => {
          const taskId = dispatcher.dispatch({
            agent: args.agent,
            description: args.description,
            ...(args.files !== undefined && { files: args.files }),
            ...(args.worktree !== undefined && { worktree: args.worktree }),
          });
          return JSON.stringify({ taskId, status: "pending" });
        },
      }),

      active_tasks: tool({
        description: "List all currently active (pending + running) tasks.",
        args: {},
        execute: async () => {
          return JSON.stringify(dispatcher.getActive());
        },
      }),

      background_task_status: tool({
        description: "Get the status of a background task by ID.",
        args: { taskId: z.string() },
        execute: async (args) => {
          const task = dispatcher.getStatus(args.taskId);
          if (!task) throw new Error(`ndomo: background task ${args.taskId} not found`);
          return JSON.stringify(task);
        },
      }),

      background_task_cancel: tool({
        description:
          "Cancel a pending or running background task. Returns true if cancelled, false if task was already terminal.",
        args: { taskId: z.string() },
        execute: async (args) => {
          const cancelled = dispatcher.cancel(args.taskId);
          return JSON.stringify({ taskId: args.taskId, cancelled });
        },
      }),

      // ── Worktrees ──────────────────────────────────────────────────────

      worktree_create: tool({
        description: "Create a new git worktree for isolated coding.",
        args: {
          slug: z.string(),
          branch: z.string(),
          agent: z.string().optional(),
          description: z.string().optional(),
        },
        execute: async (args, ctx) => {
          const path = await createWorktree(
            ctx.directory,
            args.slug,
            args.branch,
            args.agent,
            args.description,
          );
          return JSON.stringify({ path, slug: args.slug, branch: args.branch });
        },
      }),

      worktree_list: tool({
        description: "List all active worktrees in the current project.",
        args: {},
        execute: async (_args, ctx) => {
          return JSON.stringify(await listActive(ctx.directory));
        },
      }),

      worktree_remove: tool({
        description: "Remove a git worktree by slug.",
        args: {
          slug: z.string(),
          abandon: z.boolean().optional(),
        },
        execute: async (args, ctx) => {
          await removeWorktree(ctx.directory, args.slug, args.abandon ?? false);
          return JSON.stringify({ removed: true, slug: args.slug });
        },
      }),

      worktree_verify: tool({
        description: "Verify integrity of all active worktrees.",
        args: {},
        execute: async (_args, ctx) => {
          return JSON.stringify(await verifyIntegrity(ctx.directory));
        },
      }),

      // ── Memory ─────────────────────────────────────────────────────────

      memory_search: tool({
        description:
          "Build memory search options for opencode-mem. The foreman agent passes the result to its mem tool.",
        args: {
          query: z.string(),
          scope: z.enum(["project", "all-projects"]).optional(),
        },
        execute: async (args, ctx) => {
          const tag = getProjectTag(ctx.directory);
          const compressedQuery = cavemanCompress(args.query);
          const options = memorySearchOptions(compressedQuery, args.scope ?? "project");
          return JSON.stringify({ tag, options });
        },
      }),

      memory_compress: tool({
        description: "Compress arbitrary text into caveman format.",
        args: {
          text: z.string(),
        },
        execute: async (args) => {
          const result = cavemanCompress(args.text);
          return JSON.stringify({
            original: args.text.length,
            compressed: result.length,
            result,
          });
        },
      }),

      // ── Health ─────────────────────────────────────────────────────────

      ndomo_write_unlock: tool({
        description:
          "Admin: force-release a write/edit lock on a filepath. Use when a prior tool execution crashed or its SDK hook chain broke before `tool.execute.after` fired, leaving a stale lock. TTL sweep also handles this automatically — this tool is for manual recovery.",
        args: {
          filepath: z.string(),
        },
        execute: async (args) => {
          const released = activeWrites.forceRelease(args.filepath);
          return JSON.stringify({
            filepath: args.filepath,
            released,
            activeWritesRemaining: activeWrites.size,
          });
        },
      }),

      status: tool({
        description: "Plugin health check — returns ndomo state summary.",
        args: {},
        execute: async (_args, ctx) => {
          return JSON.stringify({
            plugin: "ndomo",
            version: "0.1.0",
            directory: ctx.directory,
            worktree: ctx.worktree || null,
            activeTasks: dispatcher.getActive().length,
            activeWrites: activeWrites.size,
            preset: opts.preset ?? "default",
          });
        },
      }),

      // ── Plans ──────────────────────────────────────────────────────

      plan_create: tool({
        description: "Create a new plan in the ndomo state database.",
        args: {
          slug: z.string(),
          title: z.string(),
          overview: z.string(),
          approach: z.string().optional(),
          priority: z.number().optional(),
          complexity: z.number().int().min(1).max(5).optional(),
          sessionId: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          files: z.array(z.string()).optional(),
        },
        execute: async (args, ctx) => {
          return JSON.stringify(
            planCreateExecutor(db, args, { ...ctx, agent: ctx.agent ?? "unknown" }),
          );
        },
      }),

      plan_get: tool({
        description: "Get a plan by ID or slug.",
        args: {
          id: z.string().optional(),
          slug: z.string().optional(),
        },
        execute: async (args) => {
          if (!args.id && !args.slug) {
            throw new Error("ndomo: plan_get requires id or slug");
          }
          let plan = null;
          if (args.id) {
            plan = getPlan(db, args.id);
          } else if (args.slug) {
            plan = getPlanBySlug(db, args.slug);
          }
          return JSON.stringify(plan);
        },
      }),

      plan_list: tool({
        description: "List plans, optionally filtered by status and session.",
        args: {
          status: z
            .enum(["draft", "approved", "executing", "completed", "failed", "abandoned"])
            .optional(),
          sessionId: z.string().optional(),
          limit: z.number().optional(),
        },
        execute: async (args) => {
          const opts: { status?: PlanStatus; sessionId?: string; limit?: number } = {};
          if (args.status) opts.status = args.status;
          if (args.sessionId) opts.sessionId = args.sessionId;
          if (args.limit !== undefined) opts.limit = args.limit;
          return JSON.stringify(listPlans(db, opts));
        },
      }),

      plan_search: tool({
        description:
          "Full-text search over plan titles, overviews, and approaches using SQLite FTS5.",
        args: {
          query: z.string(),
          limit: z.number().optional(),
          includeArchived: z.boolean().optional(),
        },
        execute: async (args) => {
          return JSON.stringify(
            searchPlans(db, args.query, args.limit ?? 20, {
              includeArchived: args.includeArchived ?? false,
            }),
          );
        },
      }),

      /**
       * LEGACY: El flujo v2 de foreman (4 pasos) skip este tool.
       * Solo invocado manualmente si quieres gating explícito antes de ejecutar.
       * v2 flow: plan_create (draft) → task_create_batch (dispatch directo).
       */
      plan_approve: tool({
        description: "Mark a plan as approved. Sets approved_at to the current timestamp.",
        args: { id: z.string() },
        execute: async (args, ctx) => {
          return JSON.stringify(
            approvePlan(db, args.id, {
              sessionId: ctx.sessionID,
              updatedBy: ctx.agent ?? "unknown",
            }),
          );
        },
      }),

      plan_delete: tool({
        description:
          "Permanently delete a plan and all its data (tasks, files, tags). Requires confirm: true. Rejects draft plans and plans with active tasks.",
        args: {
          id: z.string(),
          confirm: z.boolean(),
        },
        execute: async (args) => {
          return JSON.stringify(deletePlan(db, args.id, { confirm: args.confirm }));
        },
      }),

      plan_update_status: tool({
        description:
          "Update a plan's status (draft, approved, executing, completed, failed, abandoned). Auto-archives to markdown on terminal status. Use dryRun=true to pre-check readiness (blockers/warnings) without mutating. Use force=true with forceReason to bypass blockers (except status_invalid) — captured to plan_audit.",
        args: {
          id: z.string(),
          status: z.enum(["draft", "approved", "executing", "completed", "failed", "abandoned"]),
          dryRun: z.boolean().optional(),
          force: z.boolean().optional(),
          forceReason: z.string().optional(),
        },
        execute: async (args, ctx) => {
          const archiveDir = resolveArchiveDir(worktree || directory);
          const executorArgs: {
            id: string;
            status: PlanStatus;
            dryRun?: boolean;
            force?: boolean;
            forceReason?: string;
          } = {
            id: args.id,
            status: args.status as PlanStatus,
          };
          if (args.dryRun !== undefined) executorArgs.dryRun = args.dryRun;
          if (args.force !== undefined) executorArgs.force = args.force;
          if (args.forceReason !== undefined) executorArgs.forceReason = args.forceReason;
          const result = planUpdateStatusExecutor(
            db,
            executorArgs,
            {
              agent: ctx.agent,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              directory,
              worktree,
            },
            archiveDir,
          );
          // T3.3: auto-checkpoint on phase transition
          if (result.statusChanged && !result.dryRun) {
            autoCheckpoint.dispatch("phase_transition", {
              planId: args.id,
              sessionId: ctx.sessionID,
              blockers: result.blockers.length > 0 ? result.blockers : undefined,
            });
          }
          return JSON.stringify(result);
        },
      }),

      plan_progress: tool({
        description:
          "Get plan progress summary (task counts + percentage). Filterable by planId and/or owner (metadata.ownedBy).",
        args: {
          planId: z.string().optional(),
          owner: z.string().optional(),
        },
        execute: async (args) => {
          if (args.owner) {
            if (args.planId) {
              const rows = db
                .query(
                  `SELECT pp.* FROM plan_progress_active pp
                 JOIN plans p ON pp.plan_id = p.id
                 WHERE pp.plan_id = ? AND json_extract(p.metadata, '$.ownedBy') = ?`,
                )
                .all(args.planId, args.owner);
              return JSON.stringify(rows);
            }
            const rows = db
              .query(
                `SELECT pp.* FROM plan_progress_active pp
               JOIN plans p ON pp.plan_id = p.id
               WHERE json_extract(p.metadata, '$.ownedBy') = ?`,
              )
              .all(args.owner);
            return JSON.stringify(rows);
          }
          if (args.planId) {
            const rows = db
              .query("SELECT * FROM plan_progress_active WHERE plan_id = ?")
              .all(args.planId);
            return JSON.stringify(rows);
          }
          const rows = db.query("SELECT * FROM plan_progress_active").all();
          return JSON.stringify(rows);
        },
      }),

      plan_files_write: tool({
        description:
          "Register files for a plan in plan_files with explicit roles (e.g. 'input', 'modified', 'output', 'reference'). Uses INSERT OR IGNORE for idempotency.",
        args: {
          planId: z.string(),
          files: z.array(
            z.object({
              filePath: z.string(),
              role: z.string(),
            }),
          ),
        },
        execute: async (args) => {
          let inserted = 0;
          for (const f of args.files) {
            const result = db
              .query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)")
              .run(args.planId, f.filePath, f.role);
            inserted += result.changes;
          }
          return JSON.stringify({
            planId: args.planId,
            inserted,
            totalRequested: args.files.length,
          });
        },
      }),

      // ── Tasks ──────────────────────────────────────────────────────

      task_create_batch: tool({
        description:
          "Create multiple tasks for a plan in a single transaction. Each task gets a UUID and sequential order_index. Set verificationRequired=true on a task to enable the v17/T1 execution gate (updateTaskStatus('done') blocked until the inspector passes or a foreman force-waives). metadata.verificationRequired=true is honored as a backwards-compatible fallback.",
        args: {
          planId: z.string(),
          tasks: z.array(
            z.object({
              description: z.string(),
              agent: z.string(),
              files: z.array(z.string()).optional(),
              complexity: z.number().int().min(1).max(5).optional(),
              dependencies: z.array(z.string()).optional(),
              metadata: z.record(z.string(), z.unknown()).optional(),
              verificationRequired: z.boolean().optional(),
            }),
          ),
        },
        execute: async (args, ctx) => {
          const auditCtx = {
            createdBy: ctx.agent ?? "unknown",
            updatedBy: ctx.agent ?? "unknown",
            sourceSessionId: ctx.sessionID,
            sourceMessageId: ctx.messageID,
          };
          const tasks = createTasksBatch(
            db,
            args.planId,
            args.tasks.map((t) => mapTaskCreateBatchArg(t, auditCtx)),
          );
          return JSON.stringify(tasks);
        },
      }),

      task_list: tool({
        description:
          "List tasks for a plan, optionally filtered by status. Set includeArchived=true to include tasks from archived plans (archived_at IS NOT NULL).",
        args: {
          planId: z.string(),
          status: z.enum(["pending", "running", "done", "failed", "blocked"]).optional(),
          includeArchived: z.boolean().optional(),
        },
        execute: async (args) => {
          const opts: { status?: TaskStatus; includeArchived?: boolean } = {};
          if (args.status) opts.status = args.status as TaskStatus;
          if (args.includeArchived) opts.includeArchived = true;
          return JSON.stringify(listTasksByPlan(db, args.planId, opts));
        },
      }),

      task_update_status: tool({
        description:
          "Update a task's status. Optionally record result or error text. When transitioning to 'done' on a verification-gated task (v17/T1), pass force=true with a non-blank forceReason to waive the gate.",
        args: {
          id: z.string(),
          status: z.enum(["pending", "running", "done", "failed", "blocked"]),
          result: z.string().optional(),
          error: z.string().optional(),
          force: z.boolean().optional(),
          forceReason: z.string().optional(),
        },
        execute: async (args, ctx) => {
          const fields: {
            result?: string;
            error?: string;
            force?: boolean;
            forceReason?: string;
          } = {};
          if (args.result !== undefined) fields.result = args.result;
          if (args.error !== undefined) fields.error = args.error;
          if (args.force !== undefined) fields.force = args.force;
          if (args.forceReason !== undefined) fields.forceReason = args.forceReason;
          const result = updateTaskStatus(
            db,
            args.id,
            args.status as TaskStatus,
            fields,
            ctx.agent ?? "unknown",
            { agent: ctx.agent, sessionId: ctx.sessionID },
          );
          // T3.3: auto-checkpoint when last task in plan completes
          if (result && args.status === "done" && result.planId) {
            const pending = listTasksByPlan(db, result.planId, { status: "pending" });
            if (pending.length === 0) {
              autoCheckpoint.dispatch("task_batch_complete", {
                planId: result.planId,
                sessionId: ctx.sessionID,
              });
            }
          }
          return JSON.stringify(result);
        },
      }),

      // ── T1 (v17): execution gate verification ──────────────────────────────

      task_verify: tool({
        description:
          "Record an independent-verifier verdict on a task's execution gate (v17/T1). verdict='passed' is inspector-only unless force+forceReason; 'failed'/'waived' require reason. Override of an existing 'passed' requires force.",
        args: {
          taskId: z.string(),
          verdict: z.enum(["passed", "failed", "waived"]),
          result: z.unknown().optional(),
          reason: z.string().optional(),
          force: z.boolean().optional(),
          forceReason: z.string().optional(),
        },
        execute: async (args, ctx) => {
          // result may arrive as JSON string or object — normalize to a record.
          let resultObj: Record<string, unknown> | undefined;
          if (args.result !== undefined) {
            if (typeof args.result === "string") {
              try {
                const parsed = JSON.parse(args.result);
                resultObj =
                  parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                    ? (parsed as Record<string, unknown>)
                    : { value: parsed };
              } catch {
                resultObj = { raw: args.result };
              }
            } else if (typeof args.result === "object" && args.result !== null) {
              resultObj = args.result as Record<string, unknown>;
            }
          }
          const updated = recordTaskVerification(
            db,
            args.taskId,
            args.verdict,
            resultObj,
            ctx.agent ?? "unknown",
            {
              ...(args.force !== undefined ? { force: args.force } : {}),
              ...(args.forceReason !== undefined ? { forceReason: args.forceReason } : {}),
              ...(args.reason !== undefined ? { reason: args.reason } : {}),
            },
          );
          return JSON.stringify(updated);
        },
      }),

      task_search: tool({
        description:
          "Full-text search over task descriptions, results, and errors using SQLite FTS5.",
        args: {
          query: z.string(),
          limit: z.number().optional(),
          includeArchived: z.boolean().optional(),
        },
        execute: async (args) => {
          return JSON.stringify(
            searchTasks(db, args.query, args.limit ?? 20, {
              includeArchived: args.includeArchived ?? false,
            }),
          );
        },
      }),

      task_next_for_agent: tool({
        description:
          "Get the next pending task for a given agent (optionally within a specific plan).",
        args: {
          agent: z.string(),
          planId: z.string().optional(),
        },
        execute: async (args) => {
          const opts = args.planId ? { planId: args.planId } : {};
          return JSON.stringify(nextTaskForAgent(db, args.agent, opts));
        },
      }),

      task_dependency_resolver: tool({
        description:
          "Resolve task dependencies: check whether a task's dependencies are all done, and list pending/running/failed/blocked/missing deps. Accepts taskId, or planId+orderIndex to look up the task.",
        args: {
          taskId: z.string().optional(),
          planId: z.string().optional(),
          orderIndex: z.number().optional(),
        },
        execute: async (args) => {
          let resolvedId = args.taskId;
          if (!resolvedId) {
            if (!args.planId || args.orderIndex === undefined) {
              throw new Error(
                "ndomo: task_dependency_resolver requires either taskId or planId+orderIndex",
              );
            }
            const row = db
              .query(
                "SELECT id FROM plan_tasks WHERE plan_id = ? AND order_index = ? AND archived_at IS NULL",
              )
              .get(args.planId, args.orderIndex) as { id: string } | undefined;
            if (!row) {
              throw new Error(
                `ndomo: no task found for planId=${args.planId} orderIndex=${args.orderIndex}`,
              );
            }
            resolvedId = row.id;
          }
          return JSON.stringify(resolveTaskDependencies(db, resolvedId));
        },
      }),

      task_peek_for_agent: tool({
        description:
          "List pending tasks for an agent without claiming them (read-only peek, no status change).",
        args: {
          agent: z.string(),
          planId: z.string().optional(),
          limit: z.number().optional(),
        },
        execute: async (args) => {
          const limit = args.limit ?? 10;
          const archiveFilter = "AND archived_at IS NULL";
          const rows = args.planId
            ? db
                .query(
                  `SELECT * FROM plan_tasks WHERE agent = ? AND plan_id = ? AND status = 'pending' ${archiveFilter} ORDER BY order_index LIMIT ?`,
                )
                .all(args.agent, args.planId, limit)
            : db
                .query(
                  `SELECT * FROM plan_tasks WHERE agent = ? AND status = 'pending' ${archiveFilter} ORDER BY order_index LIMIT ?`,
                )
                .all(args.agent, limit);
          return JSON.stringify(rows);
        },
      }),

      task_add_artifact: tool({
        description:
          "Append an artifact path to a task's artifacts array. Optionally register it in plan_files with a role.",
        args: {
          taskId: z.string(),
          artifact: z.string(),
          role: z.string().optional(),
        },
        execute: async (args) => {
          const row = db
            .query("SELECT artifacts, plan_id FROM plan_tasks WHERE id = ?")
            .get(args.taskId) as { artifacts: string; plan_id: string } | undefined;
          if (!row) throw new Error(`ndomo: task ${args.taskId} not found`);
          const currentArtifacts = JSON.parse(row.artifacts) as string[];
          if (currentArtifacts.includes(args.artifact)) {
            return JSON.stringify({ task: null, added: false, reason: "artifact already exists" });
          }
          const updatedArtifacts = [...currentArtifacts, args.artifact];
          db.query("UPDATE plan_tasks SET artifacts = ? WHERE id = ?").run(
            JSON.stringify(updatedArtifacts),
            args.taskId,
          );
          if (args.role) {
            db.query(
              "INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)",
            ).run(row.plan_id, args.artifact, args.role);
          }
          const updatedRow = db.query("SELECT * FROM plan_tasks WHERE id = ?").get(args.taskId);
          return JSON.stringify({ task: updatedRow, added: true });
        },
      }),

      task_review: tool({
        description:
          "Review a completed task. Sets reviewed_by and reviewed_verdict (stored in metadata). Only works on tasks with status='done'.",
        args: {
          taskId: z.string(),
          reviewedBy: z.string(),
          verdict: z.string(),
        },
        execute: async (args) => {
          const row = db
            .query("SELECT status, metadata FROM plan_tasks WHERE id = ?")
            .get(args.taskId) as { status: string; metadata: string | null } | undefined;
          if (!row) throw new Error(`ndomo: task ${args.taskId} not found`);
          if (row.status !== "done")
            throw new Error(`ndomo: task_review requires status='done', got '${row.status}'`);
          const currentMeta = row.metadata ? JSON.parse(row.metadata) : {};
          const updatedMeta = { ...currentMeta, reviewedVerdict: args.verdict };
          db.query("UPDATE plan_tasks SET reviewed_by = ?, metadata = ? WHERE id = ?").run(
            args.reviewedBy,
            JSON.stringify(updatedMeta),
            args.taskId,
          );
          const updatedRow = db.query("SELECT * FROM plan_tasks WHERE id = ?").get(args.taskId);
          return JSON.stringify({ task: updatedRow });
        },
      }),

      // ── Ops (T2: warden) ──────────────────────────────────────────

      incident_create: tool({
        description:
          "Create an ops incident record. Validates severity enum (sev1-4) and FK on triggered_by_deployment_id if provided. Sets metadata.created_by from ctx.agent.",
        args: {
          title: z.string(),
          severity: z.enum(["sev1", "sev2", "sev3", "sev4"]),
          summary: z.string().optional(),
          triggeredByDeploymentId: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        },
        execute: async (args, ctx) => {
          const input: InsertIncident = {
            title: args.title,
            severity: args.severity as IncidentSeverity,
            metadata: { ...(args.metadata ?? {}), created_by: ctx.agent ?? "unknown" },
            ...(args.summary !== undefined && { summary: args.summary }),
            ...(args.triggeredByDeploymentId !== undefined && {
              triggeredByDeploymentId: args.triggeredByDeploymentId,
            }),
          };
          const incident = createIncident(db, input);
          return JSON.stringify(incident);
        },
      }),

      rollback_record: tool({
        description:
          "Record a rollback execution tied to a deployment (required) and optionally an incident and/or new_deployment. Validates FKs + status enum. Sets metadata.executed_by_agent from ctx.agent.",
        args: {
          deploymentId: z.string(),
          plan: z.string(),
          incidentId: z.string().optional(),
          status: z
            .enum(["planned", "approved", "dry_run", "executing", "success", "failed", "cancelled"])
            .optional(),
          newDeploymentId: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        },
        execute: async (args, ctx) => {
          const input: InsertRollback = {
            deploymentId: args.deploymentId,
            plan: args.plan,
            metadata: { ...(args.metadata ?? {}), executed_by_agent: ctx.agent ?? "unknown" },
            ...(args.incidentId !== undefined && { incidentId: args.incidentId }),
            ...(args.status !== undefined && { status: args.status as RollbackStatus }),
            ...(args.newDeploymentId !== undefined && { newDeploymentId: args.newDeploymentId }),
          };
          const rollback = recordRollback(db, input);
          return JSON.stringify(rollback);
        },
      }),

      task_escalate: tool({
        description:
          "Escalar tarea compleja al foreman. Crea un plan stub (foreman) con metadata.escalatedFrom=<planId_or_null> + metadata.escalatedBy='craftsman' y notifica via session_checkpoint. NO ejecuta código.",
        args: {
          sourcePlanId: z.string().optional(),
          sourceTaskId: z.string().optional(),
          reason: z.string(),
          suggestedApproach: z.string().optional(),
        },
        execute: async (args, ctx) => {
          if (!args.reason || args.reason.trim().length === 0) {
            throw new Error("ndomo: task_escalate requires a non-empty reason");
          }
          const escalateArgs: Parameters<typeof escalateToForeman>[2] = {
            reason: args.reason,
          };
          if (args.sourcePlanId !== undefined) escalateArgs.sourcePlanId = args.sourcePlanId;
          if (args.sourceTaskId !== undefined) escalateArgs.sourceTaskId = args.sourceTaskId;
          if (args.suggestedApproach !== undefined)
            escalateArgs.suggestedApproach = args.suggestedApproach;
          // Thread the boot-resolved projectDir so the escalation checkpoint
          // persists a continuity ledger alongside the DB write.
          return JSON.stringify(escalateToForeman(db, { ...ctx, projectDir }, escalateArgs));
        },
      }),

      // ── Analyses (v14) ────────────────────────────────────────────

      analysis_create: tool({
        description:
          "Create a new analysis record in the standalone analyses table. Use for analyst findings, architecture audits, onboarding notes, or cartography outputs. Optionally link to a source plan via sourcePlanId.",
        args: {
          slug: z.string(),
          title: z.string(),
          projectPath: z.string(),
          summary: z.string(),
          findingsJson: z.string(),
          sourcePlanId: z.string().optional(),
          agent: z.string().optional(),
          sessionId: z.string().optional(),
        },
        execute: async (args, ctx) => {
          try {
            JSON.parse(args.findingsJson);
          } catch {
            throw new Error("ndomo: findingsJson must be valid JSON");
          }
          // Agent boundary contract (v15): ranger emits observation-only findings.
          // Throws if ctx.agent === 'ranger' AND findings carry proposedAction.
          validateAnalysisFindings(args.findingsJson, ctx.agent);
          const input = {
            slug: args.slug,
            title: args.title,
            projectPath: args.projectPath,
            summary: args.summary,
            findingsJson: args.findingsJson,
            agent: args.agent ?? "ranger",
            createdBy: ctx.agent ?? "ranger",
            ...(args.sourcePlanId !== undefined && { sourcePlanId: args.sourcePlanId }),
            ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
          };
          const result = createAnalysis(db, input);
          return JSON.stringify(result, null, 2);
        },
      }),

      analysis_get: tool({
        description: "Get a single analysis by id. Returns the analysis with parsed findingsJson.",
        args: {
          id: z.string(),
        },
        execute: async (args) => {
          const result = getAnalysis(db, args.id);
          if (!result) {
            throw new Error(`ndomo: analysis '${args.id}' not found`);
          }
          return JSON.stringify(
            { ...result, findingsJson: JSON.parse(result.findingsJson) },
            null,
            2,
          );
        },
      }),

      analysis_list: tool({
        description:
          "List analyses with optional filters: sourcePlanId, agent, projectPath, archived, limit.",
        args: {
          sourcePlanId: z.string().optional(),
          agent: z.string().optional(),
          projectPath: z.string().optional(),
          archived: z.boolean().optional(),
          limit: z.number().optional(),
        },
        execute: async (args) => {
          const opts: {
            sourcePlanId?: string;
            agent?: string;
            projectPath?: string;
            archived?: boolean;
            limit?: number;
          } = {};
          if (args.sourcePlanId !== undefined) opts.sourcePlanId = args.sourcePlanId;
          if (args.agent !== undefined) opts.agent = args.agent;
          if (args.projectPath !== undefined) opts.projectPath = args.projectPath;
          if (args.archived !== undefined) opts.archived = args.archived;
          if (args.limit !== undefined) opts.limit = args.limit;
          const results = listAnalyses(db, opts);
          return JSON.stringify(
            results.map((r) => ({ ...r, findingsJson: JSON.parse(r.findingsJson) })),
            null,
            2,
          );
        },
      }),

      analysis_search: tool({
        description:
          "Full-text search over analyses (title + summary + findings) using FTS5. Returns matching analyses.",
        args: {
          query: z.string(),
          limit: z.number().optional(),
        },
        execute: async (args) => {
          const opts: { limit?: number } = {};
          if (args.limit !== undefined) opts.limit = args.limit;
          const results = searchAnalyses(db, args.query, opts);
          return JSON.stringify(
            results.map((r) => ({ ...r, findingsJson: JSON.parse(r.findingsJson) })),
            null,
            2,
          );
        },
      }),

      analysis_update: tool({
        description:
          "Update an existing analysis. Only provided fields are changed. Bumps updated_at.",
        args: {
          id: z.string(),
          title: z.string().optional(),
          summary: z.string().optional(),
          findingsJson: z.string().optional(),
        },
        execute: async (args, ctx) => {
          if (args.findingsJson !== undefined) {
            try {
              JSON.parse(args.findingsJson);
            } catch {
              throw new Error("ndomo: findingsJson must be valid JSON");
            }
            // Agent boundary contract (v15): same check as analysis_create.
            // Only triggered when findingsJson is being mutated (no-op otherwise).
            validateAnalysisFindings(args.findingsJson, ctx.agent);
          }
          const patch: Record<string, unknown> = {};
          if (args.title !== undefined) patch.title = args.title;
          if (args.summary !== undefined) patch.summary = args.summary;
          if (args.findingsJson !== undefined) patch.findingsJson = args.findingsJson;
          const result = updateAnalysis(db, args.id, patch);
          return JSON.stringify(result, null, 2);
        },
      }),

      analysis_archive: tool({
        description:
          "Soft-delete an analysis by setting archived_at. Idempotent. The row is preserved but excluded from default list queries.",
        args: {
          id: z.string(),
        },
        execute: async (args) => {
          const result = archiveAnalysis(db, args.id);
          return JSON.stringify(
            { ok: true, id: result.id, archivedAt: result.archivedAt },
            null,
            2,
          );
        },
      }),

      analysis_link_plan: tool({
        description:
          "Link an existing analysis to a source plan (set source_plan_id). Pass null to unlink.",
        args: {
          id: z.string(),
          planId: z.string().nullable(),
        },
        execute: async (args) => {
          if (args.planId === null) {
            const result = unlinkAnalysisFromPlan(db, args.id);
            return JSON.stringify({ ok: true, id: result.id, sourcePlanId: null }, null, 2);
          }
          const result = linkAnalysisToPlan(db, args.id, args.planId);
          return JSON.stringify(
            { ok: true, id: result.id, sourcePlanId: result.sourcePlanId },
            null,
            2,
          );
        },
      }),

      // ── Sessions ───────────────────────────────────────────────────

      session_start: tool({
        description:
          "Start a new ndomo session with a goal. Sessions track continuity across multiple agents.",
        args: {
          id: z.string(),
          goal: z.string(),
          planId: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        },
        execute: async (args, ctx) => {
          const typedMeta = (args.metadata ?? {}) as SessionMetadata;
          return JSON.stringify(
            startSession(db, {
              id: args.id,
              goal: args.goal,
              ...(args.planId !== undefined && { planId: args.planId }),
              metadata: typedMeta,
              createdBy: ctx.agent ?? "unknown",
              sourceMessageId: ctx.messageID,
            }),
          );
        },
      }),

      session_checkpoint: tool({
        description:
          "Save a checkpoint in an active session with arbitrary state and optional key decisions.",
        args: {
          id: z.string(),
          state: z.record(z.string(), z.unknown()),
          keyDecisions: z.string().optional(),
        },
        execute: async (args) => {
          // projectDir from the plugin closure boot → each checkpoint writes a
          // portable ledger at <projectDir>/.ndomo/ledgers/{id}.md.
          return JSON.stringify(
            checkpointSession(db, args.id, args.state, args.keyDecisions, { projectDir }),
          );
        },
      }),

      session_end: tool({
        description:
          "Mark a session as ended. Sets ended_at. Reconciliación: planes con status='executing' o 'approved' sin cerrar en esta session → 'abandoned' con metadata.reason='session_ended'.",
        args: { id: z.string() },
        execute: async (args, ctx) => {
          const plansAbandoned = reconcileAbandonedPlans(db, args.id, ctx.agent ?? "unknown");
          const session = endSession(db, args.id);
          return JSON.stringify({
            session,
            plansAbandoned,
            sessionEnded: session !== null,
          });
        },
      }),

      // ── Filesystem ledgers, designs and critic review (v2: consolidated
      //    from the former standalone custom tools under tools/, which no
      //    longer load in v2 — the tools-dir mechanism is gone) ──────────

      ledger_create: tool({
        description:
          "Create (or idempotently overwrite) a portable session ledger at <projectDir>/.ndomo/ledgers/{sessionId}.md. DB-free, atomic write. Required: sessionId, goal. Optional: planId, state, keyDecisions, agentHistory, metadata, startedAt. Returns { sessionId, filePath, byteSize, updatedAt, created } where created=true means the file did not exist before. sessionId is sanitized for the filename (path-traversal-safe). To patch an existing ledger without rewriting it whole, use ledger_update.",
        args: {
          sessionId: z.string(),
          goal: z.string(),
          planId: z.string().optional(),
          state: z.record(z.string(), z.unknown()).optional(),
          keyDecisions: z.string().optional(),
          agentHistory: z
            .array(
              z.object({
                agent: z.string(),
                taskId: z.string().optional(),
                startedAt: z.number().optional(),
                endedAt: z.number().optional(),
              }),
            )
            .optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          startedAt: z.number().optional(),
        },
        execute: async (args) => {
          const now = Date.now();
          // Normalize each agent-history entry to the full Session shape.
          const agentHistory = (args.agentHistory ?? []).map((h) => ({
            agent: h.agent,
            taskId: h.taskId ?? null,
            startedAt: h.startedAt ?? now,
            endedAt: h.endedAt ?? null,
          }));
          const data: LedgerData = {
            sessionId: args.sessionId,
            goal: args.goal,
            planId: args.planId ?? null,
            state: args.state ?? {},
            keyDecisions: args.keyDecisions ?? null,
            agentHistory,
            startedAt: args.startedAt ?? now,
            lastCheckpoint: null,
            endedAt: null,
            outcome: null,
            metadata: args.metadata ?? {},
          };
          return JSON.stringify(writeLedger(projectDir, data), null, 2);
        },
      }),

      ledger_get: tool({
        description:
          "Read a portable session ledger from <projectDir>/.ndomo/ledgers/{sessionId}.md. DB-free. Returns the parsed ledger data, or null if the ledger does not exist. Pass raw=true to return the full human-readable markdown instead (still null when the file is missing). sessionId is sanitized for the filename (path-traversal-safe).",
        args: {
          sessionId: z.string(),
          raw: z.boolean().optional(),
        },
        execute: async (args) => {
          if (args.raw) {
            return JSON.stringify(readLedgerRaw(projectDir, args.sessionId));
          }
          return JSON.stringify(readLedger(projectDir, args.sessionId));
        },
      }),

      ledger_update: tool({
        description:
          "Patch an existing portable session ledger at <projectDir>/.ndomo/ledgers/{sessionId}.md. DB-free, atomic, read-merge-rewrite. Throws if the ledger does not exist (use ledger_create first). All fields optional: goal, planId, state, keyDecisions, agentHistory, metadata, lastCheckpoint, endedAt, outcome. Only provided fields change; an explicit null clears a field. sessionId and startedAt are immutable here. state/metadata are replaced wholesale (not deep-merged). sessionId is sanitized for the filename (path-traversal-safe).",
        args: {
          sessionId: z.string(),
          goal: z.string().optional(),
          // Nullable-optional: these fields carry `| null` in LedgerData, so an
          // explicit null is a meaningful "clear this" intent (distinct from
          // omission = preserve). The merge below keys off `!== undefined`.
          planId: z.string().nullable().optional(),
          state: z.record(z.string(), z.unknown()).optional(),
          keyDecisions: z.string().nullable().optional(),
          agentHistory: z
            .array(
              z.object({
                agent: z.string(),
                taskId: z.string().optional(),
                startedAt: z.number().optional(),
                endedAt: z.number().optional(),
              }),
            )
            .optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          lastCheckpoint: z.number().nullable().optional(),
          endedAt: z.number().nullable().optional(),
          outcome: z.enum(["success", "partial", "failed", "abandoned"]).nullable().optional(),
        },
        execute: async (args) => {
          const existing = readLedger(projectDir, args.sessionId);
          if (existing === null) {
            throw new Error(
              `ndomo: cannot update ledger — no ledger found for sessionId '${args.sessionId}' at <projectDir>/.ndomo/ledgers/. Use ledger_create first.`,
            );
          }
          const agentHistoryPatch =
            args.agentHistory !== undefined
              ? args.agentHistory.map((h) => ({
                  agent: h.agent,
                  taskId: h.taskId ?? null,
                  startedAt: h.startedAt ?? Date.now(),
                  endedAt: h.endedAt ?? null,
                }))
              : undefined;
          const merged: LedgerData = {
            ...existing,
            ...(args.goal !== undefined && { goal: args.goal }),
            ...(args.planId !== undefined && { planId: args.planId }),
            ...(args.state !== undefined && { state: args.state }),
            ...(args.keyDecisions !== undefined && { keyDecisions: args.keyDecisions }),
            ...(agentHistoryPatch !== undefined && { agentHistory: agentHistoryPatch }),
            ...(args.metadata !== undefined && { metadata: args.metadata }),
            ...(args.lastCheckpoint !== undefined && { lastCheckpoint: args.lastCheckpoint }),
            ...(args.endedAt !== undefined && { endedAt: args.endedAt }),
            ...(args.outcome !== undefined && { outcome: args.outcome }),
            // sessionId + startedAt intentionally NOT overridable here.
          };
          return JSON.stringify(writeLedger(projectDir, merged), null, 2);
        },
      }),

      design_create: tool({
        description:
          "Create a brainstorm / ADR-style design document on the filesystem at <projectDir>/.ndomo/designs/YYYY-MM-DD-{slug}-design.md. DB-free. slug+title+problem required; planId/sessionId are soft references (no FK check). Filename collisions resolved with a numeric suffix.",
        args: {
          slug: z.string(),
          title: z.string(),
          problem: z.string(),
          goals: z.array(z.string()).optional(),
          constraints: z.array(z.string()).optional(),
          scope: z.array(z.string()).optional(),
          exclusions: z.array(z.string()).optional(),
          options: z
            .array(
              z.object({
                name: z.string(),
                description: z.string().optional(),
                pros: z.array(z.string()).optional(),
                cons: z.array(z.string()).optional(),
              }),
            )
            .optional(),
          decision: z.string().optional(),
          tradeoffs: z.array(z.string()).optional(),
          consequences: z.array(z.string()).optional(),
          openQuestions: z.array(z.string()).optional(),
          planId: z.string().optional(),
          sessionId: z.string().optional(),
          agent: z.string().optional(),
          date: z.string().optional(),
        },
        execute: async (args, ctx) => {
          const input: DesignInput = {
            slug: args.slug,
            title: args.title,
            problem: args.problem,
            ...(args.goals !== undefined && { goals: args.goals }),
            ...(args.constraints !== undefined && { constraints: args.constraints }),
            ...(args.scope !== undefined && { scope: args.scope }),
            ...(args.exclusions !== undefined && { exclusions: args.exclusions }),
            ...(args.options !== undefined && { options: args.options as DesignOption[] }),
            ...(args.decision !== undefined && { decision: args.decision }),
            ...(args.tradeoffs !== undefined && { tradeoffs: args.tradeoffs }),
            ...(args.consequences !== undefined && { consequences: args.consequences }),
            ...(args.openQuestions !== undefined && { openQuestions: args.openQuestions }),
            ...(args.planId !== undefined && { planId: args.planId }),
            ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
            agent: args.agent ?? ctx.agent ?? "foreman",
            ...(args.date !== undefined && { date: args.date }),
          };
          return JSON.stringify(createDesign(projectDir, input), null, 2);
        },
      }),

      critic_review: tool({
        description:
          "Return a binary APPROVED/REJECTED code-review report from a diff. The result includes the task_verify payload; it never bypasses inspector authority.",
        args: {
          diff: z.string(),
          verdict: z.enum(["APPROVED", "REJECTED"]),
          critical: z.unknown().optional(),
          optimizations: z.unknown().optional(),
          compliance: z.unknown().optional(),
          actionRequired: z.string().optional(),
          scores: z.unknown().optional(),
        },
        execute: async (args, ctx) => {
          const review = buildCriticReview({
            diff: args.diff,
            verdict: args.verdict,
            reviewedBy: ctx.agent ?? "critic",
            critical: args.critical,
            optimizations: args.optimizations,
            compliance: args.compliance,
            actionRequired: args.actionRequired,
            scores: args.scores,
          });
          return JSON.stringify({ ...review, executionGate: toTaskVerification(review) }, null, 2);
        },
      }),
    };

    await ctx.tool.transform((editor) => {
      registerTools(editor, toolDefs, { directory, worktree });
    });

    return async () => {
      await stopHttpServer();
      process.off("SIGINT", onProcessSignal);
      process.off("SIGTERM", onProcessSignal);
      try {
        closeDb(db);
      } catch {
        /* already closed */
      }
    };
  },
});

export default NdomoPlugin;
