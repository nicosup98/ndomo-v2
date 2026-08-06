#!/usr/bin/env bun
/**
 * ndomo task CLI — manage tasks: create | list | show | update | reassign | complete | fail.
 *
 * Reads .ndomo/state.db from the project root (resolved same as client.ts).
 * Uses bun:sqlite (synchronous) — no async/await on DB ops.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createTask,
  getTask,
  listTasksByPlan,
  reassignTask,
  recordTaskVerification,
  updateTaskStatus,
} from "../db/tasks.ts";
import { runMigrations } from "../db/migrations.ts";
import type { PlanTask, TaskStatus } from "../db/types.ts";

const NDOMO_DIR = ".ndomo";
const DB_FILE = "state.db";

const VALID_STATUSES = new Set(["pending", "running", "done", "failed", "blocked"]);

/**
 * Resolve DB path — same logic as src/db/client.ts.
 * Tries cwd first, then walks up to find .ndomo/state.db.
 */
function resolveDbPath(): string | null {
  // Try cwd
  const cwdPath = join(process.cwd(), NDOMO_DIR, DB_FILE);
  if (existsSync(cwdPath)) return cwdPath;

  // Try parent dirs (max 5 levels up)
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
    const candidate = join(dir, NDOMO_DIR, DB_FILE);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** Parse CLI args into a key-value record. */
function parseArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg && arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      // next is a value if it exists AND is not a flag — even empty string is a valid value.
      if (next !== undefined && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

/** Validate status is in valid enum. */
function validateStatus(value: string | boolean | undefined): TaskStatus {
  if (value === undefined) throw new Error("[task] error: --status is required");
  const str = String(value);
  if (!VALID_STATUSES.has(str)) {
    throw new Error(`[task] error: invalid status "${str}" — must be one of: ${Array.from(VALID_STATUSES).join(", ")}`);
  }
  return str as TaskStatus;
}

/** Validate complexity is 1-5 integer. */
function validateComplexity(value: string | boolean | undefined): number {
  if (value === undefined) return 2; // default
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > 5) {
    throw new Error(`[task] error: complexity must be 1-5 integer, got "${value}"`);
  }
  return num;
}

/** Print task as JSON. */
function printTaskJson(task: PlanTask): void {
  console.log(JSON.stringify(task, null, 2));
}

/** Print tasks as JSON array. */
function printTasksJson(tasks: PlanTask[]): void {
  console.log(JSON.stringify(tasks, null, 2));
}

/** Print tasks in table format. */
function printTasksTable(tasks: PlanTask[]): void {
  if (tasks.length === 0) {
    console.log("no tasks found");
    return;
  }

  console.log(
    `${"id".padEnd(10)}${"agent".padEnd(16)}${"status".padEnd(12)}${"complexity".padEnd(12)}${"description".padEnd(40)}`,
  );

  for (const t of tasks) {
    const id = t.id.slice(0, 8);
    const agent = t.agent.length > 14 ? `${t.agent.slice(0, 11)}...` : t.agent;
    const description = t.description.length > 38 ? `${t.description.slice(0, 35)}...` : t.description;
    console.log(
      `${id.padEnd(10)}${agent.padEnd(16)}${t.status.padEnd(12)}${String(t.complexity).padEnd(12)}${description.padEnd(40)}`,
    );
  }
}

/** Handle task create subcommand. */
function handleCreate(db: Database, args: Record<string, string | boolean>): void {
  const planId = args.plan as string;
  const agent = args.agent as string;
  const description = args.description as string;

  if (!planId) throw new Error("[task] error: --plan is required");
  if (!agent) throw new Error("[task] error: --agent is required");
  if (!description) throw new Error("[task] error: --description is required");

  const files = args.files ? (args.files as string).split(",").map((f: string) => f.trim()) : [];
  const complexity = validateComplexity(args.complexity);
  const dependencies = args.dependencies ? (args.dependencies as string).split(",").map((d: string) => d.trim()) : [];

  const task = createTask(db, planId, {
    description,
    agent,
    files,
    complexity,
    dependencies,
    createdBy: "cli",
    updatedBy: "cli",
    sourceSessionId: null,
    sourceMessageId: null,
    reviewedBy: null,
    tokensUsed: null,
    durationMs: null,
    artifacts: [],
    metadata: {},
  });

  printTaskJson(task);
}

/** Handle task list subcommand. */
function handleList(db: Database, args: Record<string, string | boolean>): void {
  const planId = args.plan as string;
  if (!planId) throw new Error("[task] error: --plan is required");

  const status = args.status as TaskStatus | undefined;
  const asJson = args.json === true;

  const tasks = listTasksByPlan(db, planId, status ? { status } : {});

  if (asJson) {
    printTasksJson(tasks);
  } else {
    printTasksTable(tasks);
  }
}

/** Handle task show subcommand. */
function handleShow(db: Database, _args: Record<string, string | boolean>, positional: string[]): void {
  const taskId = positional[0];
  if (!taskId) throw new Error("[task] error: task id is required");

  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`[task] error: task not found: ${taskId}`);
  }

  printTaskJson(task);
}

