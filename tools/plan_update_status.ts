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
import { archivePlan, closeDb, openDb, runMigrations, updatePlanStatus } from "ndomo/db";
import type { ArchiveResult, PlanStatus } from "ndomo/db";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Reimplementation of the plugin's internal getMemDir, hardened against path traversal. */
function getMemDir(): string {
  const configPath = join(homedir(), ".config", "opencode", "ndomo.json");
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      const storagePath = parsed?.mem?.storagePath;
      if (storagePath && typeof storagePath === "string") {
        const expanded = storagePath.replace(/^~/, homedir());
        const resolved = resolve(expanded);
        const home = homedir();
        if (resolved !== home && !resolved.startsWith(home + sep)) {
          throw new Error(
            `[ndomo] mem.storagePath resolves outside $HOME — refusing to use: ${resolved} (raw: ${storagePath})`,
          );
        }
        return join(resolved, "plans");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("refusing to use")) {
      throw error; // rethrow path-traversal rejection
    }
    // fall through to default for parse/read errors
  }
  return join(homedir(), ".ndomo", "mem", "plans");
}

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
          archiveResult = archivePlan(db, updated.id, { memDir: getMemDir() });
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
