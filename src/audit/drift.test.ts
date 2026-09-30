/**
 * Tests for src/audit — the self-audit checks (drift, permissions, counts,
 * config, manifest) plus the `runAudit` runner.
 *
 * Every fixture is a REAL mini projectDir written to a temp dir (`mkdtemp`)
 * with the marker layout the audit reads (`agents/`, `skills/`, `src/`,
 * `config/`, `docs/`) — no mocks, no spies: the checks do plain `fs` reads, so
 * files are the only honest test double.
 *
 * Coverage:
 *  - frontmatter: scalars, quotes, nested permission block, missing fence
 *  - drift:       match / mismatch INFO / missing-file WARN / missing-preset WARN
 *  - permissions: bash wildcard allow ERROR, read-only write ERROR,
 *                 dangerous prefix WARN, missing block WARN
 *  - counts:      documented claim ≠ reality → count.mismatch (+ unparsable INFO)
 *  - config:      invalid JSON ERROR, unknown key WARN, clean file → no finding
 *  - manifest:    first-run INFO, modified/added/removed, updateManifest
 *                 re-baseline, default run performs ZERO writes
 *  - runner:      report shape, deterministic ordering, score formula
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkConfig,
  checkCounts,
  checkDrift,
  checkManifest,
  checkPermissions,
  listAgentIds,
  MANIFEST_REL_PATH,
  parseFrontmatter,
  runAudit,
} from "./index.ts";

/** Marker dirs every fixture project gets (the audit's project root shape). */
const MARKERS = ["agents", "skills", "config", "src", "docs"] as const;

/** Temp dirs created by the current test — removed in `afterEach`. */
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ProjectFixture {
  /** `agents/<name>` → file content. */
  agents?: Record<string, string>;
  /** `skills/<rel path>` → file content (sub-dirs are created as needed). */
  skills?: Record<string, string>;
  /** Raw content of `config/ndomo.config.json` (omitted → no file). */
  config?: string;
  /** Raw content of `src/plugin.ts` (omitted → no file). */
  plugin?: string;
  /** Raw content of `README.md` (omitted → no file). */
  readme?: string;
  /** `docs/<name>` → file content. */
  docs?: Record<string, string>;
}

