/**
 * ndomo — analysis_list custom tool.
 *
 * List analyses with optional filters: sourcePlanId, agent, projectPath, archived, limit.
 */

import { tool } from "@opencode-ai/plugin";
import { closeDb, listAnalyses, openDb, resolveProjectDir, runMigrations } from "ndomo/db";

export default tool({
  description:
    "List analyses with optional filters: sourcePlanId, agent, projectPath, archived, limit.",
  args: {
    sourcePlanId: tool.schema.string().optional(),
    agent: tool.schema.string().optional(),
    projectPath: tool.schema.string().optional(),
    archived: tool.schema.boolean().optional(),
    limit: tool.schema.number().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const opts: {
        sourcePlanId?: string;
        agent?: string;
        projectPath?: string;
        archived?: boolean;
        limit?: number;
      } = {};
      if (args.sourcePlanId !== undefined) opts.sourcePlanId = args.sourcePlanId;
      if (args.agent !== undefined) opts.agent = args.agent;
      if (args.projectPath !== undefined) opts.projectPath = args.projectPath;
      if (args.archived !== undefined) opts.archived = args.archived;
      if (args.limit !== undefined) opts.limit = args.limit;

      const results = listAnalyses(db, opts);
      return JSON.stringify(
        results.map((r) => ({ ...r, findingsJson: JSON.parse(r.findingsJson) })),
        null,
        2,
      );
    } finally {
      closeDb(db);
    }
  },
});
