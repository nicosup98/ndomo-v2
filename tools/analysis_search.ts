/**
 * ndomo — analysis_search custom tool.
 *
 * Full-text search over analyses (title + summary + findings) using FTS5.
 * Returns matching analyses.
 */

import { tool } from "@opencode-ai/plugin";
import { closeDb, openDb, resolveProjectDir, runMigrations, searchAnalyses } from "ndomo/db";

export default tool({
  description:
    "Full-text search over analyses (title + summary + findings) using FTS5. Returns matching analyses.",
  args: {
    query: tool.schema.string(),
    limit: tool.schema.number().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const opts: { limit?: number } = {};
      if (args.limit !== undefined) opts.limit = args.limit;

      const results = searchAnalyses(db, args.query, opts);
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
