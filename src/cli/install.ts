#!/usr/bin/env bun
/**
 * ndomo install — TypeScript port of scripts/install.sh
 *
 * Installs agents, skills, and config into ~/.config/opencode/.
 * Supports preset application, plugin registration, 3-strategy package install,
 * HTTP auto-prompt, and DCP opt-in.
 *
 * @example
 * bun run src/cli/install.ts
 * bun run src/cli/install.ts --preset=budget --enable-http
 * bun run src/cli/install.ts --dry-run --skip-deps
 */

import { existsSync, mkdirSync, copyFileSync, symlinkSync, lstatSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { resolveConfigDir, type HttpConfig, type NdomoConfig } from "../config/schema.ts";

// ─── ANSI colors (no external deps) ──────────────────────────────────────────
const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const BLUE = "\x1b[0;34m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

const info = (msg: string): void => console.log(`${BLUE}[info]${NC}  ${msg}`);
const ok = (msg: string): void => console.log(`${GREEN}[ok]${NC}    ${msg}`);
const warn = (msg: string): void => console.error(`${YELLOW}[warn]${NC}  ${msg}`);
const err = (msg: string): void => console.error(`${RED}[error]${NC} ${msg}`);
const die = (msg: string): never => {
  err(msg);
  process.exit(1);
};

// ─── Path traversal protection ────────────────────────────────────────────────
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function assertSafeFilename(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

// ─── Type definitions ─────────────────────────────────────────────────────────
export type InstallFlags = {
  preset: string;
  provider: string;
  noProviderPrompt: boolean;
  withDcp: boolean;
  dryRun: boolean;
  skipDeps: boolean;
  enableHttp: boolean;
  disableHttp: boolean;
  corsOrigins: string;
  port: number;
  authRequired: boolean;
  uninstall: boolean;
  help: boolean;
};

export type PresetEntry = {
  model?: string;
  temperature?: number;
  reasoning_effort?: string;
};

// ─── Flag parsing ─────────────────────────────────────────────────────────────
export function parseFlags(args: string[]): InstallFlags {
  const flags: InstallFlags = {
    preset: "default",
    provider: "",
    noProviderPrompt: false,
    withDcp: false,
    dryRun: false,
    skipDeps: false,
    enableHttp: false,
    disableHttp: false,
    corsOrigins: "*",
    port: 4097,
    authRequired: true,
    uninstall: false,
    help: false,
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--with-dcp") {
      flags.withDcp = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--skip-deps") {
      flags.skipDeps = true;
    } else if (arg === "--enable-http") {
      flags.enableHttp = true;
    } else if (arg === "--disable-http") {
      flags.disableHttp = true;
    } else if (arg === "--no-provider-prompt") {
      flags.noProviderPrompt = true;
    } else if (arg.startsWith("--preset=")) {
      flags.preset = arg.slice("--preset=".length);
    } else if (arg.startsWith("--provider=")) {
      flags.provider = arg.slice("--provider=".length);
    } else if (arg.startsWith("--cors-origins=")) {
      flags.corsOrigins = arg.slice("--cors-origins=".length);
    } else if (arg.startsWith("--port=")) {
      const val = Number(arg.slice("--port=".length));
      if (!Number.isNaN(val) && val > 0 && val < 65536) {
        flags.port = val;
      }
    } else if (arg.startsWith("--auth-required=")) {
      flags.authRequired = arg.slice("--auth-required=".length) !== "false";
    } else if (arg === "--uninstall") {
      flags.uninstall = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg} (try --help)`);
    }
  }

  return flags;
}

// ─── Help text ────────────────────────────────────────────────────────────────
export function printHelp(): void {
  console.log(`${BOLD}ndomo installer — agent preset & provider tool${NC}

${BOLD}Usage:${NC}
  bun run src/cli/install.ts [OPTIONS]
  ndomo install [OPTIONS]

${BOLD}Options:${NC}
  --preset=NAME         Use preset from ndomo.config.json (default: "default")
  --provider=ID         Override provider prefix (e.g., opencode, anthropic)
  --no-provider-prompt  Skip interactive provider override prompt
  --with-dcp            Also install @tarquinen/opencode-dcp
  --dry-run             Print planned changes, do not write
  --skip-deps           Skip 'bun install' step
  --enable-http         Auto-enable HTTP server (writes http block to ndomo.config.json)
  --disable-http        Skip HTTP auto-prompt (default in non-TTY)
  --cors-origins=CSV    Override CORS origins (default: *)
  --port=N              Override HTTP port (default: 4097)
  --auth-required=BOOL  Override auth requirement (default: true)
  --uninstall           Run uninstaller (compat, execs scripts/uninstall.sh)
  --help, -h            Show this help

${BOLD}Environment:${NC}
  NDOMO_SKIP_PACKAGE_INSTALL=1  Skip ndomo package installation
  XDG_CONFIG_HOME               Override config directory (default: ~/.config)

${BOLD}Examples:${NC}
  bun run src/cli/install.ts                        # apply default preset
  bun run src/cli/install.ts --preset=budget        # apply budget preset
  bun run src/cli/install.ts --provider=opencode    # swap provider prefix
  bun run src/cli/install.ts --enable-http          # enable HTTP server
  bun run src/cli/install.ts --dry-run              # preview changes`);
}

// ─── Project root detection ───────────────────────────────────────────────────
export function detectProjectRoot(): string {
  // Walk up from __dirname to find package.json
  let dir = import.meta.dir;
  while (dir !== "/" && dir !== homedir()) {
    if (existsSync(join(dir, "package.json"))) {
      // Verify it's ndomo (has agents/ dir or src/cli/)
      if (existsSync(join(dir, "agents")) || existsSync(join(dir, "src", "cli"))) {
        return dir;
      }
    }
    dir = dirname(dir);
  }
  // Fallback: two levels up from src/cli/
  return join(import.meta.dir, "..", "..");
}

// ─── Step helpers ─────────────────────────────────────────────────────────────

/** Step 1: Install dependencies. */
export async function stepInstallDeps(projectRoot: string, dryRun: boolean): Promise<void> {
  info("Installing dependencies...");
  if (dryRun) {
    info("[dry-run] would run: bun install --frozen-lockfile");
    return;
  }
  const proc = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    // Fallback to non-frozen
    warn("frozen lockfile failed, retrying without --frozen-lockfile...");
    const proc2 = Bun.spawn(["bun", "install"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc2.exited;
    if (proc2.exitCode !== 0) {
      die("bun install failed");
    }
  }
  ok("Dependencies installed");
}

/** Step 2: Build TypeScript. */
export async function stepBuild(projectRoot: string, dryRun: boolean): Promise<void> {
  info("Building TypeScript...");
  if (dryRun) {
    info("[dry-run] would run: bun run build (or tsc)");
    return;
  }
  // Check for build script in package.json
  const pkgPath = join(projectRoot, "package.json");
  let hasBuild = false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    hasBuild = typeof pkg.scripts?.build === "string";
  } catch {
    // no package.json — try tsc
  }

  const cmd = hasBuild ? ["bun", "run", "build"] : ["bun", "run", "--bun", "tsc"];
  const proc = Bun.spawn(cmd, {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    die(`Build failed (exit ${proc.exitCode})`);
  }
  ok("Build complete");
}

/** Step 3+4: Copy agents with timestamped backup. */
export function stepCopyAgents(
  projectRoot: string,
  configDir: string,
  backupDir: string,
  dryRun: boolean,
): number {
  const agentSrc = join(projectRoot, "agents");
  const agentDst = join(configDir, "agent");

  if (!existsSync(agentSrc)) {
    warn("No agents/ directory found in project root");
    return 0;
  }

  mkdirSync(agentDst, { recursive: true });

  const files = readdirSafe(agentSrc).filter((f) => f.endsWith(".md"));
  let backedUp = 0;
  let copied = 0;

  for (const file of files) {
    const srcFile = join(agentSrc, file);
    const dstFile = join(agentDst, file);

    // Backup existing
    if (existsSync(dstFile)) {
      if (backedUp === 0) {
        mkdirSync(backupDir, { recursive: true });
        info(`Backing up existing agents to ${backupDir}`);
      }
      if (!dryRun) {
        copyFileSync(dstFile, join(backupDir, file));
      }
      backedUp++;
    }

    if (dryRun) {
      info(`[dry-run] would copy agent: ${file}`);
    } else {
      copyFileSync(srcFile, dstFile);
    }
    copied++;
  }

  if (backedUp > 0) {
    ok(`Backed up ${backedUp} existing agent(s)`);
  }
  if (copied > 0) {
    ok(`Copied ${copied} agent(s) to ${agentDst}`);
  } else {
    warn("No agent .md files found");
  }
  return copied;
}

/** Step 5: Copy skills with timestamped backup. */
export function stepCopySkills(
  projectRoot: string,
  configDir: string,
  backupDir: string,
  dryRun: boolean,
): number {
  const skillSrc = join(projectRoot, "skills");
  const skillDst = join(configDir, "skills");

  if (!existsSync(skillSrc)) {
    warn("No skills/ directory found in project root");
    return 0;
  }

  mkdirSync(skillDst, { recursive: true });

  const dirs = readdirSafe(skillSrc).filter((d) => {
    const full = join(skillSrc, d);
    return existsSync(full) && lstatSync(full).isDirectory();
  });

  let backedUp = 0;
  let copied = 0;

  for (const name of dirs) {
    const srcDir = join(skillSrc, name);
    const dstDir = join(skillDst, name);

    // Backup existing
    if (existsSync(dstDir)) {
      if (backedUp === 0) {
        mkdirSync(join(backupDir, "skills"), { recursive: true });
        info(`Backing up existing skills to ${backupDir}/skills`);
      }
      if (!dryRun) {
        cpSyncRecursive(dstDir, join(backupDir, "skills", name));
      }
      backedUp++;
      // Remove existing before copy (bash: rm -rf then cp -r)
      if (!dryRun) {
        rmSync(dstDir, { recursive: true, force: true });
      }
    }

    if (dryRun) {
      info(`[dry-run] would copy skill: ${name}/`);
    } else {
      cpSyncRecursive(srcDir, dstDir);
    }
    copied++;
  }

  if (backedUp > 0) {
    ok(`Backed up ${backedUp} existing skill(s)`);
  }
  if (copied > 0) {
    ok(`Copied ${copied} skill(s) to ${skillDst}`);
  }
  return copied;
}

// ─── Preset application ──────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from an agent .md file.
 * Returns { frontmatter: Record<string, string>, body: string, raw: string }.
 * Frontmatter is between the first two '---' lines.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
  startIdx: number;
  endIdx: number;
} {
  const lines = content.split("\n");
  let startIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim() === "---") {
      if (startIdx === -1) {
        startIdx = i;
      } else {
        endIdx = i;
        break;
      }
    }
  }

  if (startIdx === -1 || endIdx === -1) {
    return { frontmatter: {}, body: content, startIdx: -1, endIdx: -1 };
  }

  const fm: Record<string, string> = {};
  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      fm[key] = value;
    }
  }

  const body = lines.slice(endIdx + 1).join("\n");
  return { frontmatter: fm, body, startIdx, endIdx };
}

