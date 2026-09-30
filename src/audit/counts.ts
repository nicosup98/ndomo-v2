/**
 * ndomo audit — documented counts vs reality (check c).
 *
 * Compares four numbers the docs state with the number the source of truth
 * actually has. Every "actual" is derived at runtime (never hardcoded):
 *
 * | subject    | source of truth                            | docs claim                    |
 * |------------|--------------------------------------------|-------------------------------|
 * | MCP tools  | `tool({` occurrences in `src/plugin.ts`    | README.md / README.es.md      |
 * | agents     | `agents/*.md` files                        | docs/agents.md / installation |
 * | skills     | `skills/*` directories                     | README.md / README.es.md      |
 * | migrations | `max(MIGRATIONS.version)` in src/db/schema | docs/database.md              |
 *
 * Severities:
 * - `count.mismatch` **WARN** — stated number ≠ real number (docs lie).
 * - `count.unparsable` **INFO** — the claim pattern wasn't found in the doc,
 *   so nothing to compare (informational: a reworded doc stops being audited).
 *
 * Deterministic: regexes are fixed, matches are reported in file order.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../db/schema.ts";
import type { Finding } from "./types.ts";

/** One documented claim to verify. */
interface ClaimSpec {
  /** Project-relative doc path. */
  file: string;
  /** Regex with ONE capture group holding the claimed number. */
  pattern: RegExp;
  /** The real value. */
  actual: number;
  /** Short subject label used in messages (`tools`, `agents`, …). */
  subject: string;
}

/** Count `agents/*.md` files. */
export function countAgents(projectDir: string): number {
  return listMd(join(projectDir, "agents"));
}

/** Count `skills/*` entries that are directories (a skill = a directory). */
export function countSkills(projectDir: string): number {
  const dir = join(projectDir, "skills");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  return entries.filter((name) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  }).length;
}

/** Count `tool({` registrations in `src/plugin.ts` (the MCP tool surface). */
export function countMcpTools(projectDir: string): number {
  const source = readFileSafe(join(projectDir, "src", "plugin.ts"));
  if (source === null) return 0;
  return (source.match(/tool\(\{/g) ?? []).length;
}

/** Latest schema version = `max(MIGRATIONS[].version)`. */
export function countMigrations(): number {
  return MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
}

function listMd(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Build the claim list for a project. Exported so tests can inspect the
 * regexes without running the whole audit.
 */
export function buildClaims(projectDir: string): ClaimSpec[] {
  return [
    {
      file: "README.md",
      pattern: /(\d+)\s+tools\s+are\s+exposed/,
      actual: countMcpTools(projectDir),
      subject: "MCP tools",
    },
    {
      file: "README.es.md",
      pattern: /(\d+)\s+herramientas\s+expuestas/,
      actual: countMcpTools(projectDir),
      subject: "MCP tools",
    },
    {
      file: "docs/agents.md",
      pattern: /(\d+)\s+agents?\s+grouped\s+by\s+function/,
      actual: countAgents(projectDir),
      subject: "agents",
    },
    {
      file: "docs/installation.md",
      pattern: /each\s+of\s+the\s+(\d+)\s+agents/,
      actual: countAgents(projectDir),
      subject: "agents",
    },
    {
      file: "README.md",
      pattern: /bundles\s+(\d+)\s+skills/,
      actual: countSkills(projectDir),
      subject: "skills",
    },
    {
      file: "README.es.md",
      pattern: /incluye\s+(\d+)\s+skills/,
      actual: countSkills(projectDir),
      subject: "skills",
    },
    {
      file: "docs/database.md",
      pattern: /(\d+)\s+migrations\s+applied/,
      actual: countMigrations(),
      subject: "migrations",
    },
  ];
}

/**
 * Run the counts check: every doc claim vs its real value.
 * `docs/agents.md` states the agent count three times (prose line 5, the d2
 * `# N agents:` comment, and `N subagents` in both) — all are verified via
 * {@link checkAgentCountEchoes}.
 */
export function checkCounts(projectDir: string, config: Record<string, unknown> | null): Finding[] {
  const findings: Finding[] = [];

  for (const claim of buildClaims(projectDir)) {
    const content = readFileSafe(join(projectDir, claim.file));
    if (content === null) {
      findings.push({
        code: "count.unparsable",
        severity: "INFO",
        path: claim.file,
        message: `file not readable — cannot verify ${claim.subject} count (${claim.actual} real)`,
        detail: { subject: claim.subject, actual: claim.actual },
      });
      continue;
    }
    const match = claim.pattern.exec(content);
    if (match === null) {
      findings.push({
        code: "count.unparsable",
        severity: "INFO",
        path: claim.file,
        message: `no "${claim.subject}" claim found — cannot verify (real value: ${claim.actual})`,
        detail: { subject: claim.subject, actual: claim.actual },
      });
      continue;
    }
    const claimed = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(claimed) || claimed === claim.actual) continue;
    findings.push({
      code: "count.mismatch",
      severity: "WARN",
      path: claim.file,
      message: `docs claim ${claimed} ${claim.subject}, reality is ${claim.actual}`,
      detail: { subject: claim.subject, claimed, actual: claim.actual },
    });
  }

  findings.push(...checkAgentCountEchoes(projectDir, config));
  return findings;
}

/**
 * Secondary count echoes inside `docs/agents.md`:
 * - the d2 comment `# 22 agents: …` (total agents, first occurrence)
 * - every `18 subagents` claim (prose line 5 + d2 comment line 13)
 *
 * Reality for subagents = `agents/*.md` minus primaries, where "primary" is
 * taken from `agentRouting.<id>.mode === "primary"` (same union the permission
 * check uses).
 */
function checkAgentCountEchoes(
  projectDir: string,
  config: Record<string, unknown> | null,
): Finding[] {
  const findings: Finding[] = [];
  const content = readFileSafe(join(projectDir, "docs", "agents.md"));
  if (content === null) return findings;

  const total = countAgents(projectDir);
  const subagents = Math.max(total - countPrimaries(config), 0);

  const totalMatch = /^#\s*(\d+)\s+agents:/m.exec(content);
  if (totalMatch !== null) {
    pushIfMismatch(Number.parseInt(totalMatch[1] ?? "", 10), total, "agents", findings);
  }
  for (const match of content.matchAll(/(\d+)\s+subagents/g)) {
    pushIfMismatch(Number.parseInt(match[1] ?? "", 10), subagents, "subagents", findings);
  }
  return findings;
}

/** Count `agentRouting.<id>.mode === "primary"` entries in the parsed config. */
function countPrimaries(config: Record<string, unknown> | null): number {
  const routing = config?.agentRouting;
  if (typeof routing !== "object" || routing === null || Array.isArray(routing)) return 0;
  return Object.values(routing as Record<string, unknown>).filter(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      (value as { mode?: unknown }).mode === "primary",
  ).length;
}

function pushIfMismatch(
  claimed: number,
  actual: number,
  subject: string,
  findings: Finding[],
): void {
  if (!Number.isFinite(claimed) || claimed === actual) return;
  findings.push({
    code: "count.mismatch",
    severity: "WARN",
    path: "docs/agents.md",
    message: `docs claim ${claimed} ${subject}, reality is ${actual}`,
    detail: { subject, claimed, actual },
  });
}
