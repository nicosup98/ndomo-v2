/**
 * ndomo — analysis_archive custom tool.
 *
 * Soft-delete an analysis by setting archived_at. Idempotent.
 * The row is preserved but excluded from default list queries.
 */

import { tool } from "@opencode-ai/plugin";
import { archiveAnalysis, closeDb, openDb, resolveProjectDir, runMigrations } from "ndomo/db";

export default tool({
  description:
    "Soft-delete an analysis by setting archived_at. Idempotent. The row is preserved but excluded from default list queries.",
  args: {
    id: tool.schema.string(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const result = archiveAnalysis(db, args.id);
      return JSON.stringify({ ok: true, id: result.id, archivedAt: result.archivedAt }, null, 2);
    } finally {
      closeDb(db);
    }
  },
});
