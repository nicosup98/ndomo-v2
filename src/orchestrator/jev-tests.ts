// ─── JEV Test-Battery Classification ──────────────────────────────────────────
/**
 * Classify a test-runner output (bun/vitest/jest/pytest/go) into a battery
 * verdict (`green|red|mixed|none`).
 *
 * Cardinal rule: the *action* lives in the deterministic parser. JEV is only
 * asked to fill gaps — it classifies per-test statuses that the parser could
 * not resolve and proposes an overall verdict. Parsed evidence ALWAYS wins
 * over JEV: a confirmed failure is never softened, and JEV answers outside the
 * accepted enums are dropped.
 *
 * Guarantees (inherited from `callJev`, plus local validation):
 * - Never throws. Any error/timeout/missing key/disabled config resolves to a
 *   deterministic fallback decision (status `none`, verdict `none|mixed`).
 * - Short-circuits before any JEV call when the parser is conclusive.
 * - Caps are enforced with advisory warnings: raw output is truncated to the
 *   last 64 KiB, `expectedTests` to the first 50, JEV test questions to 20.
 * - No network access unless a TYPESAFE_API_KEY is available and `enabled` true.
 */

import { choice } from "@typesafe-ai/sdk";
import type { JevConfig } from "../config/schema.ts";
import { callJev, type JevClassifierDeps, pickChoice } from "./jev.ts";

/** Test runners the parser understands. `unknown` means "could not detect". */
export const TEST_RUNNERS = ["bun", "vitest", "jest", "pytest", "go", "unknown"] as const;
export type TestRunner = (typeof TEST_RUNNERS)[number];

