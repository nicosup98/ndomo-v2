/**
 * ndomo — task_verify custom tool (v17 / T1).
 *
 * Standalone OpenCode tool that mirrors the plugin `task_verify` tool.
 * Records an independent-verifier verdict on a task's execution gate.
 *
 * Authority model (matches agents/inspector.md):
 *   verdict='passed' → caller MUST be 'inspector' (ctx.agent), unless
 *                      force=true + non-blank forceReason are provided.
 *   verdict='failed' → any caller, REQUIRES non-blank reason (silent
 *                      rejection is forbidden).
 *   verdict='waived' → any caller, REQUIRES non-blank reason.
 *
 * Override of an existing 'passed' verdict requires force=true + forceReason.
 *
 * Opens its own DB connection and runs migrations on first use.
 */

import { tool } from "@opencode-ai/plugin";
import {
  closeDb,
  openDb,
  recordTaskVerification,
  resolveProjectDir,
  runMigrations,
} from "ndomo/db";

export default tool({
  description:
    "Record an independent-verifier verdict on a task's execution gate (v17/T1). verdict='passed' is inspector-only unless force+forceReason; 'failed'/'waived' require reason.",
  args: {
    taskId: tool.schema.string(),
    verdict: tool.schema.enum(["passed", "failed", "waived"]),
    /**
     * Optional structured payload describing what was checked. Stored as JSON
     * in the verification_result column. Example: { checks: [...], coverage: 0.9 }.
     * Accepts a JSON string OR an arbitrary object.
     */
    result: tool.schema.unknown().optional(),
    /** Human-readable justification — REQUIRED for 'failed'/'waived' verdicts. */
    reason: tool.schema.string().optional(),
    /** Force override of the inspector-only 'passed' rule, or of an existing 'passed'. */
    force: tool.schema.boolean().optional(),
    forceReason: tool.schema.string().optional(),
  },
  execute: async (args, ctx) => {
    const projectDir = resolveProjectDir(ctx);
    const db = openDb(projectDir);
    runMigrations(db);
    try {
      // result may arrive as a JSON string (from CLI / curl) or as an object.
      let resultObj: Record<string, unknown> | undefined;
      if (args.result !== undefined) {
        if (typeof args.result === "string") {
          try {
            const parsed = JSON.parse(args.result);
            resultObj =
              parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : { value: parsed };
          } catch {
            resultObj = { raw: args.result };
          }
        } else if (typeof args.result === "object" && args.result !== null) {
          resultObj = args.result as Record<string, unknown>;
        }
      }
      const updated = recordTaskVerification(
        db,
        args.taskId,
        args.verdict,
        resultObj,
        ctx.agent ?? "unknown",
        {
          force: args.force,
          forceReason: args.forceReason,
          reason: args.reason,
        },
      );
      return JSON.stringify(updated);
    } finally {
      closeDb(db);
    }
  },
});
