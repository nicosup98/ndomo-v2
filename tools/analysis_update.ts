/**
 * ndomo — analysis_update custom tool.
 *
 * Update an existing analysis. Only provided fields are changed. Bumps updated_at.
 */

import { tool } from "@opencode-ai/plugin";
import type { InsertAnalysis } from "ndomo/db";
import { closeDb, openDb, resolveProjectDir, runMigrations, updateAnalysis } from "ndomo/db";

export default tool({
  description: "Update an existing analysis. Only provided fields are changed. Bumps updated_at.",
  args: {
    id: tool.schema.string(),
    title: tool.schema.string().optional(),
    summary: tool.schema.string().optional(),
    findingsJson: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    // Validate findingsJson if provided
    if (args.findingsJson !== undefined) {
      try {
        JSON.parse(args.findingsJson);
      } catch {
        throw new Error("ndomo: findingsJson must be valid JSON");
      }
    }

    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const patch: Partial<InsertAnalysis> = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.summary !== undefined) patch.summary = args.summary;
      if (args.findingsJson !== undefined) patch.findingsJson = args.findingsJson;

      const result = updateAnalysis(db, args.id, patch);
      return JSON.stringify(result, null, 2);
    } finally {
      closeDb(db);
    }
  },
});
