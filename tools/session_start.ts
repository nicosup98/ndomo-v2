/**
 * ndomo — session_start custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 */

import { tool } from "@opencode-ai/plugin";
import type { SessionMetadata } from "ndomo/db";
import { closeDb, openDb, runMigrations, startSession } from "ndomo/db";

export default tool({
  description:
    "Start a new ndomo session with a goal. Sessions track continuity across multiple agents.",
  args: {
    id: tool.schema.string(),
    goal: tool.schema.string(),
    planId: tool.schema.string().optional(),
    metadata: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const typedMeta = (args.metadata ?? {}) as SessionMetadata;
      return JSON.stringify(
        startSession(db, {
          id: args.id,
          goal: args.goal,
          ...(args.planId !== undefined && { planId: args.planId }),
          metadata: typedMeta,
          createdBy: ctx.agent ?? "unknown",
          sourceMessageId: ctx.messageID,
        }),
      );
    } finally {
      closeDb(db);
    }
  },
});
