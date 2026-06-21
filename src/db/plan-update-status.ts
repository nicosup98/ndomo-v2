/**
 * ndomo DB — plan_update_status tool executor (T3.1).
 *
 * Pure function extracted from the MCP tool wrapper in src/plugin.ts
 * to enable unit testing without spinning up the full MCP harness.
 *
 * Adds: readiness checks (blockers/warnings), atomic transaction,
 * dryRun, force with plan_audit capture.
 */

import type { Database } from "bun:sqlite";
import type { ArchiveResult } from "./plan-archive.ts";
import { archivePlan } from "./plan-archive.ts";
import { getPlan, updatePlanStatus } from "./plans.ts";
import type { Plan, PlanStatus } from "./types.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlanUpdateStatusArgs {
  id: string;
  status: PlanStatus;
  dryRun?: boolean;
  force?: boolean;
  forceReason?: string;
}

export interface PlanUpdateStatusContext {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
}

export interface PlanUpdateStatusResult {
  plan: Plan | null;
  statusChanged: boolean;
  blocked: boolean;
  forced: boolean;
  dryRun: boolean;
  blockers: string[];
  warnings: string[];
  archived: ArchiveResult | null;
  archiveError: string | null;
  auditId: number | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set<PlanStatus>(["completed", "failed", "abandoned"]);

const VALID_TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  draft: ["approved", "abandoned"],
  approved: ["executing", "abandoned"],
  executing: ["completed", "failed", "abandoned"],
  completed: [],
  failed: [],
  abandoned: [],
};

// ─── Executor ───────────────────────────────────────────────────────────────

/**
 * Execute plan_update_status with readiness checks, dryRun, force, and
 * atomic transaction wrapping updatePlanStatus + archivePlan.
 *
 * @param db - Database instance
 * @param args - Tool args (id, status, dryRun?, force?, forceReason?)
 * @param ctx - Tool context (agent, sessionID, directory, worktree)
 * @param archiveDir - Resolved archive directory for markdown output
 */