/** Per-test statuses. `none` = no evidence (escape hatch). */
export const TEST_STATUSES = ["pass", "fail", "skip", "none"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

/** Battery verdicts. `none` = no usable data (escape hatch). */
export const TEST_VERDICTS = ["green", "red", "mixed", "none"] as const;
export type TestVerdict = (typeof TEST_VERDICTS)[number];

/** Input classified by `classifyTestsWithJev`. */
export type JevTestsInput = {
  output: string;
  exitCode?: number;
  expectedTests?: string[];
  runner?: TestRunner;
  context?: string;
};

/** A single resolved test case. */
export type TestCaseResult = { name: string; status: TestStatus };

/** Final decision returned to consumers (plugin tool, smoke tests). */
export type JevTestsDecision = {
  verdict: TestVerdict;
  source: "parser" | "jev" | "fallback";
  runner: TestRunner;
  results: TestCaseResult[];
  counts: { total: number; pass: number; fail: number; skip: number; unresolved: number };
  warnings: string[];
};

/** Maximum raw output kept (the tail, where summaries/footers live). */
export const RAW_OUTPUT_MAX_BYTES = 64 * 1024;
/** Maximum `expectedTests` entries considered. */
export const EXPECTED_TESTS_MAX = 50;
/** Maximum per-test questions asked to JEV (plus one verdict question). */
export const MAX_JEV_TEST_QUESTIONS = 20;

/** Parser-only view. `conclusive` means "no JEV call needed". */
export type ParsedTestOutput = {
  runner: TestRunner;
  results: TestCaseResult[];
  counts: { total: number; pass: number; fail: number; skip: number };
  verdict: TestVerdict;
  conclusive: boolean;
  unresolved: string[];
  warnings: string[];
};

/** Input accepted by `parseTestOutput`. */
export type ParseTestInput = {
  output: string;
  exitCode?: number;
  expectedTests?: string[];
  runner?: TestRunner;
};

type Counts = { total: number; pass: number; fail: number; skip: number };

type RunnerParse = {
  results: TestCaseResult[];
  counts: Counts;
  /** True when `pass/fail/skip` came from a runner summary line. */
  hasSummaryCounts: boolean;
};

type InternalParse = ParsedTestOutput & { hasSummaryCounts: boolean };

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Keeps the last `maxBytes` bytes of `text` (summaries/footers are at the end). */
function truncateKeepingTail(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const len = text.length;
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = text.slice(len - mid);
    if (byteLength(slice) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(len - lo);
}

function capOutput(raw: string): { output: string; warning?: string } {
  const bytes = byteLength(raw);
  if (bytes <= RAW_OUTPUT_MAX_BYTES) return { output: raw };
  return {
    output: truncateKeepingTail(raw, RAW_OUTPUT_MAX_BYTES),
    warning: `raw output was ${bytes} bytes; truncated to the last ${RAW_OUTPUT_MAX_BYTES} bytes`,
  };
}

function capExpected(list: string[] | undefined): { expected?: string[]; warning?: string } {
  if (list === undefined) return {};
  if (list.length > EXPECTED_TESTS_MAX) {
    return {
      expected: list.slice(0, EXPECTED_TESTS_MAX),
      warning: `expectedTests had ${list.length} entries; only the first ${EXPECTED_TESTS_MAX} are considered`,
    };
  }
  return { expected: list };
}

function firstInt(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  const captured = m?.[1];
  if (captured === undefined) return undefined;
  const n = Number.parseInt(captured, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Strips trailing timing/aggregate noise from a captured test name. */
function cleanTestName(raw: string): string {
  let name = raw.trim();
  name = name.replace(/\s*\[[^\]]*\]\s*$/, "");
  name = name.replace(/\s*\(\d+(?:\.\d+)?\s*(?:ms|s|m)\)\s*$/, "");
  name = name.replace(/\s+\d+(?:\.\d+)?\s*(?:ms|s)\s*$/, "");
  return name.trim();
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Best-effort runner detection by signature markers (first match wins). */
function detectRunner(output: string): TestRunner {
  // go: verbose per-test markers are unambiguous.
  if (/^--- (?:PASS|FAIL|SKIP):/m.test(output)) return "go";
  // go: footer-only runs (`ok pkg 0.01s`, `FAIL pkg 0.01s`) need a duration.
  if (/^ok\s+\S+.*(?:\d+(?:\.\d+)?s|\(cached\)|\[no test files\])/m.test(output)) return "go";
  if (/^FAIL\s+\S+.*\d+(?:\.\d+)?s\b/m.test(output)) return "go";
  // pytest
  if (/^(?:FAILED|ERROR)\s+\S+::\S+/m.test(output)) return "pytest";
  if (/^\S+::\S+\s+(?:PASSED|FAILED|SKIPPED)\b/m.test(output)) return "pytest";
  if (/^=+.*\b\d+\s+(?:passed|failed|errors?|skipped)\b.*=*\s*$/m.test(output)) return "pytest";
  if (/^\d+\s+(?:passed|failed|errors?|skipped)\b.*\bin\s+\d/m.test(output)) return "pytest";
  // jest (note the colon — vitest omits it)
  if (/^Tests:\s/m.test(output) || /^Test Suites:/m.test(output)) return "jest";
  // vitest
  if (/^Test Files\s/m.test(output)) return "vitest";
  if (/^\s*Tests\s+\d/m.test(output)) return "vitest";
  // bun
  if (
    /^\s*\d+\s+pass\s*$/m.test(output) ||
    /\bRan\s+\d+\s+tests?\b/.test(output) ||
    /\(pass\)|\(fail\)/.test(output) ||
    /\bbun test\b/.test(output)
  ) {
    return "bun";
  }
  // vitest fallback markers
  if (/[↓×]/.test(output)) return "vitest";
  return "unknown";
}

function emptyCounts(): Counts {
  return { total: 0, pass: 0, fail: 0, skip: 0 };
}

function countResults(results: TestCaseResult[]): Counts {
  return {
    total: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    skip: results.filter((r) => r.status === "skip").length,
  };
}

const CHECKMARK_LINE = /^\s*([✓✗✕×↓○])\s+(.+)$/gm;
const FILE_AGGREGATE = /\b\d+\s+tests?\)/;

function statusFromMark(mark: string): TestStatus {
  if (mark === "✓") return "pass";
  if (mark === "↓" || mark === "○") return "skip";
  return "fail";
}

/** Scans `✓/✗/✕/×/↓/○` per-test lines, skipping file-level aggregate rows. */
function scanCheckmarks(output: string): TestCaseResult[] {
  const results: TestCaseResult[] = [];
  for (const m of output.matchAll(CHECKMARK_LINE)) {
    const mark = m[1] ?? "";
    const raw = m[2] ?? "";
    if (FILE_AGGREGATE.test(raw)) continue;
    const name = cleanTestName(raw);
    if (!name) continue;
    results.push({ name, status: statusFromMark(mark) });
  }
  return results;
}

// ─── Per-runner parsers ───────────────────────────────────────────────────────

function parseBun(output: string): RunnerParse {
  const results: TestCaseResult[] = [];
  for (const m of output.matchAll(/^\s*\((pass|fail|skip|todo)\)\s+(.+)$/gm)) {
    const kind = m[1] ?? "";
    const name = cleanTestName(m[2] ?? "");
    if (!name) continue;
    results.push({ name, status: kind === "pass" ? "pass" : kind === "fail" ? "fail" : "skip" });
  }
  if (results.length === 0) {
    // Real bun output also uses checkmarks instead of `(pass)`.
    results.push(...scanCheckmarks(output));
  }

  const pass = firstInt(output, /^\s*(\d+)\s+pass\s*$/m);
  const fail = firstInt(output, /^\s*(\d+)\s+fail\s*$/m);
  const skip = firstInt(output, /^\s*(\d+)\s+skip\s*$/m);
  const ran = firstInt(output, /\bRan\s+(\d+)\s+tests?\b/);
  const hasSummaryCounts = pass !== undefined || fail !== undefined || skip !== undefined;

  if (hasSummaryCounts) {
    const counts: Counts = {
      pass: pass ?? 0,
      fail: fail ?? 0,
      skip: skip ?? 0,
      total: (pass ?? 0) + (fail ?? 0) + (skip ?? 0),
    };
    return { results, counts, hasSummaryCounts };
  }
  if (ran !== undefined) {
    return { results, counts: { ...countResults(results), total: ran }, hasSummaryCounts: false };
  }
  return { results, counts: countResults(results), hasSummaryCounts: false };
}

function parseVitest(output: string): RunnerParse {
  const results = scanCheckmarks(output);
  const summaryLine = output.match(/^\s*Tests\s+([^\n]*)$/m)?.[1];
  if (summaryLine !== undefined) {
    const pass = firstInt(summaryLine, /(\d+)\s+passed/);
    const fail = firstInt(summaryLine, /(\d+)\s+failed/);
    const skip = firstInt(summaryLine, /(\d+)\s+(?:skipped|todo)/);
    const total = firstInt(summaryLine, /\((\d+)\)\s*$/);
    if (pass !== undefined || fail !== undefined || skip !== undefined || total !== undefined) {
      const counts: Counts = {
        pass: pass ?? 0,
        fail: fail ?? 0,
        skip: skip ?? 0,
        total: total ?? (pass ?? 0) + (fail ?? 0) + (skip ?? 0),
      };
      return { results, counts, hasSummaryCounts: true };
    }
  }
  return { results, counts: countResults(results), hasSummaryCounts: false };
}

function parseJest(output: string): RunnerParse {
  const results = scanCheckmarks(output);
  const summaryLine = output.match(/^Tests:\s*([^\n]*)$/m)?.[1];
  if (summaryLine !== undefined) {
    const fail = firstInt(summaryLine, /(\d+)\s+failed/);
    const pass = firstInt(summaryLine, /(\d+)\s+passed/);
    const skip = firstInt(summaryLine, /(\d+)\s+(?:skipped|todo)/);
    const total = firstInt(summaryLine, /(\d+)\s+total/);
    if (pass !== undefined || fail !== undefined || skip !== undefined || total !== undefined) {
      const counts: Counts = {
        pass: pass ?? 0,
        fail: fail ?? 0,
        skip: skip ?? 0,
        total: total ?? (pass ?? 0) + (fail ?? 0) + (skip ?? 0),
      };
      return { results, counts, hasSummaryCounts: true };
    }
  }
  return { results, counts: countResults(results), hasSummaryCounts: false };
}

function parsePytest(output: string): RunnerParse {
  const results: TestCaseResult[] = [];
  for (const m of output.matchAll(/^(?:FAILED|ERROR)\s+(\S+)/gm)) {
    const name = cleanTestName(m[1] ?? "");
    if (name) results.push({ name, status: "fail" });
  }
  for (const m of output.matchAll(/^(\S+::\S+)\s+(PASSED|FAILED|SKIPPED)\b/gm)) {
    const name = cleanTestName(m[1] ?? "");
    const kind = m[2] ?? "";
    if (!name) continue;
    const status: TestStatus = kind === "PASSED" ? "pass" : kind === "FAILED" ? "fail" : "skip";
    results.push({ name, status });
  }

  // The summary is the last line carrying `N passed|failed|error` plus `in Xs`
  // (or delimited by `=`), which avoids matching assertion messages.
  let summaryLine: string | undefined;
  for (const line of output.split("\n")) {
    if (
      /\d+\s+(?:passed|failed|errors?|skipped)\b/.test(line) &&
      (/(?:^=|\bin\s+\d+(?:\.\d+)?s?\b)/.test(line) || /^=+/.test(line))
    ) {
      summaryLine = line;
    }
  }
  if (summaryLine !== undefined) {
    const pass = firstInt(summaryLine, /(\d+)\s+passed/);
    const failed = firstInt(summaryLine, /(\d+)\s+failed/);
    const errors = firstInt(summaryLine, /(\d+)\s+errors?/);
    const skip = firstInt(summaryLine, /(\d+)\s+skipped/);
    if (pass !== undefined || failed !== undefined || errors !== undefined || skip !== undefined) {
      const counts: Counts = {
        pass: pass ?? 0,
        fail: (failed ?? 0) + (errors ?? 0),
        skip: skip ?? 0,
        total: (pass ?? 0) + (failed ?? 0) + (errors ?? 0) + (skip ?? 0),
      };
      return { results, counts, hasSummaryCounts: true };
    }
  }
  return { results, counts: countResults(results), hasSummaryCounts: false };
}

function parseGo(output: string): RunnerParse {
  const results: TestCaseResult[] = [];
  for (const m of output.matchAll(/^--- (PASS|FAIL|SKIP):\s+(\S+)/gm)) {
    const kind = m[1] ?? "";
    const name = cleanTestName(m[2] ?? "");
    if (!name) continue;
    results.push({ name, status: kind === "PASS" ? "pass" : kind === "SKIP" ? "skip" : "fail" });
  }
  if (results.length > 0) {
    return { results, counts: countResults(results), hasSummaryCounts: false };
  }
  // Footer-only run (`go test` without -v): file-level signal, one unit each.
  const okFooter = /^ok\s+\S+/m.test(output);
  const failFooter = /^FAIL\s+\S+/m.test(output);
  if (okFooter || failFooter) {
    const pass = okFooter ? 1 : 0;
    const fail = failFooter ? 1 : 0;
    return { results, counts: { total: pass + fail, pass, fail, skip: 0 }, hasSummaryCounts: true };
  }
  return { results, counts: emptyCounts(), hasSummaryCounts: false };
}

function parseForRunner(runner: TestRunner, output: string): RunnerParse {
  switch (runner) {
    case "bun":
      return parseBun(output);
    case "vitest":
      return parseVitest(output);
    case "jest":
      return parseJest(output);
    case "pytest":
      return parsePytest(output);
    case "go":
      return parseGo(output);
    default:
      return { results: [], counts: emptyCounts(), hasSummaryCounts: false };
  }
}

// ─── Unresolved reconciliation ────────────────────────────────────────────────

/**
 * Expected tests with no parser result. Conservative match: exact normalized
 * name or the parsed name contains the expected name (handles pytest node ids).
 */
function computeUnresolved(expected: string[] | undefined, results: TestCaseResult[]): string[] {
  if (!expected || expected.length === 0) return [];
  const resolved = results.filter((r) => r.status !== "none").map((r) => normalizeName(r.name));
  const unresolved: string[] = [];
  for (const entry of expected) {
    const wanted = normalizeName(entry);
    if (wanted.length === 0) continue;
    const found = resolved.some((name) => name === wanted || name.includes(wanted));
    if (!found) unresolved.push(entry);
  }
  return unresolved;
}

// ─── Parser entry point ───────────────────────────────────────────────────────

function parseTestOutputInternal(input: ParseTestInput): InternalParse {
  const warnings: string[] = [];
  const capped = capOutput(input.output);
  if (capped.warning) warnings.push(capped.warning);
  const expected = capExpected(input.expectedTests);
  if (expected.warning) warnings.push(expected.warning);

  const runner =
    input.runner !== undefined && input.runner !== "unknown"
      ? input.runner
      : detectRunner(capped.output);

  const parsed = parseForRunner(runner, capped.output);
  const results = parsed.results;
  const counts: Counts = { ...parsed.counts };
  if (counts.total === 0 && results.length > 0) counts.total = results.length;

  const unresolved = computeUnresolved(expected.expected, results);
  const hasEvidence = (parsed.hasSummaryCounts && counts.total > 0) || results.length > 0;
  const contradiction =
    input.exitCode !== undefined && (input.exitCode === 0) !== (counts.fail === 0);
  const cannotReconcile =
    expected.expected !== undefined &&
    expected.expected.length > 0 &&
    counts.total > 0 &&
    results.length === 0;
  const conclusive =
    hasEvidence &&
    !contradiction &&
    unresolved.length === 0 &&
    counts.total > 0 &&
    !cannotReconcile;
  const verdict: TestVerdict = counts.fail > 0 ? "red" : counts.total > 0 ? "green" : "none";

  return {
    runner,
    results,
    counts,
    verdict,
    conclusive,
    unresolved,
    warnings,
    hasSummaryCounts: parsed.hasSummaryCounts,
  };
}

/**
 * Deterministic parser. Never throws, never touches the network.
 *
 * @param input - Raw output plus optional exit code, expected tests, runner.
 * @returns Parsed results/counts, a deterministic verdict, and whether the
 *   evidence is `conclusive` (i.e. JEV is not needed).
 */
export function parseTestOutput(input: ParseTestInput): ParsedTestOutput {
  const internal = parseTestOutputInternal(input);
  return {
    runner: internal.runner,
    results: internal.results,
    counts: internal.counts,
    verdict: internal.verdict,
    conclusive: internal.conclusive,
    unresolved: internal.unresolved,
    warnings: internal.warnings,
  };
}

// ─── JEV classification ───────────────────────────────────────────────────────

function buildTestQuestions(names: string[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  names.forEach((name, index) => {
    questions[`test_${index}`] = choice(`What is the status of test "${name}"?`, {
      pass: "The test executed and passed.",
      fail: "The test executed and failed.",
      skip: "The test was skipped or not executed.",
      none: "No evidence is available for this test.",
    });
  });
  questions.verdict = choice("What is the overall verdict of this test battery?", {
    green: "Zero failures; skips allowed.",
    red: "At least one confirmed failure.",
    mixed: "Partial/uncertain evidence: some results known, some unresolved.",
    none: "No usable data.",
  });
  return questions;
}

function buildTestState(
  output: string,
  parsed: InternalParse,
  expected: string[] | undefined,
  input: JevTestsInput,
): Record<string, unknown> {
  const state: Record<string, unknown> = {
    output,
    runner: parsed.runner,
    parsed: {
      total: parsed.counts.total,
      pass: parsed.counts.pass,
      fail: parsed.counts.fail,
      skip: parsed.counts.skip,
    },
  };
  if (input.exitCode !== undefined) state.exitCode = input.exitCode;
  if (expected !== undefined && expected.length > 0) state.expectedTests = expected;
  const context = input.context?.trim();
  if (context) state.context = context;
  return state;
}

function recomputeCounts(
  parsed: InternalParse,
  jevResults: TestCaseResult[],
  allResults: TestCaseResult[],
): Counts {
  const counts: Counts = parsed.hasSummaryCounts
    ? { ...parsed.counts }
    : {
        total: 0,
        pass: parsed.results.filter((r) => r.status === "pass").length,
        fail: parsed.results.filter((r) => r.status === "fail").length,
        skip: parsed.results.filter((r) => r.status === "skip").length,
      };
  for (const r of jevResults) {
    if (r.status === "pass") counts.pass += 1;
    else if (r.status === "fail") counts.fail += 1;
    else if (r.status === "skip") counts.skip += 1;
  }
  counts.total = Math.max(
    parsed.counts.total,
    allResults.length,
    counts.pass + counts.fail + counts.skip,
  );
  return counts;
}

/**
 * Classify a test battery. Deterministic parser first; JEV resolves the
 * unresolved tests and proposes a verdict. Always resolves; never rejects.
 *
 * @param input - Raw output plus optional exit code, expected tests, runner, context.
 * @param cfg - JEV config (`enabled`, `model`, `timeoutMs`).
 * @param deps - Injectable apiKey/clientFactory/log (tests).
 * @returns A full decision: verdict, source, runner, results, counts, warnings.
 */
export async function classifyTestsWithJev(
  input: JevTestsInput,
  cfg: JevConfig,
  deps: JevClassifierDeps = {},
): Promise<JevTestsDecision> {
  const parsed = parseTestOutputInternal({
    output: input.output,
    ...(input.exitCode !== undefined && { exitCode: input.exitCode }),
    ...(input.expectedTests !== undefined && { expectedTests: input.expectedTests }),
    ...(input.runner !== undefined && { runner: input.runner }),
  });
  const warnings = [...parsed.warnings];

  if (parsed.conclusive) {
    return {
      verdict: parsed.verdict,
      source: "parser",
      runner: parsed.runner,
      results: parsed.results,
      counts: { ...parsed.counts, unresolved: 0 },
      warnings,
    };
  }

  const capped = capOutput(input.output);
  const cappedExpected = capExpected(input.expectedTests).expected;
  const unresolvedAll = parsed.unresolved;
  const asked = unresolvedAll.slice(0, MAX_JEV_TEST_QUESTIONS);
  if (unresolvedAll.length > asked.length) {
    warnings.push(
      `${unresolvedAll.length} unresolved tests exceed the ${MAX_JEV_TEST_QUESTIONS} question cap; ${unresolvedAll.length - asked.length} left to the deterministic fallback`,
    );
  }

  const questions = buildTestQuestions(asked);
  const state = buildTestState(capped.output, parsed, cappedExpected, input);
  const answers = await callJev(state, questions, cfg, deps);

  const results: TestCaseResult[] = [...parsed.results];
  const jevResults: TestCaseResult[] = [];
  let validFields = 0;
  let jevVerdict: TestVerdict | undefined;

  if (answers) {
    asked.forEach((name, index) => {
      const status = pickChoice(answers[`test_${index}`], TEST_STATUSES);
      if (status !== undefined && status !== "none") {
        jevResults.push({ name, status });
        results.push({ name, status });
        validFields += 1;
      }
    });
    const verdict = pickChoice(answers.verdict, TEST_VERDICTS);
    if (verdict !== undefined) {
      jevVerdict = verdict;
      validFields += 1;
    }
  }

  const resolvedByJev = new Set(jevResults.map((r) => normalizeName(r.name)));
  const remainingUnresolved = unresolvedAll.filter((n) => !resolvedByJev.has(normalizeName(n)));

  const contradiction =
    input.exitCode !== undefined && (input.exitCode === 0) !== (parsed.counts.fail === 0);
  let verdict: TestVerdict;
  if (parsed.counts.fail > 0) {
    verdict = "red";
    if (jevVerdict !== undefined && jevVerdict !== "red") {
      warnings.push(
        `JEV verdict "${jevVerdict}" contradicts ${parsed.counts.fail} parsed failure(s); keeping "red"`,
      );
    }
  } else if (jevVerdict !== undefined) {
    verdict = jevVerdict;
  } else {
    const hasEvidence = parsed.counts.total > 0 || results.length > 0;
    if (!hasEvidence) {
      verdict = "none";
    } else if (
      parsed.counts.fail === 0 &&
      parsed.counts.total > 0 &&
      remainingUnresolved.length === 0 &&
      !contradiction
    ) {
      verdict = "green";
    } else {
      verdict = "mixed";
    }
  }

  let source: "parser" | "jev" | "fallback";
  if (validFields > 0) {
    source = "jev";
  } else {
    source = "fallback";
    warnings.push("JEV unavailable — deterministic fallback");
  }

  const counts = recomputeCounts(parsed, jevResults, results);
  return {
    verdict,
    source,
    runner: parsed.runner,
    results,
    counts: { ...counts, unresolved: remainingUnresolved.length },
    warnings,
  };
}
