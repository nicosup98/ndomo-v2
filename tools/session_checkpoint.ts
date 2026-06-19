/**
 * ndomo — session_checkpoint custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import { checkpointSession, closeDb, openDb, runMigrations } from "ndomo/db";

export default tool({
  description:
    "Save a checkpoint in an active session with arbitrary state and optional key decisions.",
  args: {
    id: tool.schema.string(),
    state: tool.schema.record(tool.schema.string(), tool.schema.unknown()),
    keyDecisions: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      return JSON.stringify(checkpointSession(db, args.id, args.state, args.keyDecisions));
    } finally {
      closeDb(db);
    }
  },
});
