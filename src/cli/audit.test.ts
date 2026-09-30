/**
 * Tests for src/cli/audit.ts — CLI audit command (self-audit report).
 *
 * Same pattern as stats.test.ts: a REAL fixture project lives in a temp dir
 * (`mkdtemp`) and `process.chdir` into it so `resolveProjectDir()` picks it up;
 * stdout/stderr are captured around `runAuditCli()`, which — unlike the sibling
 * CLIs — RETURNS the exit code so the ERROR path can be asserted without
 * killing the test process.
 *
 * Tests:
 * 1. Human report groups findings by severity and ends with `score: N/100`
 * 2. Exit code 0 without ERROR findings, 1 with at least one ERROR
 * 3. --json → parseable JSON report (score / summary / findings / manifest)
 * 4. --update-manifest writes .ndomo/audit/manifest.json (the only write)
 * 5. --help prints usage (exit 0); an unknown flag fails (exit 1)
 * 6. No project root in the cwd chain → stderr error, exit 1
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_REL_PATH } from "../audit/index.ts";
import { runAuditCli } from "./audit.ts";

let tmpDir: string;

/** Valid config whose `default` preset pins the single fixture agent. */
const CONFIG = JSON.stringify({
  preset: "default",
  presets: { default: { alpha: { model: "model-a", temperature: 0.3 } } },
});

/** Agent frontmatter that matches the preset and grants no wildcard bash. */
const SAFE_AGENT = [
  "---",
  "mode: subagent",
  "model: model-a",
  "temperature: 0.3",
  "permission:",
  "  edit: allow",
  "  bash:",
  '    "bun test": allow',
  "---",
  "",
  "Body.",
].join("\n");

/** Agent that grants bash to every command → `perm.bash-wildcard-allow` ERROR. */
const UNSAFE_AGENT = [
  "---",
  "mode: subagent",
  "permission:",
  "  bash: allow",
  "---",
  "",
  "Body.",
].join("\n");

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ndomo-cli-audit-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write the fixture project (marker dirs the CLI resolves on) into `dir`. */
function writeProject(dir: string, agent: string): void {
  for (const marker of ["agents", "skills", "config", "src", "docs"]) {
    mkdirSync(join(dir, marker), { recursive: true });
  }
  writeFileSync(join(dir, "agents", "alpha.md"), agent, "utf-8");
  writeFileSync(join(dir, "config", "ndomo.config.json"), CONFIG, "utf-8");
}

/** Capture console output during a function call (stats.test.ts pattern). */
function captureConsole(fn: () => void): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { stdout, stderr };
}

/** Run `runAuditCli` with cwd set to `dir`; returns output + exit code. */
function runAuditIn(dir: string, args: string[]): { stdout: string; stderr: string; code: number } {
  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    let code = -1;
    const captured = captureConsole(() => {
      code = runAuditCli(args);
    });
    return { ...captured, code };
  } finally {
    process.chdir(origCwd);
  }
}

/** Run against the fixture in `tmpDir`. */
function runAuditInProject(args: string[]): { stdout: string; stderr: string; code: number } {
  return runAuditIn(tmpDir, args);
}

describe("audit CLI", () => {
  test("human report groups findings by severity and ends with a score line", () => {
    writeProject(tmpDir, UNSAFE_AGENT);

    const { stdout, code } = runAuditInProject([]);
    expect(code).toBe(1);
    expect(stdout).toContain(`NDOMO AUDIT — ${tmpDir}`);
    expect(stdout).toContain("ERROR (1)");
    expect(stdout).toContain("[perm.bash-wildcard-allow] agents/alpha.md");
    // INFO/WARN groups are rendered too (counts unparsable + first-run manifest)
    expect(stdout).toContain("INFO (");
    // the score line is always the last one
    const lastLine = stdout.trimEnd().split("\n").at(-1) ?? "";
    expect(lastLine).toMatch(
      /^score: \d{1,3}\/100 — \d+ error, \d+ warn, \d+ info \(\d+ findings\)$/,
    );
    expect(lastLine).toContain("1 error");
  });

  test("exit 0 when the report has no ERROR findings", () => {
    writeProject(tmpDir, SAFE_AGENT);
    const { stdout, code } = runAuditInProject([]);
    expect(code).toBe(0);
    expect(stdout).toContain("0 error");
  });

  test("--json prints a parseable report", () => {
    writeProject(tmpDir, SAFE_AGENT);

    const { stdout, code } = runAuditInProject(["--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      projectDir: string;
      score: number;
      summary: { error: number; warn: number; info: number; total: number };
      findings: Array<{ code: string; severity: string; path: string; message: string }>;
      manifest: { path: string; baselineFound: boolean; written: boolean; tracked: number };
    };

    expect(report.projectDir).toBe(tmpDir);
    expect(report.score).toBeGreaterThanOrEqual(1);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.summary.error).toBe(0);
    expect(report.summary.total).toBe(report.findings.length);
    expect(report.findings.some((finding) => finding.severity === "INFO")).toBe(true);
    expect(report.manifest.path).toBe(MANIFEST_REL_PATH);
    expect(report.manifest.baselineFound).toBe(false);
    expect(report.manifest.written).toBe(false);
    // human report is not mixed into stdout when --json is used
    expect(stdout).not.toContain("NDOMO AUDIT");
  });

  test("--update-manifest writes the baseline (default run writes nothing)", () => {
    writeProject(tmpDir, SAFE_AGENT);

    runAuditInProject([]);
    expect(existsSync(join(tmpDir, MANIFEST_REL_PATH))).toBe(false);

    const { stdout, code } = runAuditInProject(["--update-manifest"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`manifest: ${MANIFEST_REL_PATH}`);
    expect(stdout).toContain("written");
    expect(existsSync(join(tmpDir, MANIFEST_REL_PATH))).toBe(true);

    const stored = JSON.parse(readFileSync(join(tmpDir, MANIFEST_REL_PATH), "utf-8")) as {
      files: Record<string, string>;
    };
    expect(Object.keys(stored.files).sort()).toEqual([
      "agents/alpha.md",
      "config/ndomo.config.json",
    ]);

    // second run sees the baseline and reports it in JSON
    const json = JSON.parse(runAuditInProject(["--json"]).stdout) as {
      manifest: { baselineFound: boolean; written: boolean };
    };
    expect(json.manifest).toMatchObject({ baselineFound: true, written: false });
  });

  test("--help prints usage and exits 0; an unknown flag exits 1", () => {
    writeProject(tmpDir, SAFE_AGENT);

    const help = runAuditInProject(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage:");
    expect(help.stdout).toContain("--update-manifest");
    expect(help.stdout).toContain("Exit codes:");

    const unknown = runAuditInProject(["--wat"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('error: unknown flag "--wat"');
    expect(unknown.stdout).toBe("");
  });

  test("no project root in the cwd chain → stderr error, exit 1", () => {
    const orphan = mkdtempSync(join(tmpdir(), "ndomo-cli-audit-noroot-"));
    try {
      mkdirSync(join(orphan, "empty"), { recursive: true });
      const result = runAuditIn(join(orphan, "empty"), []);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ndomo project root not found");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});
