#!/usr/bin/env bun
/**
 * ndomo plan CLI — manage plans: create | list | show | update | approve | complete | delete | assign-task.
 *
 * Reads .ndomo/state.db from the project root (resolved same as client.ts).
 * Uses bun:sqlite (synchronous) — no async/await on DB ops.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  approvePlan,
  createPlan,
  deletePlan,
  getPlan,
  getPlanBySlug,
  listPlans,
  updatePlanFields,
  updatePlanStatus,
} from "../db/plans.ts";
import { createTask } from "../db/tasks.ts";
import { runMigrations } from "../db/migrations.ts";
import type { Plan, PlanCategory, PlanOwner, PlanStatus } from "../db/types.ts";

const NDOMO_DIR = ".ndomo";
const DB_FILE = "state.db";

const VALID_CATEGORIES = new Set(["feature", "refactor", "bugfix", "docs", "infra"]);
const VALID_OWNERS = new Set(["foreman", "craftsman", "warden"]);
const SLUG_REGEX = /^[a-z0-9-]+$/;

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

/** Validate slug format. */
function validateSlug(slug: string): void {
  if (!SLUG_REGEX.test(slug)) {
    throw new Error(`[plan] error: invalid slug "${slug}" — must match /^[a-z0-9-]+$/`);
  }
}

/** Validate complexity is 1-5 integer. */
function validateComplexity(value: string | boolean | undefined): number {
  if (value === undefined) return 2; // default
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > 5) {
    throw new Error(`[plan] error: complexity must be 1-5 integer, got "${value}"`);
  }
  return num;
}

/** Validate priority is 1-5 integer. */
function validatePriority(value: string | boolean | undefined): number {
  if (value === undefined) return 2; // default
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > 5) {
    throw new Error(`[plan] error: priority must be 1-5 integer, got "${value}"`);
  }
  return num;
}

/** Validate category is in valid enum. */
function validateCategory(value: string | boolean | undefined): PlanCategory | null {
  if (value === undefined) return null;
  const str = String(value);
  if (!VALID_CATEGORIES.has(str)) {
    throw new Error(`[plan] error: invalid category "${str}" — must be one of: ${Array.from(VALID_CATEGORIES).join(", ")}`);
  }
  return str as PlanCategory;
}

/** Validate owner is in valid enum. */
function validateOwner(value: string | boolean | undefined): PlanOwner {
  if (value === undefined) return "foreman"; // default
  const str = String(value);
  if (!VALID_OWNERS.has(str)) {
    throw new Error(`[plan] error: invalid owner "${str}" — must be one of: ${Array.from(VALID_OWNERS).join(", ")}`);
  }
  return str as PlanOwner;
}

/** Generate a random UUID. */
function generateId(): string {
  return crypto.randomUUID();
}

/** Print plan as JSON. */
function printPlanJson(plan: Plan): void {
  console.log(JSON.stringify(plan, null, 2));
}

/** Print plans as JSON array. */
function printPlansJson(plans: Plan[]): void {
  console.log(JSON.stringify(plans, null, 2));
}

/** Print plans in table format. */
function printPlansTable(plans: Plan[]): void {
  if (plans.length === 0) {
    console.log("no plans found");
    return;
  }

  console.log(
    `${"id".padEnd(10)}${"slug".padEnd(26)}${"title".padEnd(32)}${"status".padEnd(12)}${"owner".padEnd(12)}${"priority".padEnd(10)}${"complexity".padEnd(12)}`,
  );

  for (const p of plans) {
    const id = p.id.slice(0, 8);
    const slug = p.slug.length > 24 ? `${p.slug.slice(0, 21)}...` : p.slug;
    const title = p.title.length > 30 ? `${p.title.slice(0, 27)}...` : p.title;
    console.log(
      `${id.padEnd(10)}${slug.padEnd(26)}${title.padEnd(32)}${p.status.padEnd(12)}${(p.owner ?? "foreman").padEnd(12)}${String(p.priority).padEnd(10)}${String(p.complexity).padEnd(12)}`,
    );
  }
}

/** Handle plan create subcommand. */
function handleCreate(db: Database, args: Record<string, string | boolean>): void {
  const slug = args.slug as string;
  const title = args.title as string;
  const overview = args.overview as string;

  if (!slug) throw new Error("[plan] error: --slug is required");
  if (!title) throw new Error("[plan] error: --title is required");
  if (!overview) throw new Error("[plan] error: --overview is required");

  validateSlug(slug);
  const complexity = validateComplexity(args.complexity);
  const priority = validatePriority(args.priority);
  const category = validateCategory(args.category);
  const owner = validateOwner(args.owner);

  const plan = createPlan(db, {
    id: generateId(),
    slug,
    title,
    status: "draft",
    priority,
    approvedAt: null,
    completedAt: null,
    sessionId: null,
    overview,
    approach: (args.approach as string) ?? null,
    complexity,
    createdBy: "cli",
    updatedBy: "cli",
    sourceSessionId: null,
    sourceMessageId: null,
    category,
    owner,
    metadata: {},
    archivedAt: null,
  });

  printPlanJson(plan);
}

