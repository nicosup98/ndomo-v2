/**
 * ndomo — plan_update_status custom tool.
 *
 * Mirror of the equivalent plugin tool in src/plugin.ts, exposed as a
 * standalone OpenCode custom tool. Opens its own DB connection and runs
 * migrations on first use. Use this when you want DB access from outside
 * the plugin (e.g. from agents that don't load the plugin).
 *
 * Special: also auto-archives to markdown on terminal statuses.
 */

import { tool } from "@opencode-ai/plugin";
import { archivePlan, closeDb, openDb, resolveArchiveDir, runMigrations, updatePlanStatus } from "ndomo/db";
import type { ArchiveResult, PlanStatus } from "ndomo/db";

export default tool({
  description:
    "Update a plan's status (draft, approved, executing, completed, failed, abandoned). Auto-archives to markdown on terminal status.",
  args: {
    id: tool.schema.string(),
    status: tool.schema.enum([
      "draft",
      "approved",
      "executing",
      "completed",
      "failed",
      "abandoned",
    ]),
  },
  execute: async (args, ctx) => {
    const projectDir = ctx.worktree || ctx.directory;
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      const updated = updatePlanStatus(db, args.id, args.status as PlanStatus, {
        sessionId: ctx.sessionID,
        updatedBy: ctx.agent ?? "unknown",
      });

      // Auto-archive on terminal status
      const TERMINAL_STATUSES = new Set(["completed", "failed", "abandoned"]);
      let archiveResult: ArchiveResult | null = null;
      let archiveError: string | null = null;

      if (updated && TERMINAL_STATUSES.has(args.status)) {
        try {
          archiveResult = archivePlan(db, updated.id, { memDir: resolveArchiveDir(projectDir) });
        } catch (err) {
          archiveError = err instanceof Error ? err.message : String(err);
          console.warn(`[ndomo] auto-archive failed for plan ${updated.id}: ${archiveError}`);
        }
      }

      return JSON.stringify({
        plan: updated,
        archived: archiveResult,
        archiveError,
      });
    } finally {
      closeDb(db);
    }
  },
});