export function planUpdateStatusExecutor(
  db: Database,
  args: PlanUpdateStatusArgs,
  ctx: PlanUpdateStatusContext,
  archiveDir: string,
): PlanUpdateStatusResult {
  // ── 1. Load current plan ────────────────────────────────────────────────
  const currentPlan = getPlan(db, args.id);
  if (!currentPlan) {
    throw new Error(`ndomo: plan not found: ${args.id}`);
  }
  const currentStatus = currentPlan.status;

  // ── 2. Compute readiness check ─────────────────────────────────────────
  const blockers: string[] = [];
  const warnings: string[] = [];

  // tasks_pending
  const pendingCount = (
    db
      .query(
        "SELECT COUNT(*) as cnt FROM plan_tasks WHERE plan_id = ? AND status = 'pending' AND archived_at IS NULL",
      )
      .get(args.id) as { cnt: number }
  ).cnt;
  if (pendingCount > 0) blockers.push("tasks_pending");

  // tasks_running
  const runningCount = (
    db
      .query(
        "SELECT COUNT(*) as cnt FROM plan_tasks WHERE plan_id = ? AND status = 'running' AND archived_at IS NULL",
      )
      .get(args.id) as { cnt: number }
  ).cnt;
  if (runningCount > 0) blockers.push("tasks_running");

  // sessions_open
  const openSessionsCount = (
    db
      .query(
        "SELECT COUNT(*) as cnt FROM sessions WHERE plan_id = ? AND ended_at IS NULL AND archived_at IS NULL",
      )
      .get(args.id) as { cnt: number }
  ).cnt;
  if (openSessionsCount > 0) blockers.push("sessions_open");

  // status_invalid — always a blocker (force cannot bypass)
  const allowed = VALID_TRANSITIONS[currentStatus] ?? [];
  if (args.status !== currentStatus && !allowed.includes(args.status)) {
    blockers.push("status_invalid");
  }

  // orphan_plan — warning only
  const totalTasks = (
    db
      .query(
        "SELECT COUNT(*) as cnt FROM plan_tasks WHERE plan_id = ? AND archived_at IS NULL",
      )
      .get(args.id) as { cnt: number }
  ).cnt;
  if (totalTasks === 0) warnings.push("orphan_plan");

  // executing→failed: downgrade blockers to warnings (except status_invalid)
  const isExecutingToFailed = currentStatus === "executing" && args.status === "failed";
  const hardBlockers = isExecutingToFailed
    ? blockers.filter((b) => b === "status_invalid")
    : blockers;
  if (isExecutingToFailed) {
    // Move non-status_invalid blockers to warnings
    for (const b of blockers) {
      if (b !== "status_invalid" && !warnings.includes(b)) {
        warnings.push(b);
      }
    }
  }

  // status_invalid is always a hard blocker — force cannot bypass it
  if (hardBlockers.includes("status_invalid")) {
    return {
      plan: currentPlan,
      statusChanged: false,
      blocked: true,
      forced: false,
      dryRun: false,
      blockers: hardBlockers,
      warnings,
      archived: null,
      archiveError: null,
      auditId: null,
    };
  }

  // ── 3. dryRun — return check results, no mutation ──────────────────────
  if (args.dryRun) {
    return {
      plan: currentPlan,
      statusChanged: false,
      blocked: hardBlockers.length > 0,
      forced: false,
      dryRun: true,
      blockers: hardBlockers,
      warnings,
      archived: null,
      archiveError: null,
      auditId: null,
    };
  }

  // ── 4. Blockers without force ──────────────────────────────────────────
  if (hardBlockers.length > 0 && !args.force) {
    return {
      plan: currentPlan,
      statusChanged: false,
      blocked: true,
      forced: false,
      dryRun: false,
      blockers: hardBlockers,
      warnings,
      archived: null,
      archiveError: null,
      auditId: null,
    };
  }

  // ── 5. force=true validation ───────────────────────────────────────────
  if (args.force && (!args.forceReason || args.forceReason.trim() === "")) {
    throw new Error("ndomo: force=true requires non-empty forceReason");
  }

  // ── 6. Atomic transaction: readiness check → audit → update → archive ─
  const opts: {
    sessionId?: string;
    updatedBy: string;
    executedByAgent?: string;
    executedBySession?: string;
  } = {
    updatedBy: ctx.agent ?? "unknown",
  };
  if (ctx.sessionID) opts.sessionId = ctx.sessionID;
  if (args.status === "executing") {
    opts.executedByAgent = ctx.agent ?? "unknown";
    if (ctx.sessionID) opts.executedBySession = ctx.sessionID;
  }

  const txn = db.transaction(() => {
    // Re-check status inside transaction (another writer could have changed it)
    const freshPlan = getPlan(db, args.id);
    if (!freshPlan) {
      throw new Error(`ndomo: plan not found during transaction: ${args.id}`);
    }

    // Re-validate status transition inside transaction
    const freshAllowed = VALID_TRANSITIONS[freshPlan.status] ?? [];
    if (args.status !== freshPlan.status && !freshAllowed.includes(args.status)) {
      throw new Error(
        `ndomo: invalid status transition '${freshPlan.status}' → '${args.status}'`,
      );
    }

    // Force audit insert
    let auditRowId: number | null = null;
    if (args.force) {
      const snapshot = JSON.stringify({
        reason: args.forceReason,
        forcedBy: ctx.agent ?? "unknown",
        blockers: hardBlockers,
        warnings,
        previousStatus: currentStatus,
      });
      const result = db
        .query(
          "INSERT INTO plan_audit (plan_id, captured_at, snapshot, trigger) VALUES (?, ?, ?, 'force_close')",
        )
        .run(args.id, Date.now(), snapshot);
      auditRowId = Number(result.lastInsertRowid);
    }

    // Update status (idempotent same-status is a no-op warning)
    const updated = updatePlanStatus(db, args.id, args.status, opts);

    // Auto-archive on terminal status
    let archiveResult: ArchiveResult | null = null;
    let archiveError: string | null = null;

    if (updated && TERMINAL_STATUSES.has(args.status)) {
      try {
        archiveResult = archivePlan(db, updated.id, { memDir: archiveDir });
      } catch (err) {
        archiveError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[ndomo] auto-archive failed for plan ${updated.id}: ${archiveError}`,
        );
        // Re-throw so the outer transaction rolls back (atomicity)
        throw err;
      }
    }

    return { updated, archiveResult, archiveError, auditRowId };
  });

  const { updated, archiveResult, archiveError, auditRowId } = txn();

  return {
    plan: updated,
    statusChanged: updated?.status === args.status,
    blocked: false,
    forced: !!args.force,
    dryRun: false,
    blockers: hardBlockers,
    warnings,
    archived: archiveResult,
    archiveError,
    auditId: auditRowId,
  };
}
