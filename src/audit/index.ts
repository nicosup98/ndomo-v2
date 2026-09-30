/**
 * ndomo audit — public surface.
 *
 * The CLI (`src/cli/audit.ts`, wired separately) imports `runAudit` from here;
 * everything else in this directory is an implementation detail, though the
 * individual checks are exported for focused tests.
 */

export { CONFIG_FILE, checkConfig, KNOWN_CONFIG_KEYS } from "./config.ts";
export { checkCounts, countAgents, countMcpTools, countMigrations, countSkills } from "./counts.ts";
export { checkDrift, listAgentIds } from "./drift.ts";
export { parseFrontmatter } from "./frontmatter.ts";
export { checkManifest, computeManifest, MANIFEST_REL_PATH, readManifest } from "./manifest.ts";
export { checkPermissions, DANGEROUS_PREFIXES } from "./permissions.ts";
export { runAudit, sortFindings } from "./runner.ts";
export { computeScore, SCORE_CEILING, SCORE_FLOOR, summarize } from "./score.ts";
export type {
  AuditReport,
  AuditSummary,
  Finding,
  FindingCode,
  ManifestOutcome,
  RunAuditOptions,
  Severity,
} from "./types.ts";
export { SEVERITY_WEIGHT } from "./types.ts";
