/**
 * ndomo — analysis_link_plan custom tool.
 *
 * Link an existing analysis to a source plan (set source_plan_id).
 * Pass null to unlink.
 */

import { tool } from "@opencode-ai/plugin";
import {
  closeDb,
  linkAnalysisToPlan,
  openDb,
  resolveProjectDir,
  runMigrations,
  unlinkAnalysisFromPlan,
} from "ndomo/db";

export default tool({
  description:
    "Link an existing analysis to a source plan (set source_plan_id). Pass null to unlink.",
  args: {
    id: tool.schema.string(),
    planId: tool.schema.string().nullable(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      if (args.planId === null) {
        const result = unlinkAnalysisFromPlan(db, args.id);
        return JSON.stringify({ ok: true, id: result.id, sourcePlanId: null }, null, 2);
      }
      const result = linkAnalysisToPlan(db, args.id, args.planId);
      return JSON.stringify(
        { ok: true, id: result.id, sourcePlanId: result.sourcePlanId },
        null,
        2,
      );
    } finally {
      closeDb(db);
    }
  },
});