/** Handle plan list subcommand. */
function handleList(db: Database, args: Record<string, string | boolean>): void {
  const status = args.status as PlanStatus | undefined;
  const asJson = args.json === true;

  const plans = listPlans(db, status ? { status } : {});

  if (asJson) {
    printPlansJson(plans);
  } else {
    printPlansTable(plans);
  }
}

/** Handle plan show subcommand. */
function handleShow(db: Database, _args: Record<string, string | boolean>, positional: string[]): void {
  const idOrSlug = positional[0];
  if (!idOrSlug) throw new Error("[plan] error: plan id or slug is required");

  let plan: Plan | null;
  // Try by ID first, then by slug
  plan = getPlan(db, idOrSlug);
  if (!plan) {
    plan = getPlanBySlug(db, idOrSlug);
  }

  if (!plan) {
    throw new Error(`[plan] error: plan not found: ${idOrSlug}`);
  }

  printPlanJson(plan);
}

/** Handle plan update subcommand. */
function handleUpdate(db: Database, args: Record<string, string | boolean>, positional: string[]): void {
  const planId = positional[0];
  if (!planId) throw new Error("[plan] error: plan id is required");

  const fields: Partial<Pick<Plan, "title" | "overview" | "approach" | "complexity" | "category" | "owner">> = {};

  if (args.title !== undefined) fields.title = args.title as string;
  if (args.overview !== undefined) fields.overview = args.overview as string;
  if (args.approach !== undefined) fields.approach = args.approach as string;
  if (args.complexity !== undefined) fields.complexity = validateComplexity(args.complexity);
  if (args.category !== undefined) fields.category = validateCategory(args.category);
  if (args.owner !== undefined) fields.owner = validateOwner(args.owner);

  if (Object.keys(fields).length === 0) {
    throw new Error("[plan] error: at least one field to update is required (--title, --overview, --approach, --complexity, --category, --owner)");
  }

  const plan = updatePlanFields(db, planId, fields, { updatedBy: "cli" });
  if (!plan) {
    throw new Error(`[plan] error: plan not found: ${planId}`);
  }

  printPlanJson(plan);
}

/** Handle plan approve subcommand. */
function handleApprove(db: Database, _args: Record<string, string | boolean>, positional: string[]): void {
  const planId = positional[0];
  if (!planId) throw new Error("[plan] error: plan id is required");

  const plan = approvePlan(db, planId, { updatedBy: "cli" });
  if (!plan) {
    throw new Error(`[plan] error: plan not found: ${planId}`);
  }

  printPlanJson(plan);
}

/** Handle plan complete subcommand. */
function handleComplete(db: Database, _args: Record<string, string | boolean>, positional: string[]): void {
  const planId = positional[0];
  if (!planId) throw new Error("[plan] error: plan id is required");

  const plan = updatePlanStatus(db, planId, "completed", { updatedBy: "cli" });
  if (!plan) {
    throw new Error(`[plan] error: plan not found: ${planId}`);
  }

  printPlanJson(plan);
}

/** Handle plan delete subcommand. */
function handleDelete(db: Database, _args: Record<string, string | boolean>, positional: string[]): void {
  const planId = positional[0];
  if (!planId) throw new Error("[plan] error: plan id is required");

  const result = deletePlan(db, planId, { confirm: true });
  console.log(JSON.stringify(result, null, 2));
}

/** Handle plan assign-task subcommand. */
function handleAssignTask(db: Database, args: Record<string, string | boolean>, positional: string[]): void {
  const planId = positional[0];
  if (!planId) throw new Error("[plan] error: plan id is required");

  const agent = args.agent as string;
  const description = args.description as string;

  if (!agent) throw new Error("[plan] error: --agent is required");
  if (!description) throw new Error("[plan] error: --description is required");

  const files = args.files ? (args.files as string).split(",").map((f: string) => f.trim()) : [];
  const complexity = validateComplexity(args.complexity);

  const task = createTask(db, planId, {
    description,
    agent,
    files,
    complexity,
    dependencies: [],
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

  console.log(JSON.stringify(task, null, 2));
}

/** Main plan dispatcher. */
export function runPlan(args: string[]): void {
  const dbPath = resolveDbPath();
  if (!dbPath) {
    console.error("[plan] error: .ndomo/state.db not found — run from project root or parent dir");
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);

  try {
    const subcommand = args[0];
    if (!subcommand) {
      throw new Error("[plan] error: subcommand is required (create|list|show|update|approve|complete|delete|assign-task)");
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
      case "approve":
        handleApprove(db, parsed, positional);
        break;
      case "complete":
        handleComplete(db, parsed, positional);
        break;
      case "delete":
        handleDelete(db, parsed, positional);
        break;
      case "assign-task":
        handleAssignTask(db, parsed, positional);
        break;
      default:
        throw new Error(`[plan] error: unknown subcommand "${subcommand}"`);
    }
  } catch (err) {
    console.error(`[plan] error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Direct execution
if (import.meta.main) {
  runPlan(process.argv.slice(2));
}
