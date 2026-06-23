/**
 * ndomo — analysis_get custom tool.
 *
 * Get a single analysis by id. Returns the analysis with parsed findingsJson.
 */

import { tool } from "@opencode-ai/plugin";
import { closeDb, getAnalysis, openDb, resolveProjectDir, runMigrations } from "ndomo/db";

export default tool({
  description: "Get a single analysis by id. Returns the analysis with parsed findingsJson.",
  args: {
    id: tool.schema.string(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const result = getAnalysis(db, args.id);
      if (!result) {
        throw new Error(`ndomo: analysis '${args.id}' not found`);
      }
      return JSON.stringify(
        { ...result, findingsJson: JSON.parse(result.findingsJson) },
        null,
        2,
      );
    } finally {
      closeDb(db);
    }
  },
});
