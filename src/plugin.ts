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
import { openDb } from "./db/client.ts";
import { runMigrations } from "./db/migrations.ts";
import type { ArchiveResult } from "./db/plan-archive.ts";
import { archivePlan, resolveArchiveDir } from "./db/plan-archive.ts";
import { planCreateExecutor } from "./db/plan-create.ts";
import {
  approvePlan,
  getPlan,
  getPlanBySlug,
  listPlans,
  searchPlans,
  updatePlanStatus,
} from "./db/plans.ts";
import { checkpointSession, endSession, listSessions, startSession } from "./db/sessions.ts";
import { registerShutdownHandlers } from "./db/shutdown.ts";
import {
  createTasksBatch,
  listTasksByPlan,
  nextTaskForAgent,
  searchTasks,
  updateTaskStatus,
} from "./db/tasks.ts";
import type { PlanStatus, SessionMetadata, TaskMetadata, TaskStatus } from "./db/types.ts";
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
import type { RoutingDecision } from "./lib.ts";

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
  const dispatcher = new BackgroundDispatcher();
  const db: Database = openDb(worktree || directory);
  runMigrations(db);
  registerShutdownHandlers(db);

  /** filepath → `${sessionID}:${callID}` of the task that locked it. */
  const activeWrites = new Map<string, string>();

  // ─── Hooks ───────────────────────────────────────────────────────────────

  const hooks: Hooks = {
    // (a) Inject orchestrator state into session compaction context
    "experimental.session.compacting": async (_input, output) => {
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
        const sessionId = (_input as { sessionID?: string }).sessionID ?? "";
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

      const args = output.args as Record<string, unknown> | undefined;
      const filepath =
        (args?.filePath as string | undefined) ?? (args?.filepath as string | undefined);
      if (!filepath) return;

      const key = `${input.sessionID}:${input.callID}`;
      const existing = activeWrites.get(filepath);
      if (existing !== undefined && existing !== key) {
        throw new Error(`ndomo: file locked by active task ${existing}`);
      }
      activeWrites.set(filepath, key);
    },

    // (c) Remove filepath from activeWrites after tool completes
    "tool.execute.after": async (input) => {
      if (input.tool !== "write" && input.tool !== "edit") return;

      const args = input.args as Record<string, unknown> | undefined;
      const filepath =
        (args?.filePath as string | undefined) ?? (args?.filepath as string | undefined);
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
        },
        execute: async (args, ctx) => {
          return JSON.stringify(planCreateExecutor(db, args, ctx));
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
          const plan = args.id ? getPlan(db, args.id) : getPlanBySlug(db, args.slug as string);
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

      plan_update_status: tool({
        description:
          "Update a plan's status (draft, approved, executing, completed, failed, abandoned). Auto-archives to markdown on terminal status.",
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
        },
        execute: async (args, ctx) => {
          const updated = updatePlanStatus(db, args.id, args.status as PlanStatus, {
            sessionId: ctx.sessionID,
            updatedBy: ctx.agent ?? "unknown",
          });

          // Auto-archive on terminal status
          const TERMINAL_STATUSES = new Set(["completed", "failed", "abandoned"]);
          let archiveResult: ArchiveResult | null = null;
          let archiveError: string | null = null;

          if (updated && TERMINAL_STATUSES.has(args.status)) {
            try {
              archiveResult = archivePlan(db, updated.id, { memDir: resolveArchiveDir(worktree || directory) });
            } catch (err) {
              archiveError = err instanceof Error ? err.message : String(err);
              console.warn(`[ndomo] auto-archive failed for plan ${updated.id}: ${archiveError}`);
            }
          }

          return JSON.stringify({
            plan: updated,
            archived: archiveResult,
            archiveError,
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
            args.tasks.map((t, idx) => {
              const typedMeta = (t.metadata ?? {}) as TaskMetadata;
              return {
                orderIndex: idx,
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
        description: "List tasks for a plan, optionally filtered by status.",
        args: {
          planId: tool.schema.string(),
          status: tool.schema.enum(["pending", "running", "done", "failed", "blocked"]).optional(),
        },
        execute: async (args) => {
          const opts: { status?: TaskStatus } = {};
          if (args.status) opts.status = args.status as TaskStatus;
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
          return JSON.stringify(
            updateTaskStatus(
              db,
              args.id,
              args.status as TaskStatus,
              fields,
              ctx.agent ?? "unknown",
            ),
          );
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
        description: "Mark a session as ended. Sets ended_at to the current timestamp.",
        args: { id: tool.schema.string() },
        execute: async (args) => {
          return JSON.stringify(endSession(db, args.id));
        },
      }),
    },
  };

  return hooks;
};
export default NdomoPlugin;
