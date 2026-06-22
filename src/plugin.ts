/**
 * ndomo — OpenCode plugin implementation.
 *
 * Wraps ndomo's orchestrator, worktree, and memory libraries as
 * OpenCode hooks and tools. All state lives in closures created
 * when the plugin is instantiated — no module-level globals.
 *
 * Dependency: `@opencode-ai/plugin` lives in `.opencode/package.json`
 * per OpenCode plugin convention (installed alongside the user's
 * `config/ndomo.config.json`).
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { AutoCheckpointDispatcher } from "./db/auto-checkpoint.ts";
import { openDb } from "./db/client.ts";
import { createIncident } from "./db/incidents.ts";
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
  resolveTaskDependencies,
  searchTasks,
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

// ─── Escalation helper (M2) ──────────────────────────────────────────────────

/**
 * Escalate a task from craftsman to foreman by creating a stub plan
 * and optionally a foreman task, then checkpointing the session.
 *
 * Pure function taking `db` — testable via in-memory SQLite.
 */
export function escalateToForeman(
  db: Database,
  ctx: { agent?: string; sessionID?: string; messageID?: string },
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

export const NdomoPlugin: Plugin = async (
  input: PluginInput,
  options?: Record<string, unknown>,
): Promise<Hooks> => {
  const { directory, worktree } = input;
  const opts = (options ?? {}) as NdomoPluginOptions;

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

  // Shared state — lives for the lifetime of the plugin instance
  const db: Database = openDb(resolveProjectDir({ worktree, directory }));
  runMigrations(db);
  registerShutdownHandlers(db);
  const dispatcher = new BackgroundDispatcher(db);

  /** filepath → `${sessionID}:${callID}` of the task that locked it. */
  const activeWrites = new Map<string, string>();

  // Auto-checkpoint dispatcher (T3.3)
  const autoCheckpoint = new AutoCheckpointDispatcher(db, ndomoConfig?.autoCheckpoint);

  // ─── Hooks ───────────────────────────────────────────────────────────────

  const hooks: Hooks = {
    // (a) Inject orchestrator state into session compaction context
    "experimental.session.compacting": async (input, output) => {
      const count = dispatcher.getActive().length;
      const paths = Array.from(activeWrites.keys()).join(", ");
      output.context.push(
        [
          "",
          "## ndomo orchestrator state",
          `- Active tasks: ${count}`,
          `- Active writes: ${paths || "(none)"}`,
          `- Project: ${worktree || directory}`,
          "",
        ].join("\n"),
      );

      // Enrich compaction context with DB state
      try {
        const sessionId = input.sessionID ?? "";
        if (sessionId) {
          const activePlans = listPlans(db, { sessionId }).filter(
            (p) => p.status === "approved" || p.status === "executing",
          );
          if (activePlans.length > 0) {
            output.context.push(
              `\n## ndomo active plans\n${JSON.stringify(
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
            );
          }
        }
        const recentSessions = listSessions(db, { limit: 3 });
        if (recentSessions.length > 0) {
          output.context.push(
            `\n## ndomo recent sessions\n${JSON.stringify(
              recentSessions.map((s) => ({
                id: s.id,
                goal: s.goal.slice(0, 100),
                endedAt: s.endedAt,
                keyDecisions: s.keyDecisions?.slice(0, 200) ?? null,
              })),
              null,
              2,
            )}`,
          );
        }
      } catch (err) {
        // DB errors should not break compaction
        console.log("ndomo: compaction DB enrichment failed", (err as Error).message);
      }
    },

    // (b) Enforce no-overlap rule for write/edit tools
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "write" && input.tool !== "edit") return;

      const filepath = extractFilePath(output.args);
      if (!filepath) return;

      const key = `${input.sessionID}:${input.callID}`;
      const existing = activeWrites.get(filepath);
      if (existing != null && existing !== key) {
        throw new Error(`ndomo: file locked by active task ${existing}`);
      }
      activeWrites.set(filepath, key);
    },

    // (c) Remove filepath from activeWrites after tool completes
    "tool.execute.after": async (input) => {
      if (input.tool !== "write" && input.tool !== "edit") return;

      const filepath = extractFilePath(input.args);
      if (filepath) {
        activeWrites.delete(filepath);
      }
    },

    // (d) Note: `file.edited` hook is NOT present in @opencode-ai/plugin v1.17.7.
    //     The SDK's Hooks type does not include it. Logging file events must be
    //     handled via a different mechanism (e.g. tool.execute.after filtering).

    // (e) Inject ndomo env vars into shell sessions
    "shell.env": async (_input, output) => {
      output.env.NDOMO_PRESET = opts.preset ?? "default";
      output.env.NDOMO_PROJECT = worktree || directory;
    },

    // ─── Tools ───────────────────────────────────────────────────────────

    tool: {
      // ── Routing ────────────────────────────────────────────────────────

      route: tool({
        description: "Route a task to the appropriate specialist agent.",
        args: {
          description: tool.schema.string(),
          type: tool.schema.enum([
            "implement",
            "explore",
            "research",
            "design",
            "debug",
            "audit",
            "document",
            "debate",
          ]),
          stack: tool.schema
            .enum(["go", "vue", "js", "python", "zig", "generic", "unknown"])
            .optional(),
          risk: tool.schema.enum(["low", "medium", "high"]).optional(),
          files: tool.schema.array(tool.schema.string()).optional(),
        },
        execute: async (args) => {
          const decision = routeTask({
            description: args.description,
            type: args.type,
            stack: args.stack ?? "unknown",
            risk: args.risk ?? "low",
            files: args.files ?? [],
          });
          return JSON.stringify(decision);
        },
      }),

      can_parallel: tool({
        description: "Check whether a set of routing decisions can run in parallel.",
        args: {
          tasks: tool.schema.string(),
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
          agent: tool.schema.string(),
          description: tool.schema.string(),
          files: tool.schema.array(tool.schema.string()).optional(),
          worktree: tool.schema.string().optional(),
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
        args: { taskId: tool.schema.string() },
        execute: async (args) => {
          const task = dispatcher.getStatus(args.taskId);
          if (!task) throw new Error(`ndomo: background task ${args.taskId} not found`);
          return JSON.stringify(task);
        },
      }),

      background_task_cancel: tool({
        description:
          "Cancel a pending or running background task. Returns true if cancelled, false if task was already terminal.",
        args: { taskId: tool.schema.string() },
        execute: async (args) => {
          const cancelled = dispatcher.cancel(args.taskId);
          return JSON.stringify({ taskId: args.taskId, cancelled });
        },
      }),

      // ── Worktrees ──────────────────────────────────────────────────────

      worktree_create: tool({
        description: "Create a new git worktree for isolated coding.",
        args: {
          slug: tool.schema.string(),
          branch: tool.schema.string(),
          agent: tool.schema.string().optional(),
          description: tool.schema.string().optional(),
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
          slug: tool.schema.string(),
          abandon: tool.schema.boolean().optional(),
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
          query: tool.schema.string(),
          scope: tool.schema.enum(["project", "all-projects"]).optional(),
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
          text: tool.schema.string(),
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
          slug: tool.schema.string(),
          title: tool.schema.string(),
          overview: tool.schema.string(),
          approach: tool.schema.string().optional(),
          priority: tool.schema.number().optional(),
          complexity: tool.schema.number().int().min(1).max(5).optional(),
          sessionId: tool.schema.string().optional(),
          metadata: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
          files: tool.schema.array(tool.schema.string()).optional(),
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
          id: tool.schema.string().optional(),
          slug: tool.schema.string().optional(),
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
          status: tool.schema
            .enum(["draft", "approved", "executing", "completed", "failed", "abandoned"])
            .optional(),
          sessionId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
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
          query: tool.schema.string(),
          limit: tool.schema.number().optional(),
          includeArchived: tool.schema.boolean().optional(),
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
        args: { id: tool.schema.string() },
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
          id: tool.schema.string(),
          confirm: tool.schema.boolean(),
        },
        execute: async (args) => {
          return JSON.stringify(deletePlan(db, args.id, { confirm: args.confirm }));
        },
      }),

      plan_update_status: tool({
        description:
          "Update a plan's status (draft, approved, executing, completed, failed, abandoned). Auto-archives to markdown on terminal status. Use dryRun=true to pre-check readiness (blockers/warnings) without mutating. Use force=true with forceReason to bypass blockers (except status_invalid) — captured to plan_audit.",
        args: {
          id: tool.schema.string(),
          status: tool.schema.enum([
            "draft",
            "approved",
            "executing",
            "completed",
            "failed",
            "abandoned",
          ]),
          dryRun: tool.schema.boolean().optional(),
          force: tool.schema.boolean().optional(),
          forceReason: tool.schema.string().optional(),
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
          planId: tool.schema.string().optional(),
          owner: tool.schema.string().optional(),
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
          planId: tool.schema.string(),
          files: tool.schema.array(
            tool.schema.object({
              filePath: tool.schema.string(),
              role: tool.schema.string(),
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
          "Create multiple tasks for a plan in a single transaction. Each task gets a UUID and sequential order_index.",
        args: {
          planId: tool.schema.string(),
          tasks: tool.schema.array(
            tool.schema.object({
              description: tool.schema.string(),
              agent: tool.schema.string(),
              files: tool.schema.array(tool.schema.string()).optional(),
              complexity: tool.schema.number().int().min(1).max(5).optional(),
              dependencies: tool.schema.array(tool.schema.string()).optional(),
              metadata: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
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
            args.tasks.map((t) => {
              const typedMeta = (t.metadata ?? {}) as TaskMetadata;
              return {
                // orderIndex intentionally omitted — createTasksBatch allocates
                // dynamically via SELECT MAX+1 to avoid UNIQUE constraint collisions
                // on retries/splits. Caller-provided idx was the root cause of the
                // UNIQUE constraint bug (plan ca69222a).
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
              };
            }),
          );
          return JSON.stringify(tasks);
        },
      }),

      task_list: tool({
        description:
          "List tasks for a plan, optionally filtered by status. Set includeArchived=true to include tasks from archived plans (archived_at IS NOT NULL).",
        args: {
          planId: tool.schema.string(),
          status: tool.schema.enum(["pending", "running", "done", "failed", "blocked"]).optional(),
          includeArchived: tool.schema.boolean().optional(),
        },
        execute: async (args) => {
          const opts: { status?: TaskStatus; includeArchived?: boolean } = {};
          if (args.status) opts.status = args.status as TaskStatus;
          if (args.includeArchived) opts.includeArchived = true;
          return JSON.stringify(listTasksByPlan(db, args.planId, opts));
        },
      }),

      task_update_status: tool({
        description: "Update a task's status. Optionally record result or error text.",
        args: {
          id: tool.schema.string(),
          status: tool.schema.enum(["pending", "running", "done", "failed", "blocked"]),
          result: tool.schema.string().optional(),
          error: tool.schema.string().optional(),
        },
        execute: async (args, ctx) => {
          const fields: { result?: string; error?: string } = {};
          if (args.result !== undefined) fields.result = args.result;
          if (args.error !== undefined) fields.error = args.error;
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

      task_search: tool({
        description:
          "Full-text search over task descriptions, results, and errors using SQLite FTS5.",
        args: {
          query: tool.schema.string(),
          limit: tool.schema.number().optional(),
          includeArchived: tool.schema.boolean().optional(),
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
          agent: tool.schema.string(),
          planId: tool.schema.string().optional(),
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
          taskId: tool.schema.string().optional(),
          planId: tool.schema.string().optional(),
          orderIndex: tool.schema.number().optional(),
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
          agent: tool.schema.string(),
          planId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
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
          taskId: tool.schema.string(),
          artifact: tool.schema.string(),
          role: tool.schema.string().optional(),
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
          taskId: tool.schema.string(),
          reviewedBy: tool.schema.string(),
          verdict: tool.schema.string(),
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
          title: tool.schema.string(),
          severity: tool.schema.enum(["sev1", "sev2", "sev3", "sev4"]),
          summary: tool.schema.string().optional(),
          triggeredByDeploymentId: tool.schema.string().optional(),
          metadata: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
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
          deploymentId: tool.schema.string(),
          plan: tool.schema.string(),
          incidentId: tool.schema.string().optional(),
          status: tool.schema
            .enum(["planned", "approved", "dry_run", "executing", "success", "failed", "cancelled"])
            .optional(),
          newDeploymentId: tool.schema.string().optional(),
          metadata: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
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
          sourcePlanId: tool.schema.string().optional(),
          sourceTaskId: tool.schema.string().optional(),
          reason: tool.schema.string(),
          suggestedApproach: tool.schema.string().optional(),
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
          return JSON.stringify(escalateToForeman(db, ctx, escalateArgs));
        },
      }),

      // ── Sessions ───────────────────────────────────────────────────

      session_start: tool({
        description:
          "Start a new ndomo session with a goal. Sessions track continuity across multiple agents.",
        args: {
          id: tool.schema.string(),
          goal: tool.schema.string(),
          planId: tool.schema.string().optional(),
          metadata: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
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
          id: tool.schema.string(),
          state: tool.schema.record(tool.schema.string(), tool.schema.unknown()),
          keyDecisions: tool.schema.string().optional(),
        },
        execute: async (args) => {
          return JSON.stringify(checkpointSession(db, args.id, args.state, args.keyDecisions));
        },
      }),

      session_end: tool({
        description:
          "Mark a session as ended. Sets ended_at. Reconciliación: planes con status='executing' o 'approved' sin cerrar en esta session → 'abandoned' con metadata.reason='session_ended'.",
        args: { id: tool.schema.string() },
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
    },
  };

  return hooks;
};
export default NdomoPlugin;
