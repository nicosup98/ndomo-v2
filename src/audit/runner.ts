/**
 * ndomo audit — runner (the public entry point of the self-audit).
 *
 * `runAudit({ projectDir, updateManifest? })` executes every check and returns
 * findings + score. Pure report: the ONLY write in the whole module is
 * `.ndomo/audit/manifest.json`, and only when `updateManifest: true`.
 *
 * Checks (in execution order; findings are re-sorted afterwards):
 *  - (a) drift      — `agents/*.md` frontmatter vs `config.presets.<effective>`
 *  - (b) permissions— insecure / missing `permission:` blocks
 *  - (c) counts     — README/docs claims vs real dirs + `tool({` count + migrations
 *  - (d) config     — `config/ndomo.config.json` parses, keys are known
 *  - (e) manifest   — sha256 baseline diff (+ optional re-baseline)
 *
 * `projectDir` is the ndomo repo root (contains `agents/`, `skills/`, `src/`,
 * `config/`, `docs/`). Every path in the report is project-relative, so the
 * audit is runnable from any CWD and produces identical output for the same
 * repo state (deterministic: no clock, no randomness, stable sort).
 *
 * Severity → score mapping lives in `score.ts`.
 */

import { checkConfig } from "./config.ts";
import { checkCounts } from "./counts.ts";
import { checkDrift, listAgentIds } from "./drift.ts";
import { checkManifest } from "./manifest.ts";
import { checkPermissions } from "./permissions.ts";
import { computeScore, summarize } from "./score.ts";
import type { AuditReport, Finding, RunAuditOptions, Severity } from "./types.ts";

/** Severity ordering for the stable sort (ERROR first). */
const SEVERITY_RANK: Record<Severity, number> = { ERROR: 0, WARN: 1, INFO: 2 };

/**
 * Deterministic finding order: severity DESC (ERROR → WARN → INFO), then path,
 * then code, then message. Two runs over the same tree are byte-identical.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}

/** Effective preset name: `config.preset` when set, else `"default"`. */
function effectivePreset(config: Record<string, unknown> | null): string {
  const preset = config?.preset;
  return typeof preset === "string" && preset.length > 0 ? preset : "default";
}

/**
 * Run the full self-audit.
 *
 * @example
 * const report = runAudit({ projectDir: "/repos/ndomo-v2" });
 * // → { score: 96, summary: { error: 0, warn: 1, info: 8, total: 9 }, findings: [...] }
 *
 * @example
 * // re-baseline the manifest after reviewing a legitimate change
 * runAudit({ projectDir, updateManifest: true });
 */
export function runAudit(options: RunAuditOptions): AuditReport {
  const { projectDir } = options;
  const updateManifest = options.updateManifest === true;

  const config = checkConfig(projectDir);
  const agentIds = listAgentIds(projectDir);
  const manifest = checkManifest(projectDir, updateManifest);

  const findings: Finding[] = [
    ...config.findings,
    ...checkDrift(projectDir, config.config, effectivePreset(config.config)),
    ...checkPermissions(projectDir, agentIds, config.config),
    ...checkCounts(projectDir, config.config),
    ...manifest.findings,
  ];

  const sorted = sortFindings(findings);
  return {
    projectDir,
    score: computeScore(sorted),
    summary: summarize(sorted),
    findings: sorted,
    manifest: manifest.outcome,
  };
}
