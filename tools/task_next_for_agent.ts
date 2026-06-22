/**
 * ndomo — task_next_for_agent custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import { closeDb, nextTaskForAgent, openDb, resolveProjectDir, runMigrations } from "ndomo/db";

export default tool({
  description: "Get the next pending task for a given agent (optionally within a specific plan).",
  args: {
    agent: tool.schema.string(),
    planId: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const opts = args.planId ? { planId: args.planId } : {};
      return JSON.stringify(nextTaskForAgent(db, args.agent, opts));
    } finally {
      closeDb(db);
    }
  },
});
