/**
 * ndomo — plan_search custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import { closeDb, openDb, runMigrations, searchPlans } from "ndomo/db";

export default tool({
  description:
    "Full-text search over plan titles, overviews, and approaches using SQLite FTS5.",
  args: {
    query: tool.schema.string(),
    limit: tool.schema.number().optional(),
    includeArchived: tool.schema.boolean().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      return JSON.stringify(
        searchPlans(db, args.query, args.limit ?? 20, {
          includeArchived: args.includeArchived ?? false,
        }),
      );
    } finally {
      closeDb(db);
    }
  },
});
