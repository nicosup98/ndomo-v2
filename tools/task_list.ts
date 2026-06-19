/**
 * ndomo — task_list custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import { closeDb, listTasksByPlan, openDb, runMigrations } from "ndomo/db";
import type { TaskStatus } from "ndomo/db";

export default tool({
  description: "List tasks for a plan, optionally filtered by status.",
  args: {
    planId: tool.schema.string(),
    status: tool.schema.enum(["pending", "running", "done", "failed", "blocked"]).optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const opts: { status?: TaskStatus } = {};
      if (args.status) opts.status = args.status as TaskStatus;
      return JSON.stringify(listTasksByPlan(db, args.planId, opts));
    } finally {
      closeDb(db);
    }
  },
});