/**
 * Serialize frontmatter + body back to a string.
 */
export function serializeFrontmatter(frontmatter: Record<string, string>, body: string): string {
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  return `---\n${fmLines.join("\n")}\n---\n${body}`;
}

/**
 * Apply preset values to an agent .md file's frontmatter.
 * Handles reasoningEffort 3-tier insert fallback:
 *   1. Update existing reasoningEffort line
 *   2. Insert after temperature (if present)
 *   3. Insert after model (if present)
 *   4. Insert after opening ---
 */
export function applyPresetToFile(
  filePath: string,
  preset: PresetEntry,
  dryRun: boolean,
): "updated" | "skipped" {
  const content = readFileSync(filePath, "utf-8");
  const { frontmatter, body, startIdx, endIdx } = parseFrontmatter(content);

  if (startIdx === -1 || endIdx === -1) {
    warn(`No frontmatter found in ${basename(filePath)}, skipping`);
    return "skipped";
  }

  let changed = false;

  // Apply model
  if (preset.model) {
    frontmatter["model"] = preset.model;
    changed = true;
  }

  // Apply temperature
  if (preset.temperature !== undefined) {
    frontmatter["temperature"] = String(preset.temperature);
    changed = true;
  }

  // Apply reasoningEffort (snake_case → camelCase)
  if (preset.reasoning_effort) {
    frontmatter["reasoningEffort"] = preset.reasoning_effort;
    changed = true;
  }

  if (!changed) {
    return "skipped";
  }

  // Serialize back preserving order: model, temperature, reasoningEffort, then others
  const ordered: Record<string, string> = {};
  const priority = ["model", "temperature", "reasoningEffort"];
  for (const key of priority) {
    if (frontmatter[key] !== undefined) {
      ordered[key] = frontmatter[key];
    }
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!(key in ordered)) {
      ordered[key] = value;
    }
  }

  if (dryRun) {
    info(`[dry-run] would update ${basename(filePath)}: model=${preset.model ?? "(keep)"}, temp=${preset.temperature ?? "(keep)"}, effort=${preset.reasoning_effort ?? "(keep)"}`);
  } else {
    writeFileSync(filePath, serializeFrontmatter(ordered, body));
  }

  return "updated";
}

