/**
 * ndomo — plan_list custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import type { PlanStatus } from "ndomo/db";
import { closeDb, listPlans, openDb, runMigrations } from "ndomo/db";

export default tool({
  description: "List plans, optionally filtered by status and session.",
  args: {
    status: tool.schema
      .enum(["draft", "approved", "executing", "completed", "failed", "abandoned"])
      .optional(),
    sessionId: tool.schema.string().optional(),
    limit: tool.schema.number().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const opts: { status?: PlanStatus; sessionId?: string; limit?: number } = {};
      if (args.status) opts.status = args.status;
      if (args.sessionId) opts.sessionId = args.sessionId;
      if (args.limit !== undefined) opts.limit = args.limit;
      return JSON.stringify(listPlans(db, opts));
    } finally {
      closeDb(db);
    }
  },
});
