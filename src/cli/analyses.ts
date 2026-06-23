#!/usr/bin/env bun
/**
 * ndomo analyses CLI — list, get, search, archive analyses.
 *
 * Reads .ndomo/state.db from the project root (resolved same as status.ts).
 * Supports list/get/search/archive subcommands with filters.
 *
 * Uses bun:sqlite (synchronous) — no async/await on DB ops.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  archiveAnalysis,
  getAnalysis,
  getAnalysisBySlug,
  listAnalyses,
  searchAnalyses,
} from "../db/analyses.ts";
import { runMigrations } from "../db/migrations.ts";
import type { Analysis } from "../db/types.ts";

const NDOMO_DIR = ".ndomo";
const DB_FILE = "state.db";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve DB path — same logic as src/cli/status.ts. */
function resolveDbPath(): string | null {
  const cwdPath = join(process.cwd(), NDOMO_DIR, DB_FILE);
  if (existsSync(cwdPath)) return cwdPath;

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

/** Short ID — first 8 chars. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Truncate string to maxLen with "..." suffix. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 3)}...`;
}

/** Print analyses as table. */
function printTable(analyses: Analysis[]): void {
  if (analyses.length === 0) {
    console.log("no analyses found");
    return;
  }

  console.log(
    `  ${"id".padEnd(10)}${"slug".padEnd(26)}${"title".padEnd(32)}${"agent".padEnd(12)}${"sourcePlan".padEnd(12)}${"updatedAt".padEnd(22)}`,
  );

  for (const a of analyses) {
    const id = shortId(a.id);
    const slug = truncate(a.slug, 24);
    const title = truncate(a.title, 30);
    const agent = truncate(a.agent, 10);
    const sourcePlan = a.sourcePlanId ? shortId(a.sourcePlanId) : "-";
    const updatedAt = a.updatedAt ?? "-";

    console.log(
      `  ${id.padEnd(10)}${slug.padEnd(26)}${title.padEnd(32)}${agent.padEnd(12)}${sourcePlan.padEnd(12)}${updatedAt.padEnd(22)}`,
    );
  }
}

/** Print single analysis as JSON. */
function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/** Print help text. */
function printHelp(): void {
  console.log(`Usage: ndomo analyses <subcommand> [options]

Subcommands:
  list                   List analyses (default)
    --agent <name>       Filter by agent
    --source-plan <id>   Filter by source plan ID
    --project <path>     Filter by project path
    --archived           Include archived analyses
    --limit <n>          Max results (default 50)

  get <id-or-slug>       Get analysis by ID or slug
    --project <path>     Required when using slug

  search <query>         Full-text search over title+summary+findings
    --limit <n>          Max results (default 20)

  archive <id>           Soft-delete an analysis

  help                   Show this help`);
}

// ─── Subcommand handlers ─────────────────────────────────────────────────────

function handleList(db: Database, args: string[]): void {
  let agent: string | undefined;
  let sourcePlanId: string | undefined;
  let projectPath: string | undefined;
  let archived: boolean | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--agent" && i + 1 < args.length) {
      agent = args[++i]!;
    } else if (arg === "--source-plan" && i + 1 < args.length) {
      sourcePlanId = args[++i]!;
    } else if (arg === "--project" && i + 1 < args.length) {
      projectPath = args[++i]!;
    } else if (arg === "--archived") {
      archived = true;
    } else if (arg === "--limit" && i + 1 < args.length) {
      const n = Number.parseInt(args[++i]!, 10);
      if (Number.isNaN(n) || n < 1) {
        console.error("error: --limit must be a positive integer");
        process.exit(1);
      }
      limit = n;
    }
  }

  const filters: Parameters<typeof listAnalyses>[1] = {};
  if (agent !== undefined) filters.agent = agent;
  if (sourcePlanId !== undefined) filters.sourcePlanId = sourcePlanId;
  if (projectPath !== undefined) filters.projectPath = projectPath;
  if (archived !== undefined) filters.archived = archived;
  if (limit !== undefined) filters.limit = limit;

  const results = listAnalyses(db, filters);
  printTable(results);
}

function handleGet(db: Database, args: string[]): void {
  if (args.length === 0) {
    console.error("error: get requires an ID or slug argument");
    process.exit(1);
  }

  const identifier = args[0]!;
  let projectPath: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--project" && i + 1 < args.length) {
      projectPath = args[++i]!;
    }
  }

  let analysis: Analysis | null = null;

  // UUIDs have 8-4-4-4-12 format; slugs are shorter kebab-case
  const isUuid = identifier.includes("-") && identifier.length >= 36;

  if (isUuid) {
    analysis = getAnalysis(db, identifier);
  } else {
    // Treat as slug — requires --project
    if (projectPath === undefined) {
      console.error("error: --project <path> is required when using slug");
      process.exit(1);
    }
    analysis = getAnalysisBySlug(db, identifier, projectPath);
  }

  if (!analysis) {
    console.error(`error: analysis '${identifier}' not found`);
    process.exit(1);
  }

  printJson(analysis);
}

function handleSearch(db: Database, args: string[]): void {
  if (args.length === 0) {
    console.error("error: search requires a query argument");
    process.exit(1);
  }

  const query = args[0]!;
  let limit = 20;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--limit" && i + 1 < args.length) {
      const n = Number.parseInt(args[++i]!, 10);
      if (Number.isNaN(n) || n < 1) {
        console.error("error: --limit must be a positive integer");
        process.exit(1);
      }
      limit = n;
    }
  }

  const results = searchAnalyses(db, query, { limit });
  printTable(results);
}

function handleArchive(db: Database, args: string[]): void {
  if (args.length === 0) {
    console.error("error: archive requires an ID argument");
    process.exit(1);
  }

  const id = args[0]!;
  try {
    const archived = archiveAnalysis(db, id);
    console.log(`archived analysis: ${shortId(archived.id)} (${archived.slug})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`error: ${message}`);
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function runAnalyses(args: string[]): void {
  const subcommand = args[0];

  // Help (before DB resolution)
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  const dbPath = resolveDbPath();
  if (!dbPath) {
    console.error("error: .ndomo/state.db not found — run from project root or parent dir");
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);

  try {
    const rest = args.slice(1);

    switch (subcommand) {
      case "list":
        handleList(db, rest);
        break;
      case "get":
        handleGet(db, rest);
        break;
      case "search":
        handleSearch(db, rest);
        break;
      case "archive":
        handleArchive(db, rest);
        break;
      default:
        console.error(`error: unknown subcommand '${subcommand}'`);
        printHelp();
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

// Direct execution
if (import.meta.main) {
  runAnalyses(process.argv.slice(2));
}