/**
 * Apply provider prefix to model lines in agent .md files.
 * Replaces the provider/ prefix on model: lines (e.g., "opencode/gpt-4" → "anthropic/gpt-4").
 */
export function applyProviderPrefix(
  agentDir: string,
  provider: string,
  dryRun: boolean,
): number {
  const files = readdirSafe(agentDir).filter((f) => f.endsWith(".md"));
  let updated = 0;

  for (const file of files) {
    const filePath = join(agentDir, file);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (line.startsWith("model: ")) {
        const value = line.slice("model: ".length);
        const slashIdx = value.indexOf("/");
        if (slashIdx > 0) {
          const newValue = `${provider}/${value.slice(slashIdx + 1)}`;
          lines[i] = `model: ${newValue}`;
          changed = true;
          break; // Only first model line
        }
      }
    }

    if (changed) {
      if (dryRun) {
        info(`[dry-run] would apply provider prefix '${provider}/' to ${file}`);
      } else {
        writeFileSync(filePath, lines.join("\n"));
      }
      updated++;
    }
  }

  return updated;
}

/** Step 5.5: Apply preset + optional provider prefix override. */
export function stepApplyPreset(
  configDir: string,
  configJson: NdomoConfig,
  preset: string,
  provider: string,
  dryRun: boolean,
): void {
  const agentDir = join(configDir, "agent");

  if (!existsSync(agentDir)) {
    warn("No agent directory found, skipping preset application");
    return;
  }

  const presets = configJson.presets;
  if (!presets || !presets[preset]) {
    warn(`Preset '${preset}' not found in ndomo.config.json, skipping`);
    return;
  }

  const presetData = presets[preset];
  const files = readdirSafe(agentDir).filter((f) => f.endsWith(".md"));
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const name = file.replace(/\.md$/, "");
    if (!assertSafeFilename(name)) {
      warn(`Skipping invalid agent name: '${name}'`);
      skipped++;
      continue;
    }

    const entry = presetData[name];
    if (!entry) {
      warn(`Agent '${name}' has no entry in preset '${preset}', skipping`);
      skipped++;
      continue;
    }

    const result = applyPresetToFile(join(agentDir, file), entry, dryRun);
    if (result === "updated") {
      updated++;
    } else {
      skipped++;
    }
  }

  ok(`Applied preset '${preset}' — ${updated} agent(s) updated`);
  if (skipped > 0) {
    warn(`${skipped} agent(s) skipped`);
  }

  // Apply provider prefix if requested
  if (provider) {
    const updatedP = applyProviderPrefix(agentDir, provider, dryRun);
    ok(`Provider prefix override '${provider}/' applied to ${updatedP} agent(s)`);
  }
}

