#!/usr/bin/env bun
/**
 * ndomo spec CLI — thin wrapper over `src/spec`: list | show | lint.
 *
 * Contract (SSOT): `.ndomo/specs/001-sdd-core/spec.md` §7, REQ-009. Payloads
 * are byte-identical to the `spec_get` / `spec_lint` tools; specs are DB-free
 * files at `<projectDir>/.ndomo/specs/NNN-<slug>/spec.md`.
 *
 * Project dir: cwd when it has a `.ndomo/` dir, else the nearest ancestor
 * (≤5 levels up, same budget as plan.ts/task.ts), else cwd as a fallback so
 * `list` can still report `[]` outside a project. The pivot is the `.ndomo`
 * DIRECTORY, not `state.db`: only `lint --plan` touches the DB (L6/L7), so
 * `list`/`show`/`lint` keep working on a fresh clone before any DB exists.
 *
 * Exit-code contract (audit.ts pattern — `runSpecCli` RETURNS the code so
 * tests can assert it without killing the process; index.ts applies it via
 * `process.exitCode`):
 *   0 — list/show ran; lint report `ok: true` (warnings alone NEVER fail)
 *   1 — usage error (missing/unknown subcommand, missing id/path), an
 *       unresolvable spec reference (JSON error on stderr naming it),
 *       `--plan` without a usable value/DB, or a lint report with ≥1
 *       error-severity finding (`ok: false`)
 *
 * Output: payloads (and lint reports, even failing ones) go to stdout as
 * pretty JSON; error objects and usage errors go to stderr as JSON /
 * `[spec] error: …` text.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { runMigrations } from "../db/migrations.ts";
import { listTasksByPlan } from "../db/tasks.ts";
import type { TaskMetadata } from "../db/types.ts";
import {
  buildSpecId,
  type LintContext,
  lintSpecFile,
  parseSpec,
  resolveSpecPath,
} from "../spec/index.ts";

const NDOMO_DIR = ".ndomo";
const DB_FILE = "state.db";
const MAX_UP = 5;
const SUBCOMMANDS = "list|show <id|path>|lint <id|path> [--plan <planId>]";

// ─── Project / DB resolution ─────────────────────────────────────────────────

/**
 * Resolve the project dir: cwd when it contains `.ndomo/`, else walk up to
 * {@link MAX_UP} ancestors (plan.ts/task.ts budget), else cwd — a bare dir is
 * still a valid (empty) project for `spec list`, which must print `[]`, 0.
 */
function resolveProjectDir(): string {
  const hasNdomo = (dir: string): boolean => existsSync(join(dir, NDOMO_DIR));
  const cwd = process.cwd();
  if (hasNdomo(cwd)) return cwd;

  let dir = cwd;
  for (let i = 0; i < MAX_UP; i++) {
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
    if (hasNdomo(dir)) return dir;
  }
  return cwd;
}

/** DB path inside the resolved project dir — the file plan.ts/task.ts use. */
function resolveDbPath(projectDir: string): string | null {
  const candidate = join(projectDir, NDOMO_DIR, DB_FILE);
  return existsSync(candidate) ? candidate : null;
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

/**
 * Split args into flags and positionals in ONE pass: a flag's value is
 * consumed as the flag's value and never leaks into `positionals` (the
 * two-pass `filter(!startsWith("--"))` in plan.ts/task.ts would put
 * `--plan <id>`'s value there too, misrouting `lint --plan <id> <spec>`).
 */
function splitArgs(args: string[]): {
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    // next is a value if it exists AND is not a flag — even "" is a value.
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positionals };
}

// ─── Errors ──────────────────────────────────────────────────────────────────

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Usage / operational error on stderr in the sibling CLIs' style. */
function fail(text: string): number {
  console.error(text);
  return 1;
}

/** JSON error on stderr naming the unresolved spec reference (exit 1). */
function failNotFound(ref: string): number {
  console.error(JSON.stringify({ error: `spec not found: ${ref}` }, null, 2));
  return 1;
}

// ─── spec list ───────────────────────────────────────────────────────────────

/** One `ndomo spec list` row. Every field is a string and always present. */
interface SpecListEntry {
  id: string;
  slug: string;
  title: string;
  status: string;
  version: string;
  owner: string;
  updated: string;
  /** Specs-dir path relative to the project dir (POSIX separators). */
  path: string;
}

/** Coerce a frontmatter value (scalar | list | missing) to a single string. */
function asString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

/**
 * Scan every `<projectDir>/.ndomo/specs/<entry>/spec.md` and read its frontmatter.
 * READ-ONLY: never mkdirs (`resolveSpecsDir` would), so a missing or empty
 * specs dir yields `[]`, exit 0. Sorted by `id` (code-unit order — the ids are
 * zero-padded `SPEC-NNN`, so this equals numeric order) for determinism.
 */
