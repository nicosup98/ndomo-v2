/**
 * ndomo — plan_create custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import crypto from "node:crypto";
import { tool } from "@opencode-ai/plugin";
import type { PlanMetadata } from "ndomo/db";
import { closeDb, createPlan, openDb, runMigrations } from "ndomo/db";

export default tool({
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
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const typedMeta = (args.metadata ?? {}) as PlanMetadata;
      const plan = createPlan(db, {
        id: crypto.randomUUID(),
        slug: args.slug,
        title: args.title,
        status: "draft" as const,
        priority: args.priority ?? 0,
        approvedAt: null,
        completedAt: null,
        sessionId: args.sessionId ?? null,
        overview: args.overview,
        approach: args.approach ?? null,
        complexity: args.complexity ?? 3,
        createdBy: ctx.agent ?? "unknown",
        updatedBy: ctx.agent ?? "unknown",
        sourceSessionId: ctx.sessionID,
        sourceMessageId: ctx.messageID,
        category: typedMeta.category ?? null,
        metadata: typedMeta,
        archivedAt: null,
      });
      return JSON.stringify(plan);
    } finally {
      closeDb(db);
    }
  },
});