/** Handle task update subcommand. */
function handleUpdate(db: Database, args: Record<string, string | boolean>, positional: string[]): void {
  const taskId = positional[0];
  if (!taskId) throw new Error("[task] error: task id is required");

  const status = validateStatus(args.status);
  const result = args.result as string | undefined;
  const error = args.error as string | undefined;
  // v17 (T1): force-bypass the verification gate when transitioning to 'done'.
  const force = args.force === true;
  const forceReason = typeof args["force-reason"] === "string" ? args["force-reason"] : undefined;

  const fields: {
    result?: string;
    error?: string;
    force?: boolean;
    forceReason?: string;
  } = {};
  if (result !== undefined) fields.result = result;
  if (error !== undefined) fields.error = error;
  if (force) fields.force = true;
  if (forceReason !== undefined) fields.forceReason = forceReason;

  const task = updateTaskStatus(db, taskId, status, fields, "cli");

  if (!task) {
    throw new Error(`[task] error: task not found: ${taskId}`);
  }

  printTaskJson(task);
}

/** Handle task reassign subcommand. */
function handleReassign(db: Database, args: Record<string, string | boolean>, positional: string[]): void {
  const taskId = positional[0];
  if (!taskId) throw new Error("[task] error: task id is required");

  const agent = args.agent as string;
  if (!agent) throw new Error("[task] error: --agent is required");

  const task = reassignTask(db, taskId, agent, { updatedBy: "cli" });
  if (!task) {
    throw new Error(`[task] error: task not found: ${taskId}`);
  }

  printTaskJson(task);
}

/** Handle task complete subcommand. */
function handleComplete(db: Database, args: Record<string, string | boolean>, positional: string[]): void {
  const taskId = positional[0];
  if (!taskId) throw new Error("[task] error: task id is required");

  const result = args.result as string | undefined;
  // v17 (T1): force-bypass the verification gate.
  const force = args.force === true;
  const forceReason = typeof args["force-reason"] === "string" ? args["force-reason"] : undefined;

  const fields: { result?: string; force?: boolean; forceReason?: string } = {};
  if (result !== undefined) fields.result = result;
  if (force) fields.force = true;
  if (forceReason !== undefined) fields.forceReason = forceReason;

  const task = updateTaskStatus(db, taskId, "done", fields, "cli");

  if (!task) {
    throw new Error(`[task] error: task not found: ${taskId}`);
  }

  printTaskJson(task);
}

/** Handle task verify subcommand (v17/T1). */
function handleVerify(db: Database, args: Record<string, string | boolean>, positional: string[]): void {
  const taskId = positional[0];
  if (!taskId) throw new Error("[task] error: task id is required");

  const verdictRaw = args.verdict as string | undefined;
  const VALID_VERDICTS = new Set(["passed", "failed", "waived"]);
  if (!verdictRaw || !VALID_VERDICTS.has(verdictRaw)) {
    throw new Error(
      `[task] error: --verdict is required and must be one of: ${Array.from(VALID_VERDICTS).join(", ")}`,
    );
  }
  const verdict = verdictRaw as "passed" | "failed" | "waived";

  const reason = typeof args.reason === "string" ? args.reason : undefined;
  const force = args.force === true;
  const forceReason = typeof args["force-reason"] === "string" ? args["force-reason"] : undefined;
  const verifiedBy = typeof args["verified-by"] === "string" ? args["verified-by"] : "cli";

  // result may be passed as JSON string
  let resultObj: Record<string, unknown> | undefined;
  const resultRaw = typeof args["verify-result"] === "string" ? args["verify-result"] : undefined;
  if (resultRaw !== undefined) {
    try {
      const parsed = JSON.parse(resultRaw);
      resultObj =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed };
    } catch {
      resultObj = { raw: resultRaw };
    }
  }

  const task = recordTaskVerification(db, taskId, verdict, resultObj, verifiedBy, {
    ...(reason !== undefined ? { reason } : {}),
    ...(force ? { force: true } : {}),
    ...(forceReason !== undefined ? { forceReason } : {}),
  });

  printTaskJson(task);
}

/** Handle task fail subcommand. */
function handleFail(db: Database, args: Record<string, string | boolean>, positional: string[]): void {
  const taskId = positional[0];
  if (!taskId) throw new Error("[task] error: task id is required");

  const error = args.error as string;
  if (!error) throw new Error("[task] error: --error is required");

  const task = updateTaskStatus(db, taskId, "failed", {
    error,
  }, "cli");

  if (!task) {
    throw new Error(`[task] error: task not found: ${taskId}`);
  }

  printTaskJson(task);
}

/** Main task dispatcher. */
export function runTask(args: string[]): void {
  const dbPath = resolveDbPath();
  if (!dbPath) {
    console.error("[task] error: .ndomo/state.db not found — run from project root or parent dir");
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);

  try {
    const subcommand = args[0];
    if (!subcommand) {
      throw new Error("[task] error: subcommand is required (create|list|show|update|reassign|complete|fail|verify)");
    }

    const restArgs = args.slice(1);
    const parsed = parseArgs(restArgs);
    const positional = restArgs.filter((arg) => !arg.startsWith("--"));

    switch (subcommand) {
      case "create":
        handleCreate(db, parsed);
        break;
      case "list":
        handleList(db, parsed);
        break;
      case "show":
        handleShow(db, parsed, positional);
        break;
      case "update":
        handleUpdate(db, parsed, positional);
        break;
      case "reassign":
        handleReassign(db, parsed, positional);
        break;
      case "complete":
        handleComplete(db, parsed, positional);
        break;
      case "fail":
        handleFail(db, parsed, positional);
        break;
      case "verify":
        handleVerify(db, parsed, positional);
        break;
      default:
        throw new Error(`[task] error: unknown subcommand "${subcommand}"`);
    }
  } catch (err) {
    console.error(`[task] error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Direct execution
if (import.meta.main) {
  runTask(process.argv.slice(2));
}