// ─── Step 6: Copy config files ───────────────────────────────────────────────
export function stepCopyConfig(
  projectRoot: string,
  configDir: string,
  backupDir: string,
  dryRun: boolean,
): void {
  const configJson = join(projectRoot, "config", "ndomo.config.json");
  const schemaJson = join(projectRoot, "config", "ndomo.schema.json");

  if (existsSync(configJson)) {
    const dst = join(configDir, "ndomo.json");
    if (existsSync(dst)) {
      mkdirSync(backupDir, { recursive: true });
      if (!dryRun) {
        copyFileSync(dst, join(backupDir, "ndomo.json"));
      }
      info("Backed up existing ndomo.json");
    }
    if (dryRun) {
      info("[dry-run] would copy ndomo.config.json -> ndomo.json");
    } else {
      copyFileSync(configJson, dst);
    }
    ok("Copied config.json -> ndomo.json");
  } else {
    warn("No config/ndomo.config.json found");
  }

  if (existsSync(schemaJson)) {
    const dst = join(configDir, "ndomo.schema.json");
    if (existsSync(dst)) {
      mkdirSync(backupDir, { recursive: true });
      if (!dryRun) {
        copyFileSync(dst, join(backupDir, "ndomo.schema.json"));
      }
      info("Backed up existing ndomo.schema.json");
    }
    if (dryRun) {
      info("[dry-run] would copy ndomo.schema.json");
    } else {
      copyFileSync(schemaJson, dst);
    }
    ok("Copied ndomo.schema.json");
  } else {
    warn("No config/ndomo.schema.json found");
  }
}

