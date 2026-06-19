/**
 * ndomo — task_create_batch custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import { closeDb, createTasksBatch, openDb, runMigrations } from "ndomo/db";
import type { TaskMetadata } from "ndomo/db";

export default tool({
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
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
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
    } finally {
      closeDb(db);
    }
  },
});