/** Write a real mini project into a fresh temp dir and return its path. */
function makeProject(fixture: ProjectFixture): string {
  const dir = mkdtempSync(join(tmpdir(), "ndomo-audit-"));
  tmpDirs.push(dir);
  for (const marker of MARKERS) {
    mkdirSync(join(dir, marker), { recursive: true });
  }
  for (const [name, content] of Object.entries(fixture.agents ?? {})) {
    writeFileSync(join(dir, "agents", name), content, "utf-8");
  }
  for (const [rel, content] of Object.entries(fixture.skills ?? {})) {
    const abs = join(dir, "skills", rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  if (fixture.config !== undefined) {
    writeFileSync(join(dir, "config", "ndomo.config.json"), fixture.config, "utf-8");
  }
  if (fixture.plugin !== undefined) {
    writeFileSync(join(dir, "src", "plugin.ts"), fixture.plugin, "utf-8");
  }
  if (fixture.readme !== undefined) {
    writeFileSync(join(dir, "README.md"), fixture.readme, "utf-8");
  }
  for (const [name, content] of Object.entries(fixture.docs ?? {})) {
    writeFileSync(join(dir, "docs", name), content, "utf-8");
  }
  return dir;
}

/**
 * Build an agent `.md` file.
 *
 * @param frontmatter top-level `key: value` pairs (order preserved)
 * @param permission  raw, ALREADY INDENTED `permission:` block body; omit the
 *                    block entirely when `undefined`
 */
function agentFile(frontmatter: Record<string, string>, permission?: string): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${value}`);
  }
  if (permission !== undefined) lines.push("permission:", permission);
  lines.push("---", "", "Agent body.");
  return lines.join("\n");
}

/** Valid config JSON with one preset covering `alpha` only. */
function presetConfig(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    preset: "default",
    presets: { default: { alpha: { model: "model-a", temperature: 0.3 } } },
    ...extra,
  });
}

/** Parsed config of a fixture (fails loudly when the fixture is invalid). */
function configOf(dir: string): Record<string, unknown> {
  const config = checkConfig(dir).config;
  if (config === null) throw new Error("fixture config did not parse");
  return config;
}

describe("audit frontmatter parse", () => {
  test("parses scalars, quoted values and the nested permission block", () => {
    const fm = parseFrontmatter(
      [
        "---",
        "model: opencode-go/mimo-v2.6-flash",
        "temperature: 0.3",
        "mode: primary",
        'description: "Caveman: full (default)"',
        "permission:",
        "  edit: deny",
        "  bash:",
        '    "*": ask',
        '    "git status*": allow',
        "---",
        "",
        "# body",
      ].join("\n"),
    );

    expect(fm.present).toBe(true);
    expect(fm.scalars).toEqual({
      model: "opencode-go/mimo-v2.6-flash",
      temperature: "0.3",
      mode: "primary",
      description: "Caveman: full (default)",
    });
    expect(fm.permission).toEqual({
      edit: "deny",
      bash: { "*": "ask", "git status*": "allow" },
    });
  });

  test("file without a fence is not frontmatter", () => {
    const fm = parseFrontmatter("# plain doc\nmodel: nope\n");
    expect(fm.present).toBe(false);
    expect(fm.scalars).toEqual({});
    expect(fm.permission).toBeNull();
  });

  test("blank lines and full-line comments are ignored, inline # kept", () => {
    const fm = parseFrontmatter(
      ["---", "# leading comment", "", "model: a # inline note", "---", ""].join("\n"),
    );
    expect(fm.scalars).toEqual({ model: "a # inline note" });
  });
});

describe("audit drift check", () => {
  const AGENTS = { "alpha.md": agentFile({ model: "model-a", temperature: "0.3" }) };

  test("frontmatter matching the preset → no findings", () => {
    const dir = makeProject({ config: presetConfig(), agents: AGENTS });
    expect(checkDrift(dir, configOf(dir), "default")).toEqual([]);
  });

  test("frontmatter differing from the preset → drift.field INFO", () => {
    const dir = makeProject({
      config: presetConfig(),
      agents: { "alpha.md": agentFile({ model: "model-b", temperature: "0.3" }) },
    });

    const findings = checkDrift(dir, configOf(dir), "default");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "drift.field",
      severity: "INFO",
      path: "agents/alpha.md",
      detail: { agent: "alpha", field: "model", frontmatter: "model-b", preset: "model-a" },
    });
  });

  test("temperature compares verbatim: '0.3' clean, '0.30' is drift", () => {
    const clean = makeProject({
      config: presetConfig(),
      agents: { "alpha.md": agentFile({ model: "model-a", temperature: "0.3" }) },
    });
    expect(checkDrift(clean, configOf(clean), "default")).toEqual([]);

    // normalize() is LEXICAL (see drift.ts): the preset renders "0.3", so a
    // file holding "0.30" is a file the next sync WILL rewrite → drift.
    const reRendered = makeProject({
      config: presetConfig(),
      agents: { "alpha.md": agentFile({ model: "model-a", temperature: "0.30" }) },
    });
    const findings = checkDrift(reRendered, configOf(reRendered), "default");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "drift.field",
      severity: "INFO",
      detail: { field: "temperature", frontmatter: "0.30", preset: "0.3" },
    });
  });

  test("frontmatter key absent on one side is not drift", () => {
    // preset declares temperature too, but the file has no `temperature:` key
    const dir = makeProject({
      config: presetConfig(),
      agents: { "alpha.md": agentFile({ model: "model-a" }) },
    });
    expect(checkDrift(dir, configOf(dir), "default")).toEqual([]);
  });

  test("preset agent without a file → drift.missing-file WARN", () => {
    const dir = makeProject({
      config: JSON.stringify({
        preset: "default",
        presets: {
          default: {
            alpha: { model: "model-a", temperature: 0.3 },
            ghost: { model: "model-g" },
          },
        },
      }),
      agents: AGENTS,
    });

    const findings = checkDrift(dir, configOf(dir), "default");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "drift.missing-file",
      severity: "WARN",
      path: "config/ndomo.config.json",
      detail: { preset: "default", agent: "ghost" },
    });
  });

  test("agent without a preset entry → drift.missing-preset WARN", () => {
    const dir = makeProject({
      config: presetConfig(),
      agents: { ...AGENTS, "orphan.md": agentFile({ model: "model-o" }) },
    });

    const findings = checkDrift(dir, configOf(dir), "default");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "drift.missing-preset",
      severity: "WARN",
      path: "agents/orphan.md",
      detail: { preset: "default", agent: "orphan" },
    });
  });

  test("effective preset missing from config → drift.missing-preset WARN", () => {
    const dir = makeProject({ config: presetConfig(), agents: AGENTS });
    const findings = checkDrift(dir, configOf(dir), "budget");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "drift.missing-preset",
      severity: "WARN",
      path: "config/ndomo.config.json",
      detail: { preset: "budget" },
    });
  });

  test("null config (broken file) → no drift findings", () => {
    const dir = makeProject({ config: "{ not json", agents: AGENTS });
    expect(checkConfig(dir).config).toBeNull();
    expect(checkDrift(dir, null, "default")).toEqual([]);
  });
});

describe("audit permissions check", () => {
  test("scalar bash: allow → perm.bash-wildcard-allow ERROR", () => {
    const dir = makeProject({
      agents: { "alpha.md": agentFile({ mode: "subagent" }, "  bash: allow") },
    });
    const findings = checkPermissions(dir, listAgentIds(dir), null);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "perm.bash-wildcard-allow",
      severity: "ERROR",
      path: "agents/alpha.md",
      detail: { agent: "alpha", rule: "bash: allow" },
    });
  });

  test('bash rule "*": allow → perm.bash-wildcard-allow ERROR', () => {
    const dir = makeProject({
      agents: { "alpha.md": agentFile({ mode: "subagent" }, '  bash:\n    "*": allow') },
    });
    const findings = checkPermissions(dir, listAgentIds(dir), null);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "perm.bash-wildcard-allow",
      severity: "ERROR",
      detail: { rule: '"*": allow' },
    });
  });

  test("wildcard allow on a dangerous prefix → WARN, not ERROR", () => {
    const dir = makeProject({
      agents: { "alpha.md": agentFile({ mode: "subagent" }, '  bash:\n    "rm *": allow') },
    });
    const findings = checkPermissions(dir, listAgentIds(dir), null);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "perm.bash-wildcard-allow",
      severity: "WARN",
      detail: { rule: "rm *" },
    });
  });

  test("read-only agent (edit denies *) with write: allow → ERROR", () => {
    const dir = makeProject({
      agents: { "alpha.md": agentFile({ mode: "subagent" }, "  edit: deny\n  write: allow") },
    });
    const findings = checkPermissions(dir, listAgentIds(dir), null);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "perm.readonly-write",
      severity: "ERROR",
      path: "agents/alpha.md",
      detail: { agent: "alpha" },
    });
  });

  test("scoped write under a denied * (not catch-all) is not flagged", () => {
    const dir = makeProject({
      agents: {
        "alpha.md": agentFile({ mode: "subagent" }, '  edit:\n    "*": deny\n  write: "docs/**"'),
      },
    });
    expect(checkPermissions(dir, listAgentIds(dir), null)).toEqual([]);
  });

  test("primary agent without permission block → perm.missing-block WARN", () => {
    const dir = makeProject({ agents: { "alpha.md": agentFile({ mode: "primary" }) } });
    const findings = checkPermissions(dir, listAgentIds(dir), null);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "perm.missing-block",
      severity: "WARN",
      path: "agents/alpha.md",
      detail: { agent: "alpha" },
    });
  });

  test("primary via config agentRouting is flagged too; non-primary is clean", () => {
    const dir = makeProject({
      config: JSON.stringify({ agentRouting: { alpha: { mode: "primary" } } }),
      agents: { "alpha.md": agentFile({ mode: "subagent" }) },
    });
    const config = configOf(dir);
    const findings = checkPermissions(dir, listAgentIds(dir), config);
    expect(findings.map((finding) => finding.code)).toEqual(["perm.missing-block"]);
  });
});

describe("audit counts check", () => {
  test("documented claim ≠ real value → count.mismatch WARN", () => {
    const dir = makeProject({
      readme: "ndomo exposes 3 tools are exposed by the plugin.",
      plugin: "export const tools = [{ tool({ name: 'a' }) }, { tool({ name: 'b' }) }];",
    });

    const findings = checkCounts(dir, null);
    const mismatch = findings.filter((finding) => finding.code === "count.mismatch");
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatchObject({
      severity: "WARN",
      path: "README.md",
      detail: { subject: "MCP tools", claimed: 3, actual: 2 },
    });
  });

  test("claim matching reality → no count.mismatch", () => {
    const dir = makeProject({
      readme: "ndomo exposes 2 tools are exposed by the plugin.",
      plugin: "export const tools = [{ tool({ name: 'a' }) }, { tool({ name: 'b' }) }];",
    });

    const findings = checkCounts(dir, null);
    expect(findings.filter((finding) => finding.code === "count.mismatch")).toEqual([]);
  });

  test("unreadable doc → count.unparsable INFO (real value reported)", () => {
    const dir = makeProject({ agents: { "alpha.md": agentFile({ mode: "subagent" }) } });
    const findings = checkCounts(dir, null);
    const unparsable = findings.filter((finding) => finding.code === "count.unparsable");
    expect(unparsable.length).toBeGreaterThan(0);
    expect(unparsable.every((finding) => finding.severity === "INFO")).toBe(true);
    // docs/agents.md is missing → the "agents" claim reports the real count
    const agentsClaim = unparsable.find((finding) => finding.path === "docs/agents.md");
    expect(agentsClaim?.detail).toMatchObject({ subject: "agents", actual: 1 });
  });

  test("docs/agents.md total + subagent echoes are verified", () => {
    const dir = makeProject({
      agents: { "alpha.md": agentFile({ mode: "subagent" }) },
      docs: { "agents.md": "# 5 agents:\n\nSee the 4 subagents below.\n" },
    });

    const mismatches = checkCounts(dir, null).filter(
      (finding) => finding.code === "count.mismatch" && finding.path === "docs/agents.md",
    );
    expect(mismatches.map((finding) => finding.detail)).toEqual([
      { subject: "agents", claimed: 5, actual: 1 },
      { subject: "subagents", claimed: 4, actual: 1 },
    ]);
  });
});

describe("audit config check", () => {
  test("missing config file → config.invalid-json ERROR", () => {
    const dir = makeProject({});
    const result = checkConfig(dir);
    expect(result.config).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      code: "config.invalid-json",
      severity: "ERROR",
      path: "config/ndomo.config.json",
    });
    expect(result.findings[0]?.message).toContain("not found");
  });

  test("unparsable JSON → config.invalid-json ERROR", () => {
    const dir = makeProject({ config: "{ not json" });
    const result = checkConfig(dir);
    expect(result.config).toBeNull();
    expect(result.findings[0]).toMatchObject({ code: "config.invalid-json", severity: "ERROR" });
    expect(result.findings[0]?.message).toContain("invalid JSON");
  });

  test("non-object root → config.invalid-json ERROR", () => {
    const dir = makeProject({ config: "[]" });
    const result = checkConfig(dir);
    expect(result.config).toBeNull();
    expect(result.findings[0]?.message).toContain("root must be a JSON object");
  });

  test("unknown top-level key → config.unknown-key WARN, known keys clean", () => {
    const dirty = makeProject({ config: presetConfig({ totallyUnknown: true }) });
    const dirtyResult = checkConfig(dirty);
    expect(dirtyResult.findings).toHaveLength(1);
    expect(dirtyResult.findings[0]).toMatchObject({
      code: "config.unknown-key",
      severity: "WARN",
      detail: { key: "totallyUnknown" },
    });
    expect(dirtyResult.config).not.toBeNull();

    const clean = makeProject({ config: presetConfig() });
    expect(checkConfig(clean).findings).toEqual([]);
  });
});

describe("audit manifest check", () => {
  const SKILLS = { "noop/SKILL.md": "# noop skill\n" };

  test("first run → manifest.first-run INFO, no file written by default", () => {
    const dir = makeProject({ config: presetConfig(), agents: {}, skills: SKILLS });
    const result = checkManifest(dir, false);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      code: "manifest.first-run",
      severity: "INFO",
      path: MANIFEST_REL_PATH,
    });
    expect(result.outcome).toMatchObject({ baselineFound: false, written: false, tracked: 2 });
    expect(existsSync(join(dir, MANIFEST_REL_PATH))).toBe(false);
  });

  test("updateManifest writes the baseline; the next run diffs clean", () => {
    const dir = makeProject({ config: presetConfig(), agents: {}, skills: SKILLS });
    const written = checkManifest(dir, true);

    expect(written.outcome).toMatchObject({ baselineFound: false, written: true, tracked: 2 });
    expect(existsSync(join(dir, MANIFEST_REL_PATH))).toBe(true);

    const stored = JSON.parse(readFileSync(join(dir, MANIFEST_REL_PATH), "utf-8")) as {
      version: number;
      files: Record<string, string>;
    };
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.files).sort()).toEqual([
      "config/ndomo.config.json",
      "skills/noop/SKILL.md",
    ]);
    expect(Object.values(stored.files).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);

    const second = checkManifest(dir, false);
    expect(second.outcome.baselineFound).toBe(true);
    expect(second.findings).toEqual([]);
  });

  test("modified, added and removed files are all reported", () => {
    const dir = makeProject({
      config: presetConfig(),
      agents: { "alpha.md": agentFile({ model: "model-a" }) },
      skills: SKILLS,
    });
    checkManifest(dir, true);

    // modified
    writeFileSync(join(dir, "agents", "alpha.md"), agentFile({ model: "model-z" }), "utf-8");
    // added
    writeFileSync(join(dir, "agents", "beta.md"), agentFile({ model: "model-b" }), "utf-8");
    // removed
    rmSync(join(dir, "skills", "noop", "SKILL.md"));

    const result = checkManifest(dir, false);
    expect(result.findings.map((finding) => `${finding.code}:${finding.severity}`).sort()).toEqual([
      "manifest.added:INFO",
      "manifest.modified:WARN",
      "manifest.removed:WARN",
    ]);
  });

  test("re-baselining after the change clears the diff findings", () => {
    const dir = makeProject({
      config: presetConfig(),
      agents: { "alpha.md": agentFile({ model: "model-a" }) },
      skills: SKILLS,
    });
    checkManifest(dir, true);
    writeFileSync(join(dir, "agents", "alpha.md"), agentFile({ model: "model-z" }), "utf-8");
    expect(checkManifest(dir, false).findings.map((f) => f.code)).toEqual(["manifest.modified"]);

    checkManifest(dir, true);
    expect(checkManifest(dir, false).findings).toEqual([]);
  });
});

describe("runAudit runner", () => {
  test("report-only by default: manifest is never written without the flag", () => {
    const dir = makeProject({ config: presetConfig(), agents: {}, skills: {} });

    const report = runAudit({ projectDir: dir });
    expect(report.manifest.written).toBe(false);
    expect(existsSync(join(dir, MANIFEST_REL_PATH))).toBe(false);
    expect(report.summary.error).toBe(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.score).toBeGreaterThanOrEqual(1);
  });

  test("score follows 100 − 10·ERROR − 4·WARN − 1·INFO (floor 1)", () => {
    const dir = makeProject({
      config: presetConfig(),
      agents: { "alpha.md": agentFile({ mode: "primary" }, "  bash: allow") },
    });

    const report = runAudit({ projectDir: dir });
    expect(report.summary.error).toBeGreaterThan(0);
    const { error, warn, info } = report.summary;
    expect(report.score).toBe(Math.max(1, 100 - 10 * error - 4 * warn - 1 * info));
    expect(report.summary.total).toBe(report.findings.length);
  });

  test("findings are ordered ERROR → WARN → INFO and identical across runs", () => {
    const dir = makeProject({
      config: presetConfig(),
      agents: { "alpha.md": agentFile({ mode: "primary" }, "  bash: allow") },
    });

    const first = runAudit({ projectDir: dir });
    const second = runAudit({ projectDir: dir });

    expect(first.findings).toEqual(second.findings);
    expect(first.score).toBe(second.score);
    const rank = { ERROR: 0, WARN: 1, INFO: 2 } as const;
    const order = first.findings.map((finding) => rank[finding.severity]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("updateManifest: true re-baselines the manifest", () => {
    const dir = makeProject({ config: presetConfig(), agents: {}, skills: {} });
    runAudit({ projectDir: dir, updateManifest: true });
    expect(existsSync(join(dir, MANIFEST_REL_PATH))).toBe(true);

    const report = runAudit({ projectDir: dir });
    expect(report.manifest.baselineFound).toBe(true);
    expect(report.findings.some((finding) => finding.code === "manifest.first-run")).toBe(false);
  });
});
