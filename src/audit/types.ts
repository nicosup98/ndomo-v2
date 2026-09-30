/**
 * ndomo audit — shared types for the self-audit (report-only) checks.
 *
 * The audit never mutates project state: the only write it may perform is the
 * sha256 manifest at `<projectDir>/.ndomo/audit/manifest.json`, and only when
 * the caller passes `updateManifest: true`.
 *
 * Severities (also see `src/audit/score.ts` for the scoring weights):
 * - `ERROR` — security-relevant misconfiguration or broken config file.
 * - `WARN`  — drift/regression that will surprise a user but is not unsafe.
 * - `INFO`  — informational drift; the preset/default is authoritative.
 */

/** Severity of a single finding. Ordered: ERROR > WARN > INFO. */
export type Severity = "ERROR" | "WARN" | "INFO";

/** Weights subtracted from 100 per finding (floor 1). Mirrored in `score.ts`. */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  ERROR: 10,
  WARN: 4,
  INFO: 1,
};

/** Stable machine code for a finding (used by tests and `--code` filters). */
export type FindingCode =
  | "drift.field"
  | "drift.missing-file"
  | "drift.missing-preset"
  | "perm.bash-wildcard-allow"
  | "perm.readonly-write"
  | "perm.missing-block"
  | "count.mismatch"
  | "count.unparsable"
  | "config.invalid-json"
  | "config.unknown-key"
  | "manifest.first-run"
  | "manifest.modified"
  | "manifest.added"
  | "manifest.removed";

/** One audit finding. `path` is projectDir-relative and POSIX-normalized. */
export interface Finding {
  code: FindingCode;
  severity: Severity;
  /** Project-relative path (e.g. `agents/ranger.md`), or the doc file for counts. */
  path: string;
  /** Human-readable, deterministic message (no timestamps, no absolute paths). */
  message: string;
  /** Optional structured payload for tests/CLI rendering. */
  detail?: Record<string, string | number> | undefined;
}

/** Options accepted by {@link runAudit}. */
export interface RunAuditOptions {
  /** Repository root containing `agents/`, `skills/`, `src/`, `config/`, `docs/`. */
  projectDir: string;
  /**
   * When `true`, (re)write `.ndomo/audit/manifest.json` with the current
   * hashes — i.e. re-baseline the manifest so the next run compares against
   * it. Default `false`: report-only, zero writes.
   */
  updateManifest?: boolean | undefined;
}

/** Aggregate of findings by severity. */
export interface AuditSummary {
  error: number;
  warn: number;
  info: number;
  total: number;
}

/** Result of {@link runAudit}. */
export interface AuditReport {
  /** Absolute project root the audit ran against. */
  projectDir: string;
  /** 1–100 weighted score (see `score.ts`). */
  score: number;
  summary: AuditSummary;
  /** Deterministically ordered (severity DESC, then path, then code, then message). */
  findings: Finding[];
  /** What happened to the manifest (never silently written). */
  manifest: ManifestOutcome;
}

/** Manifest write/compare outcome surfaced in the report. */
export interface ManifestOutcome {
  /** Project-relative manifest path (`.ndomo/audit/manifest.json`). */
  path: string;
  /** Whether a previous manifest existed and was diffed. */
  baselineFound: boolean;
  /** Whether the manifest file was (re)written this run. */
  written: boolean;
  /** Number of tracked files in the current manifest. */
  tracked: number;
}
