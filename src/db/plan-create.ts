/**
 * ndomo DB — plan_create tool executor.
 *
 * Pure function extracted from the MCP tool wrapper in src/plugin.ts
 * to enable unit testing without spinning up the full MCP harness.
 *
 * Behavior preserved verbatim from the original execute function.
 *
 * Post-commit hook: emits `plan.created` on the in-process event bus so the
 * SSE route (`src/http/routes/events.ts`) can fan out to live subscribers.
 * Emits OUTSIDE the transaction to avoid leaking unpublished state on errors.
 */

import type { Database } from "bun:sqlite";
import { bus } from "../events/bus.ts";
import { createPlan } from "./plans.ts";
import { ensureSession } from "./sessions.ts";
import type { Plan, PlanMetadata } from "./types.ts";

export interface PlanCreateArgs {
  slug: string;
  title: string;
  overview: string;
  approach?: string | undefined;
  priority?: number | undefined;
  complexity?: number | undefined;
  sessionId?: string | undefined;
  metadata?: PlanMetadata | undefined;
  files?: string[] | undefined;
}

export interface PlanCreateContext {
  agent?: string | undefined;
  sessionID?: string | undefined;
  messageID?: string | undefined;
}

export function planCreateExecutor(
  db: Database,
  args: PlanCreateArgs,
  ctx: PlanCreateContext,
): Plan {
  const typedMeta = (args.metadata ?? {}) as PlanMetadata;
  // Fix: auto-create session row for FK integrity (hybrid (a) — eager)
  if (ctx.sessionID) {
    ensureSession(db, ctx.sessionID, `Plan: ${args.title}`);
  }
  const plan = createPlan(db, {
    id: crypto.randomUUID(),
    slug: args.slug,
    title: args.title,
    status: "draft" as const,
    priority: args.priority ?? 0,
    approvedAt: null,
    completedAt: null,
    sessionId: args.sessionId ?? null,
    overview: args.overview,
    approach: args.approach ?? null,
    complexity: args.complexity ?? 3,
    createdBy: ctx.agent ?? "unknown",
    updatedBy: ctx.agent ?? "unknown",
    sourceSessionId: ctx.sessionID ?? null,
    sourceMessageId: ctx.messageID ?? null,
    category: typedMeta.category ?? null,
    metadata: typedMeta,
    archivedAt: null,
    originalPlanData: null,
    createdByAgent: ctx.agent ?? null,
    executedByAgent: null,
    executedBySession: null,
  });

  // Issue 3: insert files into plan_files with role='input'
  if (args.files && args.files.length > 0) {
    for (const filePath of args.files) {
      db.query(
        "INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, 'input')",
      ).run(plan.id, filePath);
    }
  }

  // Live-reactivity hook: notify SSE subscribers that a new plan exists.
  bus.emit({
    type: "plan.created",
    planId: plan.id,
    slug: plan.slug,
    title: plan.title,
    status: plan.status,
    priority: plan.priority,
    timestamp: Date.now(),
  });

  return plan;
}