function listSpecs(projectDir: string): SpecListEntry[] {
  const specsDir = join(projectDir, NDOMO_DIR, "specs");
  let entries: string[];
  try {
    entries = readdirSync(specsDir);
  } catch {
    return [];
  }

  const rows: SpecListEntry[] = [];
  for (const entry of entries) {
    const file = join(specsDir, entry, "spec.md");
    if (!existsSync(file)) continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable spec — listing stays total, lint reports it (L0)
    }
    const fm = parseSpec(raw).frontmatter;
    const dirIndex = /^\d+/.exec(entry)?.[0];
    const id =
      typeof fm.id === "string" && fm.id.length > 0
        ? fm.id
        : dirIndex !== undefined
          ? buildSpecId(Number(dirIndex))
          : "";
    rows.push({
      id,
      slug: asString(fm.slug) || entry.replace(/^\d+-/, ""),
      title: asString(fm.title),
      status: asString(fm.status),
      version: asString(fm.version),
      owner: asString(fm.owner),
      updated: asString(fm.updated),
      path: relative(projectDir, file).split(sep).join("/"),
    });
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function handleList(projectDir: string): number {
  console.log(JSON.stringify(listSpecs(projectDir), null, 2));
  return 0;
}

// ─── spec show ───────────────────────────────────────────────────────────────

/**
 * `ndomo spec show <id|path>` — the `spec_get` payload: frontmatter, sections,
 * requirements mapped to {id, type, priority, status, acs} and the matrix.
 * `doc.raw` and `requirements[].body` are deliberately NOT dumped (contract §7).
 */
function handleShow(projectDir: string, positionals: string[]): number {
  const ref = positionals[0];
  if (ref === undefined || ref.length === 0) {
    return fail(`[spec] error: spec id or path is required (${SUBCOMMANDS})`);
  }
  const file = resolveSpecPath(projectDir, ref);
  if (file === null) return failNotFound(ref);

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return fail(
      JSON.stringify({ error: `could not read spec at ${file}: ${message(err)}` }, null, 2),
    );
  }

  const doc = parseSpec(raw, { sourcePath: file });
  const payload = {
    frontmatter: doc.frontmatter,
    sections: doc.sections,
    requirements: doc.requirements.map((r) => ({
      id: r.id,
      type: r.type,
      priority: r.priority,
      status: r.status,
      acs: r.acs,
    })),
    matrix: doc.matrix,
  };
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

// ─── spec lint ───────────────────────────────────────────────────────────────

/**
 * `plan_tasks.metadata.reqIds` per spec §7 metadata table. The type says
 * `string[]`, but the value comes from `JSON.parse`d row metadata, so keep a
 * runtime guard: missing/malformed values degrade to `[]` (→ L6 fires)
 * instead of crashing the CLI.
 */
function extractReqIds(metadata: TaskMetadata | undefined): string[] {
  const raw = metadata?.reqIds;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Build `LintContext.tasks` for L6/L7. `--plan` is the only DB access in this
 * CLI; returns `null` (after printing the error) when the DB is missing or
 * unreadable so the caller exits non-zero without running a partial lint.
 */
function loadTraceTasks(
  projectDir: string,
  planId: string,
): { id: string; reqIds: string[] }[] | null {
  const dbPath = resolveDbPath(projectDir);
  if (dbPath === null) {
    fail(
      `[spec] error: ${join(NDOMO_DIR, DB_FILE)} not found — --plan ${planId} needs the project DB`,
    );
    return null;
  }

  let db: Database | undefined;
  try {
    db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    return listTasksByPlan(db, planId).map((task) => ({
      id: task.id,
      reqIds: extractReqIds(task.metadata),
    }));
  } catch (err) {
    fail(`[spec] error: could not read tasks for plan ${planId}: ${message(err)}`);
    return null;
  } finally {
    db?.close();
  }
}

/**
 * `ndomo spec lint <id|path> [--plan <planId>]` — the `spec_lint` payload
 * verbatim. Exit 0 iff `report.ok` (warnings alone never fail), else 1.
 */
function handleLint(
  projectDir: string,
  flags: Record<string, string | boolean>,
  positionals: string[],
): number {
  const ref = positionals[0];
  if (ref === undefined || ref.length === 0) {
    return fail(`[spec] error: spec id or path is required (${SUBCOMMANDS})`);
  }

  const planFlag = flags.plan;
  if (planFlag !== undefined && (typeof planFlag !== "string" || planFlag.length === 0)) {
    return fail("[spec] error: --plan requires a plan id value");
  }

  // Resolve BEFORE linting: an unknown reference is a usage error (JSON on
  // stderr naming it), not an L0 lint finding on stdout — same as the tools.
  if (resolveSpecPath(projectDir, ref) === null) return failNotFound(ref);

  const ctx: LintContext = {};
  if (typeof planFlag === "string") {
    const tasks = loadTraceTasks(projectDir, planFlag);
    if (tasks === null) return 1; // error already printed
    ctx.tasks = tasks;
  }

  const report = lintSpecFile(projectDir, ref, ctx);
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Main spec dispatcher. RETURNS the exit code instead of calling
 * `process.exit()` (audit.ts pattern) so tests can assert every error path;
 * `import.meta.main` and the `spec` registration in index.ts apply it.
 */
export function runSpecCli(args: string[]): number {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand.length === 0) {
    return fail(`[spec] error: subcommand is required (${SUBCOMMANDS})`);
  }

  const projectDir = resolveProjectDir();
  const { flags, positionals } = splitArgs(args.slice(1));

  switch (subcommand) {
    case "list":
      return handleList(projectDir);
    case "show":
      return handleShow(projectDir, positionals);
    case "lint":
      return handleLint(projectDir, flags, positionals);
    default:
      return fail(`[spec] error: unknown subcommand "${subcommand}" (${SUBCOMMANDS})`);
  }
}

// Direct execution
if (import.meta.main) {
  // process.exitCode instead of process.exit(): lets stdout flush completely
  // (important for JSON piped into another process) while keeping the code.
  process.exitCode = runSpecCli(process.argv.slice(2));
}
