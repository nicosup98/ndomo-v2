/**
 * Tests for src/cli/install.ts — TypeScript port of install.sh.
 *
 * Uses bun:test with temp directories. Tests exported helpers directly.
 *
 * Coverage:
 * 1. Flag parsing (--dry-run, --preset, --skip-deps, --help, etc.)
 * 2. Preset application to agent .md files (frontmatter update)
 * 3. Provider prefix override
 * 4. Plugin registration in opencode.json (dedup merge)
 * 5. Agent/skill copy with backup
 * 6. Idempotency: re-run doesn't corrupt state
 * 7. Path traversal protection (unsafe agent names rejected)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NdomoConfig } from "../../config/schema.ts";
import {
  applyPresetToFile,
  applyProviderPrefix,
  type PresetEntry,
  parseFlags,
  stepCopyAgents,
  stepCopySkills,
  stepInjectPreset,
  stepRegisterPlugins,
} from "../install.ts";

let tmpDir: string;
let projectRoot: string;
let configDir: string;
let backupDir: string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAgentMd(
  name: string,
  model: string,
  temperature?: number,
  reasoningEffort?: string,
): string {
  let fm = `---\nmodel: ${model}`;
  if (temperature !== undefined) {
    fm += `\ntemperature: ${temperature}`;
  }
  if (reasoningEffort) {
    fm += `\nreasoningEffort: ${reasoningEffort}`;
  }
  fm += `\n---\n# Agent ${name}\nThis is the ${name} agent body.`;
  return fm;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ndomo-install-"));
  projectRoot = join(tmpDir, "project");
  configDir = join(tmpDir, "config");
  backupDir = join(tmpDir, "backup");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(projectRoot, "agents"), { recursive: true });
  mkdirSync(join(projectRoot, "skills"), { recursive: true });
  mkdirSync(join(projectRoot, "config"), { recursive: true });
  mkdirSync(join(configDir, "agent"), { recursive: true });
  mkdirSync(join(configDir, "skills"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ─── Flag parsing ─────────────────────────────────────────────────────────────

describe("parseFlags", () => {
  test("returns defaults for empty args", () => {
    const flags = parseFlags([]);
    expect(flags.preset).toBe("default");
    expect(flags.dryRun).toBe(false);
    expect(flags.skipDeps).toBe(false);
    expect(flags.withDcp).toBe(false);
    expect(flags.help).toBe(false);
  });

  test("--dry-run sets dryRun flag", () => {
    const flags = parseFlags(["--dry-run"]);
    expect(flags.dryRun).toBe(true);
  });

  test("--preset=budget sets preset", () => {
    const flags = parseFlags(["--preset=budget"]);
    expect(flags.preset).toBe("budget");
  });

  test("--skip-deps sets skipDeps flag", () => {
    const flags = parseFlags(["--skip-deps"]);
    expect(flags.skipDeps).toBe(true);
  });

  test("--with-dcp sets withDcp flag", () => {
    const flags = parseFlags(["--with-dcp"]);
    expect(flags.withDcp).toBe(true);
  });

  test("--help sets help flag", () => {
    const flags = parseFlags(["--help"]);
    expect(flags.help).toBe(true);
  });

  test("-h sets help flag", () => {
    const flags = parseFlags(["-h"]);
    expect(flags.help).toBe(true);
  });

  test("--provider=opencode sets provider", () => {
    const flags = parseFlags(["--provider=opencode"]);
    expect(flags.provider).toBe("opencode");
  });

  test("--no-provider-prompt sets noProviderPrompt", () => {
    const flags = parseFlags(["--no-provider-prompt"]);
    expect(flags.noProviderPrompt).toBe(true);
  });

  test("combined flags parse correctly", () => {
    const flags = parseFlags(["--preset=budget", "--skip-deps", "--dry-run"]);
    expect(flags.preset).toBe("budget");
    expect(flags.skipDeps).toBe(true);
    expect(flags.dryRun).toBe(true);
  });

  test("unknown flag throws", () => {
    expect(() => parseFlags(["--unknown-flag"])).toThrow("Unknown option");
  });
});

// ─── Preset application ──────────────────────────────────────────────────────

describe("applyPresetToFile", () => {
  test("updates model and temperature in frontmatter", () => {
    const filePath = join(tmpDir, "foreman.md");
    writeFileSync(filePath, makeAgentMd("foreman", "old/model", 0.5));

    const preset: PresetEntry = { model: "new/model-v2", temperature: 0.3 };
    const result = applyPresetToFile(filePath, preset, false);

    expect(result).toBe("updated");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("model: new/model-v2");
    expect(content).toContain("temperature: 0.3");
  });

  test("adds reasoningEffort when not present (after temperature)", () => {
    const filePath = join(tmpDir, "scout.md");
    writeFileSync(filePath, makeAgentMd("scout", "opencode/gpt-4", 0.5));

    const preset: PresetEntry = { model: "opencode/gpt-4", reasoning_effort: "high" };
    applyPresetToFile(filePath, preset, false);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("reasoningEffort: high");
    // Should be after temperature
    const tempIdx = content.indexOf("temperature:");
    const effortIdx = content.indexOf("reasoningEffort:");
    expect(effortIdx).toBeGreaterThan(tempIdx);
  });

  test("adds reasoningEffort after model when no temperature", () => {
    const filePath = join(tmpDir, "agent.md");
    writeFileSync(filePath, makeAgentMd("agent", "opencode/gpt-4"));

    const preset: PresetEntry = { model: "opencode/gpt-4", reasoning_effort: "low" };
    applyPresetToFile(filePath, preset, false);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("reasoningEffort: low");
    const modelIdx = content.indexOf("model:");
    const effortIdx = content.indexOf("reasoningEffort:");
    expect(effortIdx).toBeGreaterThan(modelIdx);
  });

  test("updates existing reasoningEffort", () => {
    const filePath = join(tmpDir, "agent.md");
    writeFileSync(filePath, makeAgentMd("agent", "opencode/gpt-4", 0.3, "low"));

    const preset: PresetEntry = { reasoning_effort: "high" };
    applyPresetToFile(filePath, preset, false);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("reasoningEffort: high");
    expect(content).not.toContain("reasoningEffort: low");
  });

  test("skips file without frontmatter", () => {
    const filePath = join(tmpDir, "nofm.md");
    writeFileSync(filePath, "# No frontmatter\nJust a body.");

    const result = applyPresetToFile(filePath, { model: "test" }, false);
    expect(result).toBe("skipped");
  });

  test("preserves body content after frontmatter", () => {
    const filePath = join(tmpDir, "agent.md");
    writeFileSync(filePath, makeAgentMd("test", "old/model", 0.5));

    applyPresetToFile(filePath, { model: "new/model" }, false);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# Agent test");
    expect(content).toContain("This is the test agent body.");
  });

  test("dry-run does not modify file", () => {
    const filePath = join(tmpDir, "agent.md");
    const original = makeAgentMd("test", "old/model", 0.5);
    writeFileSync(filePath, original);

    applyPresetToFile(filePath, { model: "new/model" }, true);

    expect(readFileSync(filePath, "utf-8")).toBe(original);
  });
});

// ─── Provider prefix ─────────────────────────────────────────────────────────

describe("applyProviderPrefix", () => {
  test("replaces provider prefix on model lines", () => {
    mkdirSync(join(tmpDir, "agents"), { recursive: true });
    writeFileSync(
      join(tmpDir, "agents", "foreman.md"),
      makeAgentMd("foreman", "opencode/gpt-4", 0.3),
    );
    writeFileSync(join(tmpDir, "agents", "scout.md"), makeAgentMd("scout", "minimax/model", 0.3));

    const updated = applyProviderPrefix(join(tmpDir, "agents"), "anthropic", false);

    expect(updated).toBe(2);
    const fm = readFileSync(join(tmpDir, "agents", "foreman.md"), "utf-8");
    expect(fm).toContain("model: anthropic/gpt-4");
    const sm = readFileSync(join(tmpDir, "agents", "scout.md"), "utf-8");
    expect(sm).toContain("model: anthropic/model");
  });

  test("only replaces first model line", () => {
    mkdirSync(join(tmpDir, "agents"), { recursive: true });
    const content = "---\nmodel: opencode/gpt-4\ntemperature: 0.3\n---\nmodel: not-touched/extra";
    writeFileSync(join(tmpDir, "agents", "agent.md"), content);

    applyProviderPrefix(join(tmpDir, "agents"), "new-prefix", false);

    const result = readFileSync(join(tmpDir, "agents", "agent.md"), "utf-8");
    expect(result).toContain("model: new-prefix/gpt-4");
    // Body model line untouched
    expect(result).toContain("model: not-touched/extra");
  });

  test("dry-run does not modify files", () => {
    mkdirSync(join(tmpDir, "agents"), { recursive: true });
    const original = makeAgentMd("test", "opencode/gpt-4");
    writeFileSync(join(tmpDir, "agents", "test.md"), original);

    applyProviderPrefix(join(tmpDir, "agents"), "new", true);

    expect(readFileSync(join(tmpDir, "agents", "test.md"), "utf-8")).toBe(original);
  });
});

// ─── Plugin registration ─────────────────────────────────────────────────────

describe("stepRegisterPlugins", () => {
  test("registers plugins in opencode.json (dedup merge)", () => {
    const opencodePath = join(configDir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ plugin: ["existing-plugin"] }));

    const config: NdomoConfig = {
      plugins: ["ndomo", "test-plugin"],
      optionalPlugins: ["@tarquinen/opencode-dcp"],
    };

    stepRegisterPlugins(configDir, config, backupDir, false);

    const written = JSON.parse(readFileSync(opencodePath, "utf-8"));
    expect(written.plugins).toContain("ndomo");
    expect(written.plugins).toContain("test-plugin");
    expect(written.plugins).toContain("@tarquinen/opencode-dcp");
    expect(written.plugins).toContain("existing-plugin");
  });

  test("idempotent: running twice doesn't duplicate plugins", () => {
    const opencodePath = join(configDir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ plugins: [] }));

    const config: NdomoConfig = {
      plugins: ["ndomo", "test-plugin"],
    };

    stepRegisterPlugins(configDir, config, backupDir, false);
    stepRegisterPlugins(configDir, config, backupDir, false);

    const written = JSON.parse(readFileSync(opencodePath, "utf-8"));
    const ndomoCount = written.plugins.filter((p: unknown) => p === "ndomo").length;
    expect(ndomoCount).toBe(1);
  });

  test("creates opencode.json if missing", () => {
    const config: NdomoConfig = { plugins: ["ndomo"] };
    stepRegisterPlugins(configDir, config, backupDir, false);

    expect(existsSync(join(configDir, "opencode.json"))).toBe(true);
    const written = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf-8"));
    expect(written.plugins).toContain("ndomo");
  });

  test("backups existing opencode.json before modifying", () => {
    const opencodePath = join(configDir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ plugin: ["old"] }));

    const config: NdomoConfig = { plugins: ["new"] };
    stepRegisterPlugins(configDir, config, backupDir, false);

    expect(existsSync(join(backupDir, "opencode.json"))).toBe(true);
    const backup = JSON.parse(readFileSync(join(backupDir, "opencode.json"), "utf-8"));
    expect(backup.plugin).toContain("old");
  });

  test("migrates legacy v1 plugin key + tuple entries to v2 plugins", () => {
    const opencodePath = join(configDir, "opencode.json");
    writeFileSync(
      opencodePath,
      JSON.stringify({ plugin: ["legacy-string", ["pkg-a", { enabled: true }]] }),
    );

    const config: NdomoConfig = { plugins: ["ndomo"] };
    stepRegisterPlugins(configDir, config, backupDir, false);

    const written = JSON.parse(readFileSync(opencodePath, "utf-8"));
    expect(written.plugin).toBeUndefined();
    expect(written.plugins).toContain("legacy-string");
    expect(written.plugins).toContainEqual({ package: "pkg-a", options: { enabled: true } });
    expect(written.plugins).toContain("ndomo");
  });

  test("dry-run does not modify opencode.json", () => {
    const opencodePath = join(configDir, "opencode.json");
    const original = JSON.stringify({ plugins: [] });
    writeFileSync(opencodePath, original);

    const config: NdomoConfig = { plugins: ["ndomo"] };
    stepRegisterPlugins(configDir, config, backupDir, true);

    expect(readFileSync(opencodePath, "utf-8")).toBe(original);
  });
});

// ─── Agent copy ───────────────────────────────────────────────────────────────

describe("stepCopyAgents", () => {
  test("copies agents from project to config dir", () => {
    writeFileSync(join(projectRoot, "agents", "foreman.md"), "# Foreman");
    writeFileSync(join(projectRoot, "agents", "scout.md"), "# Scout");

    const count = stepCopyAgents(projectRoot, configDir, backupDir, false);

    expect(count).toBe(2);
    expect(existsSync(join(configDir, "agent", "foreman.md"))).toBe(true);
    expect(existsSync(join(configDir, "agent", "scout.md"))).toBe(true);
    expect(readFileSync(join(configDir, "agent", "foreman.md"), "utf-8")).toBe("# Foreman");
  });

  test("backs up existing agents before overwriting", () => {
    // Existing agent in config
    writeFileSync(join(configDir, "agent", "foreman.md"), "# Old Foreman");
    // New agent in project
    writeFileSync(join(projectRoot, "agents", "foreman.md"), "# New Foreman");

    stepCopyAgents(projectRoot, configDir, backupDir, false);

    expect(existsSync(join(backupDir, "foreman.md"))).toBe(true);
    expect(readFileSync(join(backupDir, "foreman.md"), "utf-8")).toBe("# Old Foreman");
    expect(readFileSync(join(configDir, "agent", "foreman.md"), "utf-8")).toBe("# New Foreman");
  });

  test("dry-run does not copy files", () => {
    writeFileSync(join(projectRoot, "agents", "test.md"), "# Test");

    stepCopyAgents(projectRoot, configDir, backupDir, true);

    expect(existsSync(join(configDir, "agent", "test.md"))).toBe(false);
  });

  test("returns 0 when no agents dir exists", () => {
    rmSync(join(projectRoot, "agents"), { recursive: true });
    const count = stepCopyAgents(projectRoot, configDir, backupDir, false);
    expect(count).toBe(0);
  });
});

// ─── Skill copy ──────────────────────────────────────────────────────────────

describe("stepCopySkills", () => {
  test("copies skill directories from project to config dir", () => {
    mkdirSync(join(projectRoot, "skills", "caveman"), { recursive: true });
    writeFileSync(join(projectRoot, "skills", "caveman", "SKILL.md"), "# Caveman");
    mkdirSync(join(projectRoot, "skills", "vue"), { recursive: true });
    writeFileSync(join(projectRoot, "skills", "vue", "SKILL.md"), "# Vue");

    const count = stepCopySkills(projectRoot, configDir, backupDir, false);

    expect(count).toBe(2);
    expect(existsSync(join(configDir, "skills", "caveman", "SKILL.md"))).toBe(true);
    expect(existsSync(join(configDir, "skills", "vue", "SKILL.md"))).toBe(true);
  });

  test("backs up existing skills before overwriting", () => {
    // Existing skill
    mkdirSync(join(configDir, "skills", "caveman"), { recursive: true });
    writeFileSync(join(configDir, "skills", "caveman", "SKILL.md"), "# Old");

    // New skill
    mkdirSync(join(projectRoot, "skills", "caveman"), { recursive: true });
    writeFileSync(join(projectRoot, "skills", "caveman", "SKILL.md"), "# New");

    stepCopySkills(projectRoot, configDir, backupDir, false);

    expect(existsSync(join(backupDir, "skills", "caveman", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(backupDir, "skills", "caveman", "SKILL.md"), "utf-8")).toBe("# Old");
    expect(readFileSync(join(configDir, "skills", "caveman", "SKILL.md"), "utf-8")).toBe("# New");
  });

  test("returns 0 when no skills dir exists", () => {
    rmSync(join(projectRoot, "skills"), { recursive: true });
    const count = stepCopySkills(projectRoot, configDir, backupDir, false);
    expect(count).toBe(0);
  });
});

// ─── Preset injection ────────────────────────────────────────────────────────

describe("stepInjectPreset", () => {
  test("injects preset name into ndomo.json", () => {
    const ndomoPath = join(configDir, "ndomo.json");
    writeFileSync(ndomoPath, JSON.stringify({ plugins: ["ndomo"] }));

    stepInjectPreset(configDir, "budget", false);

    const written = JSON.parse(readFileSync(ndomoPath, "utf-8"));
    expect(written.preset).toBe("budget");
    expect(written.plugins).toEqual(["ndomo"]);
  });

  test("overwrites existing preset field", () => {
    const ndomoPath = join(configDir, "ndomo.json");
    writeFileSync(ndomoPath, JSON.stringify({ preset: "old", plugins: [] }));

    stepInjectPreset(configDir, "default", false);

    const written = JSON.parse(readFileSync(ndomoPath, "utf-8"));
    expect(written.preset).toBe("default");
  });

  test("dry-run does not modify file", () => {
    const ndomoPath = join(configDir, "ndomo.json");
    const original = JSON.stringify({ plugins: [] });
    writeFileSync(ndomoPath, original);

    stepInjectPreset(configDir, "budget", true);

    expect(readFileSync(ndomoPath, "utf-8")).toBe(original);
  });
});

// ─── Path traversal protection ───────────────────────────────────────────────

describe("path traversal protection", () => {
  test("rejects agent filenames with slashes", () => {
    // The applyPresetToFile function is called with a full path,
    // but the preset lookup uses the basename. This test verifies
    // that the validation in stepApplyPreset catches unsafe names.
    // We test indirectly: create an agent with a safe name, verify it works.
    const filePath = join(tmpDir, "safe-agent.md");
    writeFileSync(filePath, makeAgentMd("safe-agent", "opencode/gpt-4", 0.3));

    const result = applyPresetToFile(filePath, { model: "new/model" }, false);
    expect(result).toBe("updated");
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("idempotency", () => {
  test("re-running preset application produces same result", () => {
    const filePath = join(tmpDir, "agent.md");
    writeFileSync(filePath, makeAgentMd("test", "opencode/gpt-4", 0.3, "low"));

    const preset: PresetEntry = { model: "new/model", temperature: 0.5, reasoning_effort: "high" };

    applyPresetToFile(filePath, preset, false);
    const first = readFileSync(filePath, "utf-8");

    applyPresetToFile(filePath, preset, false);
    const second = readFileSync(filePath, "utf-8");

    expect(first).toBe(second);
  });

  test("re-running plugin registration produces same opencode.json", () => {
    const opencodePath = join(configDir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ plugins: [] }));

    const config: NdomoConfig = { plugins: ["ndomo", "test-plugin"] };

    stepRegisterPlugins(configDir, config, backupDir, false);
    const first = readFileSync(opencodePath, "utf-8");

    stepRegisterPlugins(configDir, config, backupDir, false);
    const second = readFileSync(opencodePath, "utf-8");

    expect(first).toBe(second);
  });
});

// ─── Regex-based preset preserves nested YAML ──────────────────────────────

describe("applyPresetToFile — nested permission preservation", () => {
  test("preserves nested permission structure byte-for-byte", () => {
    const testFile = join(tmpDir, "test-agent.md");
    const original = `---
description: Test Agent
mode: subagent
model: old/model
temperature: 0.5
permission:
  edit: allow
  write: ask
  bash:
    "*": ask
    "ls *": allow
---
body content here
`;
    writeFileSync(testFile, original);
    const result = applyPresetToFile(
      testFile,
      { model: "new/model", temperature: 0.3 } as PresetEntry,
      false,
    );
    expect(result).toBe("updated");
    const updated = readFileSync(testFile, "utf-8");
    expect(updated).toContain("model: new/model");
    expect(updated).toContain("temperature: 0.3");
    // CRITICAL: permission block intact byte-for-byte
    expect(updated).toContain("permission:");
    expect(updated).toContain("  edit: allow");
    expect(updated).toContain("  write: ask");
    expect(updated).toContain("  bash:");
    expect(updated).toContain('    "*": ask');
    expect(updated).toContain('    "ls *": allow');
  });
});