// ─── Step 6.5: Register plugins in opencode.json ─────────────────────────────
export function stepRegisterPlugins(
  configDir: string,
  configJson: NdomoConfig,
  backupDir: string,
  dryRun: boolean,
): void {
  const opencodeJsonPath = join(configDir, "opencode.json");

  // Create opencode.json if missing
  if (!existsSync(opencodeJsonPath)) {
    if (!dryRun) {
      writeFileSync(opencodeJsonPath, "{}");
    }
  }

  // Backup
  if (existsSync(opencodeJsonPath)) {
    const backupPath = join(backupDir, "opencode.json");
    if (!existsSync(backupPath)) {
      mkdirSync(backupDir, { recursive: true });
      if (!dryRun) {
        copyFileSync(opencodeJsonPath, backupPath);
      }
      info("Backed up opencode.json");
    }
  }

  // Extract deduped union of plugins + optionalPlugins
  const plugins = configJson.plugins ?? [];
  const optionalPlugins = configJson.optionalPlugins ?? [];
  const allPlugins = [...new Set([...plugins, ...optionalPlugins])].filter(
    (p) => typeof p === "string" && p.length > 0,
  );

  if (allPlugins.length === 0) {
    info("No ndomo plugins found to register");
    return;
  }

  if (dryRun) {
    info(`[dry-run] would register ${allPlugins.length} plugin(s): ${allPlugins.join(", ")}`);
    return;
  }

  // Read existing opencode.json
  let opencode: Record<string, unknown> = {};
  try {
    opencode = JSON.parse(readFileSync(opencodeJsonPath, "utf-8"));
  } catch {
    opencode = {};
  }

  // Merge with dedup
  const existingPlugins: string[] = Array.isArray(opencode.plugin) ? opencode.plugin : [];
  const merged = [...new Set([...existingPlugins, ...allPlugins])];
  opencode.plugin = merged;

  writeFileSync(opencodeJsonPath, JSON.stringify(opencode, null, 2) + "\n");
  ok(`Registered ${allPlugins.length} ndomo plugin(s) in opencode.json`);
}

// ─── Step 6.6: Install ndomo package (3 strategies) ──────────────────────────

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Strategy 1: file: dep + bun install → real copy (no symlink).
 * Mutates package.json to add ndomo as file: dep, then runs bun install.
 */
