/**
 * ndomo — task_update_status custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import { closeDb, openDb, runMigrations, updateTaskStatus } from "ndomo/db";
import type { TaskStatus } from "ndomo/db";

export default tool({
  description: "Update a task's status. Optionally record result or error text.",
  args: {
    id: tool.schema.string(),
    status: tool.schema.enum(["pending", "running", "done", "failed", "blocked"]),
    result: tool.schema.string().optional(),
    error: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const fields: { result?: string; error?: string } = {};
      if (args.result !== undefined) fields.result = args.result;
      if (args.error !== undefined) fields.error = args.error;
      return JSON.stringify(
        updateTaskStatus(db, args.id, args.status as TaskStatus, fields, ctx.agent ?? "unknown"),
      );
    } finally {
      closeDb(db);
    }
  },
});
