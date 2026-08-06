/**
 * ndomo — task_update_status custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import type { TaskStatus } from "ndomo/db";
import { closeDb, openDb, resolveProjectDir, runMigrations, updateTaskStatus } from "ndomo/db";

export default tool({
  description:
    "Update a task's status. Optionally record result or error text. When transitioning to 'done' on a verification-gated task, pass force=true with a non-blank forceReason to waive the gate (v17/T1).",
  args: {
    id: tool.schema.string(),
    status: tool.schema.enum(["pending", "running", "done", "failed", "blocked"]),
    result: tool.schema.string().optional(),
    error: tool.schema.string().optional(),
    /**
     * v17 (T1): force-bypass the execution gate when status='done' and the
     * task has verificationRequired=true but no passed/waived verdict.
     * Requires a non-blank forceReason — recorded in metadata.verificationBypass.
     */
    force: tool.schema.boolean().optional(),
    forceReason: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
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
      return JSON.stringify(
        updateTaskStatus(db, args.id, args.status as TaskStatus, fields, ctx.agent ?? "unknown"),
      );
    } finally {
      closeDb(db);
    }
  },
});
