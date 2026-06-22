/**
 * ndomo — plan_approve custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import { approvePlan, closeDb, openDb, resolveProjectDir, runMigrations } from "ndomo/db";

export default tool({
  description: "Mark a plan as approved. Sets approved_at to the current timestamp.",
  args: { id: tool.schema.string() },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      return JSON.stringify(
        approvePlan(db, args.id, {
          sessionId: ctx.sessionID,
          updatedBy: ctx.agent ?? "unknown",
        }),
      );
    } finally {
      closeDb(db);
    }
  },
});
