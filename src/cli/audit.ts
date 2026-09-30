#!/usr/bin/env bun
/**
 * ndomo audit CLI — self-audit report (drift, permissions, counts, config,
 * manifest) with a deterministic 1–100 score.
 *
 * Read-only by default: the ONLY write this command may perform is the sha256
 * baseline `<projectDir>/.ndomo/audit/manifest.json`, and only with
 * `--update-manifest`. Aggregation lives in `src/audit/` (shared with tests);
 * this file only resolves the project root, renders and parses flags.
 *
 * Project-root resolution mirrors the walk-up used by `src/cli/status.ts` and
 * `src/cli/stats.ts` (cwd first, then ≤5 parents, stop at `/`), but their
 * pivot — `.ndomo/state.db` — is a DB location, not a repo root, and the audit
 * needs the root itself. So the predicate is the marker set the audit checks
 * live in: a dir containing `agents/`, `skills/`, `src/` AND `config/`.
 *
 * Exit-code contract (same spirit as stats.ts, which exits 1 on an invalid
 * `--since` value):
 *   0 — the report ran and contains ZERO `ERROR` findings
 *       (`WARN`/`INFO` are drift, not breakage → they never fail the command)
 *   1 — at least one `ERROR` finding, OR an invalid invocation
 *       (unknown flag / project root not found)
 *
 * Unlike the sibling CLIs, `runAuditCli` RETURNS the exit code instead of
 * calling `process.exit()`: the ERROR path is a normal outcome that tests must
 * assert, and `process.exit()` would kill the test process. `import.meta.main`
 * and the `audit` registration in index.ts apply the returned code.
 *
 * Uses bun + `node:fs` synchronously (like stats.ts) — no async/await needed.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AuditReport, runAudit, type Severity } from "../audit/index.ts";

/** Dirs that identify the repo root — all four must exist in the same dir. */
const ROOT_MARKERS = ["agents", "skills", "src", "config"] as const;

/** Max parent levels to walk up (same budget as status.ts / stats.ts). */
const MAX_UP = 5;

/** Severity order for the human report (ERROR first — mirrors sortFindings). */
const SEVERITY_ORDER: readonly Severity[] = ["ERROR", "WARN", "INFO"];

/** `true` when `dir` contains every marker dir of an ndomo repo root. */
function isProjectRoot(dir: string): boolean {
  return ROOT_MARKERS.every((name) => existsSync(join(dir, name)));
}

/**
 * Resolve the repo root: try cwd, then walk up (max {@link MAX_UP} levels).
 * Returns `null` when no ancestor is an ndomo repo root.
 */
export function resolveProjectDir(): string | null {
  const cwd = process.cwd();
  if (isProjectRoot(cwd)) return cwd;

  let dir = cwd;
  for (let i = 0; i < MAX_UP; i++) {
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
    if (isProjectRoot(dir)) return dir;
  }
  return null;
}

/** Truncate to `maxLen` including the `...` suffix. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

/** Print usage (stdout for `--help`, returned as a string for error hints). */
function helpText(): string {
  return `ndomo audit — self-audit report (drift, permissions, counts, config, manifest)

Usage:
  bun run src/cli/audit.ts [flags]
  bun run src/cli/index.ts audit [flags]

Flags:
  --json               print the report as JSON instead of the human report
  --update-manifest    re-baseline .ndomo/audit/manifest.json (the only write
                       this command performs; default is report-only)
  --help, -h           show this help

Exit codes:
  0  no ERROR findings (WARN/INFO never fail the command)
  1  at least one ERROR finding, or an invalid invocation`;
}

/** Print the report as a human-readable list grouped by severity. */
function printReport(report: AuditReport): void {
  const manifest = report.manifest;
  console.log(`NDOMO AUDIT — ${report.projectDir}`);
  console.log(
    `manifest: ${manifest.path} ` +
      `(${manifest.baselineFound ? "baseline found" : "no baseline"}, ` +
      `${manifest.tracked} files tracked${manifest.written ? ", written" : ""})`,
  );
  console.log("");

  for (const severity of SEVERITY_ORDER) {
    const group = report.findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    console.log(`${severity} (${group.length})`);
    for (const finding of group) {
      console.log(`  [${finding.code}] ${finding.path}`);
      console.log(`      ${truncate(finding.message, 160)}`);
    }
    console.log("");
  }

  if (report.findings.length === 0) {
    console.log("no findings");
    console.log("");
  }

  const summary = report.summary;
  console.log(
    `score: ${report.score}/100 — ` +
      `${summary.error} error, ${summary.warn} warn, ${summary.info} info ` +
      `(${summary.total} findings)`,
  );
}

/** Print the report as JSON (stats.ts printJson pattern). */
function printJson(report: AuditReport): void {
  console.log(JSON.stringify(report, null, 2));
}

/**
 * Parse CLI args and run the audit.
 *
 * @returns process exit code — 0 without `ERROR` findings, 1 otherwise (or on
 *          an invalid invocation). See the module docstring for the contract.
 */
export function runAuditCli(args: string[]): number {
  let asJson = false;
  let updateManifest = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--json") {
      asJson = true;
    } else if (arg === "--update-manifest") {
      updateManifest = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(helpText());
      return 0;
    } else {
      console.error(`error: unknown flag "${arg}" — run with --help`);
      return 1;
    }
  }

  const projectDir = resolveProjectDir();
  if (projectDir === null) {
    console.error(
      "error: ndomo project root not found — expected a directory containing " +
        "agents/, skills/, src/ and config/ (run from the project root)",
    );
    return 1;
  }

  const report = runAudit({ projectDir, updateManifest });

  if (asJson) {
    printJson(report);
  } else {
    printReport(report);
  }

  // Exit code: 1 only for ERROR findings (security/broken config) — see header.
  return report.summary.error > 0 ? 1 : 0;
}

// Direct execution
if (import.meta.main) {
  // process.exitCode instead of process.exit(): lets stdout flush completely
  // (important for --json piped into another process) while keeping the code.
  process.exitCode = runAuditCli(process.argv.slice(2));
}