async function strategyFileDep(
  projectRoot: string,
  configDir: string,
): Promise<boolean> {
  const pkgJsonPath = join(configDir, "package.json");
  const nmNdomo = join(configDir, "node_modules", "ndomo");

  info(`Adding ndomo file: dep to ${pkgJsonPath}`);

  try {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    } catch {
      return false;
    }

    // Mutate dependencies
    const deps = (pkg.dependencies as Record<string, string>) ?? {};
    deps.ndomo = `file://${projectRoot}`;
    pkg.dependencies = deps;
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

    // Run bun install
    const proc = Bun.spawn(["bun", "install", "--no-frozen-lockfile"], {
      cwd: configDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    if (proc.exitCode === 0 && existsSync(nmNdomo) && !isSymlink(nmNdomo)) {
      ok("ndomo installed via bun (file: dep) — real copy, no symlink");
      return true;
    }
  } catch {
    // fall through to strategy 2
  }

  warn("bun install did not materialize ndomo as real copy, trying bun link...");
  return false;
}

/**
 * Strategy 2: bun link → managed symlink (bun-tracked).
 */
async function strategyBunLink(projectRoot: string, configDir: string): Promise<boolean> {
  info("Trying bun link...");

  try {
    // bun link in project root (registers package)
    const proc1 = Bun.spawn(["bun", "link"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc1.exited;

    if (proc1.exitCode !== 0) {
      warn("bun link in project root failed");
      return false;
    }

    // bun link ndomo in config dir (links package)
    const proc2 = Bun.spawn(["bun", "link", "ndomo"], {
      cwd: configDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc2.exited;

    const nmNdomo = join(configDir, "node_modules", "ndomo");
    if (proc2.exitCode === 0 && existsSync(nmNdomo)) {
      ok("ndomo linked via bun link (managed symlink)");
      warn("bun link uses symlinks — run 'bun run dev:bust' if cache goes stale");
      return true;
    }
  } catch {
    // fall through to strategy 3
  }

  warn("bun link failed, falling back to manual symlink");
  return false;
}

/**
 * Strategy 3: manual symlink (last resort).
 */
function strategyManualSymlink(projectRoot: string, configDir: string): boolean {
  const nmNdomo = join(configDir, "node_modules", "ndomo");

  info(`Creating manual symlink: ${nmNdomo} -> ${projectRoot}`);
  mkdirSync(join(configDir, "node_modules"), { recursive: true });

  try {
    symlinkSync(projectRoot, nmNdomo, "dir");
    ok(`ndomo symlinked at ${nmNdomo} (last resort)`);
    warn("manual symlink may cause Bun cache stale — run 'bun run dev:bust' to recover");
    return true;
  } catch {
    err("Failed to install ndomo package");
    return false;
  }
}

export async function stepInstallPackage(
  projectRoot: string,
  configDir: string,
  dryRun: boolean,
): Promise<void> {
  // Skip if user opted out
  if (process.env.NDOMO_SKIP_PACKAGE_INSTALL === "1") {
    info("Skipping ndomo package install (NDOMO_SKIP_PACKAGE_INSTALL=1)");
    return;
  }

  const nmNdomo = join(configDir, "node_modules", "ndomo");

  // If existing install is a symlink, remove it
  if (isSymlink(nmNdomo)) {
    warn("Existing ndomo install is a symlink (causes Bun cache stale in dev)");
    info("Removing symlink, will reinstall as real copy...");
    if (!dryRun) {
      rmSync(nmNdomo, { force: true });
    }
  } else if (existsSync(nmNdomo)) {
    info(`ndomo already installed at ${nmNdomo}`);
    return;
  }

  if (dryRun) {
    info("[dry-run] would install ndomo package via 3-strategy cascade");
    return;
  }

  // Need package.json for strategy 1+2
  const pkgJsonPath = join(configDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    warn(`${pkgJsonPath} not found, falling back to manual symlink`);
    strategyManualSymlink(projectRoot, configDir);
    return;
  }

  // Strategy 1: file: dep + bun install
  if (await strategyFileDep(projectRoot, configDir)) {
    return;
  }

  // Strategy 2: bun link
  if (await strategyBunLink(projectRoot, configDir)) {
    return;
  }

  // Strategy 3: manual symlink (last resort)
  if (!strategyManualSymlink(projectRoot, configDir)) {
    die("Failed to install ndomo package");
  }
}

// ─── Step 6.7: Copy custom tools ─────────────────────────────────────────────
// npm distribution: tools live inside the installed ndomo package, so symlink
// dance (used in old repo-based install) is obsolete. Copy .ts files directly.
export function stepCopyTools(
  projectRoot: string,
  configDir: string,
  dryRun: boolean,
): number {
  const src = join(projectRoot, "tools");
  const dst = join(configDir, "tools");

  if (!existsSync(src)) {
    warn(`No tools/ directory found at ${src} — skipping`);
    return 0;
  }

  if (dryRun) {
    info(`[dry-run] would copy tools from ${src} to ${dst}`);
    return 0;
  }

  mkdirSync(configDir, { recursive: true });
  mkdirSync(dst, { recursive: true });
  let copied = 0;
  const entries = readdirSafe(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const stat = lstatSync(srcPath);
    if (!stat.isFile() || !srcPath.endsWith(".ts")) {
      // Skip non-.ts files (subdirs, etc.)
      continue;
    }
    if (existsSync(dstPath)) {
      // Idempotent: skip if content matches
      const srcContent = readFileSync(srcPath, "utf-8");
      const dstContent = readFileSync(dstPath, "utf-8");
      if (srcContent === dstContent) {
        continue;
      }
      // Backup changed file
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = join(configDir, `.backup-${ts}`, "tools", entry);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(dstPath, backupPath);
    }
    copyFileSync(srcPath, dstPath);
    copied++;
  }
  if (copied > 0) {
    ok(`Copied ${copied} tool file(s) to ${dst}`);
  } else {
    info(`Tool files already up to date at ${dst}`);
  }
  return copied;
}

// ─── Step 7: Inject preset name into ndomo.json ──────────────────────────────
export function stepInjectPreset(configDir: string, preset: string, dryRun: boolean): void {
  const ndomoJsonPath = join(configDir, "ndomo.json");

  if (!existsSync(ndomoJsonPath)) {
    return;
  }

  if (dryRun) {
    info(`[dry-run] would inject preset '${preset}' into ndomo.json`);
    return;
  }

  try {
    const ndomo: Record<string, unknown> = JSON.parse(readFileSync(ndomoJsonPath, "utf-8"));
    ndomo.preset = preset;
    writeFileSync(ndomoJsonPath, JSON.stringify(ndomo, null, 2) + "\n");
    ok(`Preset '${preset}' written to ndomo.json`);
  } catch (e) {
    warn(`Failed to inject preset into ndomo.json: ${e}`);
  }
}

// ─── Step 8: Optional DCP install ────────────────────────────────────────────
export async function stepInstallDcp(dryRun: boolean): Promise<void> {
  info("Installing @tarquinen/opencode-dcp (AGPL-3.0)...");
  if (dryRun) {
    info("[dry-run] would run: opencode plugin @tarquinen/opencode-dcp --global");
    return;
  }

  const proc = Bun.spawn(["opencode", "plugin", "@tarquinen/opencode-dcp", "--global"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  if (proc.exitCode === 0) {
    ok("DCP plugin installed");
  } else {
    warn("DCP plugin install failed (non-fatal)");
  }
}

// ─── HTTP auto-prompt ─────────────────────────────────────────────────────────
/**
 * Build HttpConfig from flags + defaults.
 */
export function buildHttpConfig(flags: InstallFlags): HttpConfig {
  return {
    enabled: true,
    port: flags.port,
    cors: {
      origins: flags.corsOrigins?.split(",").map((s: string) => s.trim()) ?? ["*"],
    },
    auth: {
      required: flags.authRequired,
    },
  };
}

/**
 * Write http block to ndomo.config.json (source-of-truth in project, not config dir).
 */
export function writeHttpBlock(projectRoot: string, httpConfig: HttpConfig, dryRun: boolean): void {
  const configPath = join(projectRoot, "config", "ndomo.config.json");
  if (!existsSync(configPath)) {
    warn("config/ndomo.config.json not found, cannot write http block");
    return;
  }

  try {
    const config: Record<string, unknown> = JSON.parse(readFileSync(configPath, "utf-8"));
    config.http = httpConfig;

    if (dryRun) {
      info(`[dry-run] would write http block to ${configPath}:`);
      console.log(JSON.stringify(httpConfig, null, 2));
    } else {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      ok("HTTP server config written to config/ndomo.config.json");
      info(`  port: ${httpConfig.port}, cors: ${httpConfig.cors.origins.join(",")}, auth: ${httpConfig.auth.required}`);
    }
  } catch (e) {
    warn(`Failed to write http block: ${e}`);
  }
}

/**
 * Prompt user interactively to enable HTTP server (TTY only).
 * Returns true if user accepts, false otherwise.
 */
export async function promptHttpEnable(): Promise<boolean> {
  console.log("");
  console.log("[?] Enable ndomo HTTP server? Allows programmatic plan/task control via API.");
  console.log("    Recommended for users integrating ndomo with other tools (port 4097, auth required).");
  process.stdout.write("    Enable now? [Y/n]: ");

  return new Promise((resolve) => {
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();

    let input = "";
    const onData = (chunk: string) => {
      input += chunk;
      if (input.includes("\n")) {
        cleanup();
        const answer = input.trim().toLowerCase();
        resolve(answer === "" || answer === "y" || answer === "yes");
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    };

    process.stdin.on("data", onData);

    // Timeout after 30s
    setTimeout(() => {
      cleanup();
      console.log("\n(timeout — skipping HTTP enable)");
      resolve(false);
    }, 30_000);
  });
}

/**
 * Handle HTTP auto-prompt logic:
 * - --enable-http → write block immediately
 * - --disable-http → skip entirely
 * - Otherwise → prompt in TTY, skip in non-TTY
 */
export async function stepHttpPrompt(
  flags: InstallFlags,
  projectRoot: string,
  dryRun: boolean,
): Promise<void> {
  if (flags.enableHttp) {
    const httpConfig = buildHttpConfig(flags);
    writeHttpBlock(projectRoot, httpConfig, dryRun);
    return;
  }

  if (flags.disableHttp) {
    info("HTTP auto-prompt disabled (--disable-http)");
    return;
  }

  // Interactive prompt only in TTY
  if (!process.stdin.isTTY) {
    info("Non-TTY mode — skipping HTTP prompt (use --enable-http to enable)");
    return;
  }

  const accepted = await promptHttpEnable();
  if (accepted) {
    const httpConfig = buildHttpConfig(flags);
    writeHttpBlock(projectRoot, httpConfig, dryRun);
  } else {
    info("HTTP server not enabled (can be enabled later with --enable-http)");
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────
function printSummary(configDir: string, preset: string, provider: string, withDcp: boolean): void {
  const agentDir = join(configDir, "agent");
  const skillDir = join(configDir, "skills");

  console.log("");
  console.log(`${GREEN}${BOLD}════════════════════════════════════════${NC}`);
  console.log(`${GREEN}${BOLD}  ndomo installed successfully!${NC}`);
  console.log(`${GREEN}${BOLD}════════════════════════════════════════${NC}`);
  console.log("");
  console.log(`${BOLD}Installed agents:${NC}`);

  if (existsSync(agentDir)) {
    const agents = readdirSafe(agentDir).filter((f) => f.endsWith(".md"));
    for (const a of agents) {
      console.log(`  ${a.replace(/\.md$/, "").padEnd(20)} ${a}`);
    }
  }

  console.log("");
  if (existsSync(skillDir)) {
    const skills = readdirSafe(skillDir).filter((d) => {
      const full = join(skillDir, d);
      return existsSync(full) && lstatSync(full).isDirectory();
    });
    console.log(`${BOLD}Installed skills:${NC} ${skills.join(", ")}`);
  }

  console.log("");
  console.log(`${BOLD}Config:${NC} ${configDir}/ndomo.json`);
  console.log(`${BOLD}OpenCode config:${NC} ${configDir}/opencode.json (ndomo registered)`);
  console.log(`${BOLD}Preset:${NC} ${preset}`);
  if (provider) {
    console.log(`${BOLD}Provider:${NC} ${provider}`);
  }
  if (withDcp) {
    console.log(`${BOLD}DCP:${NC}    installed`);
  }
  console.log("");
  console.log(`${BOLD}Next steps:${NC}`);
  console.log(`  Run ${BLUE}opencode${NC} then ${BLUE}ping all agents${NC} to verify.`);
  console.log("");
}

// ─── Uninstall shim ──────────────────────────────────────────────────────────
function runUninstall(projectRoot: string): void {
  const uninstallScript = join(projectRoot, "scripts", "uninstall.sh");
  if (!existsSync(uninstallScript)) {
    die("scripts/uninstall.sh not found");
  }
  info("Running uninstaller...");
  const proc = Bun.spawn(["bash", uninstallScript], {
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  // Wait for process to finish
  proc.exited.then((code) => {
    process.exit(code ?? 0);
  });
}

// ─── Safe directory listing ──────────────────────────────────────────────────
function readdirSafe(dir: string): string[] {
  try {
    const { readdirSync } = require("node:fs");
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

// ─── Recursive copy helper ───────────────────────────────────────────────────
function cpSyncRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  const entries = readdirSafe(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const stat = lstatSync(srcPath);
    if (stat.isDirectory()) {
      cpSyncRecursive(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
export async function runInstall(args: string[]): Promise<void> {
  const flags = parseFlags(args);

  if (flags.help) {
    printHelp();
    return;
  }

  // Uninstall shortcut
  if (flags.uninstall) {
    const projectRoot = detectProjectRoot();
    runUninstall(projectRoot);
    return;
  }

  // Detect paths
  const projectRoot = detectProjectRoot();
  const configDir = resolveConfigDir();
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const backupDir = join(configDir, `.backup-${timestamp}`);

  console.log("");
  console.log(`${BOLD}ndomo installer${NC} — preset: ${flags.preset}, config: ${configDir}`);
  console.log("");

  // Load config for preset validation
  const configJsonPath = join(projectRoot, "config", "ndomo.config.json");
  let configJson: NdomoConfig = {};
  try {
    configJson = JSON.parse(readFileSync(configJsonPath, "utf-8"));
  } catch {
    warn("Could not read config/ndomo.config.json — preset application may fail");
  }

  // Validate preset
  const presets = configJson.presets;
  if (presets && !presets[flags.preset]) {
    const available = Object.keys(presets).join(", ");
    die(`Unknown preset: '${flags.preset}' (available: ${available})`);
  }

  // Dry-run banner
  if (flags.dryRun) {
    console.log(`${YELLOW}${BOLD}[DRY-RUN] No files will be written${NC}`);
    console.log("");
  }

  // Step 1: Install deps
  if (!flags.skipDeps) {
    await stepInstallDeps(projectRoot, flags.dryRun);
  } else {
    info("Skipping dependency installation (--skip-deps)");
  }

  // Step 2: Build
  await stepBuild(projectRoot, flags.dryRun);

  // Step 3+4: Copy agents
  mkdirSync(join(configDir, "agent"), { recursive: true });
  mkdirSync(join(configDir, "skills"), { recursive: true });
  stepCopyAgents(projectRoot, configDir, backupDir, flags.dryRun);

  // Step 5: Copy skills
  stepCopySkills(projectRoot, configDir, backupDir, flags.dryRun);

  // Step 5.5: Apply preset
  stepApplyPreset(configDir, configJson, flags.preset, flags.provider, flags.dryRun);

  // Step 6: Copy config
  stepCopyConfig(projectRoot, configDir, backupDir, flags.dryRun);

  // Step 6.5: Register plugins
  // Reload config from configDir (just copied)
  let installedConfig: NdomoConfig = {};
  const ndomoJsonPath = join(configDir, "ndomo.json");
  try {
    installedConfig = JSON.parse(readFileSync(ndomoJsonPath, "utf-8"));
  } catch {
    // Use original
    installedConfig = configJson;
  }
  stepRegisterPlugins(configDir, installedConfig, backupDir, flags.dryRun);

  // Step 6.6: Install package
  await stepInstallPackage(projectRoot, configDir, flags.dryRun);

  // Step 6.7: Copy tools (npm distribution — no symlink)
  stepCopyTools(projectRoot, configDir, flags.dryRun);

  // Step 7: Inject preset
  stepInjectPreset(configDir, flags.preset, flags.dryRun);

  // Step 8: Optional DCP
  if (flags.withDcp) {
    await stepInstallDcp(flags.dryRun);
  }

  // HTTP auto-prompt (closes Phase-1 gap)
  await stepHttpPrompt(flags, projectRoot, flags.dryRun);

  // Summary
  if (!flags.dryRun) {
    printSummary(configDir, flags.preset, flags.provider, flags.withDcp);
  } else {
    console.log("");
    console.log(`${YELLOW}[dry-run] Complete. No files were modified.${NC}`);
  }
}

// Direct execution
if (import.meta.main) {
  await runInstall(process.argv.slice(2));
}
