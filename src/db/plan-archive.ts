/**
 * ndomo DB — Plan archive (serialize to markdown + soft delete).
 *
 * When a plan reaches a terminal status (completed/failed/abandoned),
 * this module serializes it to a markdown file in <projectDir>/.ndomo/archives/plans/
 * (resolved by the caller via resolveArchiveDir) and sets archived_at on the
 * plan, its tasks, and its sessions.
 *
 * The archive is transactional: if the DB updates fail, the markdown
 * file is rolled back (deleted) to maintain consistency.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPlan } from "./plans.ts";
import { listSessions } from "./sessions.ts";
import { listTasksByPlan } from "./tasks.ts";
import type { Plan, PlanTask, Session } from "./types.ts";

export interface ArchiveResult {
  planId: string;
  slug: string;
  filePath: string;
  byteSize: number;
  archivedAt: number;
  tasksCount: number;
  sessionsCount: number;
}

/** Sanitize a slug to safe ASCII kebab-case for filenames. */
function sanitizeSlug(slug: string): string {
  return slug
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Serialize a plan, its tasks, and sessions into a markdown string.
 * Follows the exact format specified in the v5 migration spec.
 */
export function serializePlanToMarkdown(
  plan: Plan,
  tasks: PlanTask[],
  sessions: Session[],
  archivedAt: number,
): string {
  const archivedDate = new Date(archivedAt).toISOString();

  const doneTasks = tasks.filter((t) => t.status === "done").length;
  const failedTasks = tasks.filter((t) => t.status === "failed").length;

  const taskLines = tasks.map((t) => {
    const checkbox = t.status === "done" ? "[x]" : "[ ]";
    const parts = [
      `- ${checkbox} **${t.description}** — agent: ${t.agent}, complexity: ${t.complexity}, status: ${t.status}`,
    ];
    if (t.result) {
      parts.push(`  - result: ${t.result}`);
    }
    if (t.error) {
      parts.push(`  - error: ${t.error}`);
    }
    return parts.join("\n");
  });

  const sessionBlocks = sessions.map((s) => {
    const idShort = s.id.slice(0, 8);
    const lines = [
      `### Session ${idShort}`,
      "",
      `- Started: ${s.startedAt ? new Date(s.startedAt).toISOString() : "N/A"}`,
      `- Ended: ${s.endedAt ? new Date(s.endedAt).toISOString() : "ongoing"}`,
      `- Goal: ${s.goal}`,
    ];
    if (s.keyDecisions) {
      lines.push(`- Key decisions: ${s.keyDecisions}`);
    }
    return lines.join("\n");
  });

  const sections = [
    `# Plan: ${plan.title}`,
    "",
    `**Slug:** ${plan.slug}  `,
    `**Status:** ${plan.status}  `,
    `**Archived:** ${archivedDate}  `,
    `**Priority:** ${plan.priority}  `,
    `**Complexity:** ${plan.complexity}  `,
    `**Plan ID:** ${plan.id}`,
    "",
    "## Overview",
    "",
    plan.overview,
  ];

  // v8: agent execution tracking
  if (plan.createdByAgent || plan.executedByAgent) {
    sections.push("", "## Agent Trail", "");
    if (plan.createdByAgent) {
      sections.push(`- **Created by agent:** ${plan.createdByAgent}`);
    }
    if (plan.executedByAgent) {
      sections.push(`- **Executed by agent:** ${plan.executedByAgent}`);
    }
    if (plan.executedBySession) {
      sections.push(`- **Executed by session:** ${plan.executedBySession}`);
    }
  }

  // v6: write-once audit trail — original plan data snapshot
  // HIGH 6: sanitize triple backticks inside JSON to prevent markdown breakage
  if (plan.originalPlanData) {
    const safeJson = plan.originalPlanData.replace(/```/g, "\\`\\`\\`");
    sections.push("", "## Original Plan Data (write-once)", "", "```json", safeJson, "```");
  }

  if (plan.approach) {
    sections.push("", "## Approach", "", plan.approach);
  }

  sections.push(
    "",
    `## Tasks (${tasks.length} total, ${doneTasks} done, ${failedTasks} failed)`,
    "",
    ...taskLines,
    "",
    `## Sessions (${sessions.length})`,
    "",
    ...sessionBlocks,
    "",
    "## Metadata",
    "",
    "```json",
    JSON.stringify(plan.metadata, null, 2),
    "```",
    "",
  );

  return sections.join("\n");
}

/**
 * Build the archive filename from a plan slug and timestamp.
 * Format: `<slug>-YYYY-MM-DD.md`
 */
export function buildArchiveFilename(plan: Plan, archivedAt: number): string {
  const safeSlug = sanitizeSlug(plan.slug);
  const d = new Date(archivedAt);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${safeSlug}-${year}-${month}-${day}.md`;
}

/**
 * Resolve the per-project plan archive directory.
 * Path: <projectDir>/.ndomo/archives/plans/
 * Creates the directory if it does not exist.
 *
 * @param projectDir - Absolute path to the project root.
 * @returns Absolute path to the archive directory.
 */
export function resolveArchiveDir(projectDir: string): string {
  const dir = join(projectDir, ".ndomo", "archives", "plans");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Archive a plan: serialize to markdown + soft delete in DB.
 *
 * Steps:
 * 1. Load plan (throw if not found or already archived)
 * 2. Load tasks and sessions (including archived ones)
 * 3. Resolve mem directory and ensure it exists
 * 4. Serialize to markdown
 * 5. Build filename (with HHMMSS suffix if file exists)
 * 6. Write markdown file
 * 7. Transactional DB update (archived_at on plan, tasks, sessions)
 * 8. Rollback: unlink file if DB update fails
 *
 * @param db - Database instance
 * @param planId - Plan ID to archive
 * @param opts - Archive options.
 * @param opts.memDir - Absolute path to the archive directory (required).
 *   Typically resolved via {@link resolveArchiveDir}.
 */
export function archivePlan(db: Database, planId: string, opts: { memDir: string }): ArchiveResult {
  // 1. Load plan
  const plan = getPlan(db, planId);
  if (!plan) {
    throw new Error(`ndomo: plan not found: ${planId}`);
  }
  if (plan.archivedAt !== null) {
    throw new Error("ndomo: plan already archived");
  }

  // 2. Load tasks and sessions (include archived for completeness)
  const tasks = listTasksByPlan(db, planId, { includeArchived: true });
  const sessions = listSessions(db, { planId, includeArchived: true, limit: 1000 });

  // 3. Resolve mem directory
  const memDir = opts.memDir;
  mkdirSync(memDir, { recursive: true });

  // 4. Serialize
  const now = Date.now();
  const md = serializePlanToMarkdown(plan, tasks, sessions, now);

  // 5. Build filename (with HHMMSS suffix if collision)
  let filename = buildArchiveFilename(plan, now);
  let absPath = join(memDir, filename);
  if (existsSync(absPath)) {
    const d = new Date(now);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const base = filename.replace(/\.md$/, "");
    filename = `${base}-${hh}${mm}${ss}.md`;
    absPath = join(memDir, filename);
  }

  // 6. Write markdown file
  writeFileSync(absPath, md, "utf-8");

  // 7. Transactional DB update
  try {
    const txn = db.transaction(() => {
      db.query("UPDATE plans SET archived_at = ? WHERE id = ? AND archived_at IS NULL").run(
        now,
        planId,
      );

      // Verify the plan was actually archived (changes count includes FTS
      // trigger side-effects in bun:sqlite, so we verify with a SELECT)
      const check = db.query("SELECT archived_at FROM plans WHERE id = ?").get(planId) as {
        archived_at: number | null;
      } | null;
      if (!check || check.archived_at === null) {
        throw new Error("ndomo: archive failed — plan not archived after UPDATE");
      }

      db.query(
        "UPDATE plan_tasks SET archived_at = ? WHERE plan_id = ? AND archived_at IS NULL",
      ).run(now, planId);

      db.query("UPDATE sessions SET archived_at = ? WHERE plan_id = ? AND archived_at IS NULL").run(
        now,
        planId,
      );
    });
    txn();
  } catch (err) {
    // 8. Rollback: remove the markdown file
    try {
      unlinkSync(absPath);
    } catch {
      // Best-effort cleanup — file removal failure is non-fatal
    }
    throw err;
  }

  return {
    planId,
    slug: plan.slug,
    filePath: absPath,
    byteSize: Buffer.byteLength(md, "utf-8"),
    archivedAt: now,
    tasksCount: tasks.length,
    sessionsCount: sessions.length,
  };
}
