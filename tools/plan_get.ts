/**
 * ndomo — plan_get custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import { closeDb, getPlan, getPlanBySlug, openDb, runMigrations } from "ndomo/db";

export default tool({
  description: "Get a plan by ID or slug.",
  args: {
    id: tool.schema.string().optional(),
    slug: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    if (!args.id && !args.slug) {
      throw new Error("ndomo: plan_get requires id or slug");
    }
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const plan = args.id ? getPlan(db, args.id) : getPlanBySlug(db, args.slug as string);
      return JSON.stringify(plan);
    } finally {
      closeDb(db);
    }
  },
});
