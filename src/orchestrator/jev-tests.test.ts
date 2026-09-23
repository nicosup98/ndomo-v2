import { beforeEach, describe, expect, test } from "bun:test";
import type { JevConfig } from "../config/schema.ts";
import type {
  JevClassifierDeps,
  JevClientLike,
  JevRequestOptions,
  JevSystemOneRequest,
} from "./jev.ts";
import { resetJevWarningState } from "./jev.ts";
import {
  classifyTestsWithJev,
  EXPECTED_TESTS_MAX,
  MAX_JEV_TEST_QUESTIONS,
  parseTestOutput,
  RAW_OUTPUT_MAX_BYTES,
} from "./jev-tests.ts";

/** Helper: build a JevConfig with defaults. */
const cfg = (overrides: Partial<JevConfig> = {}): JevConfig => ({
  enabled: true,
  model: "jev-latest",
  timeoutMs: 3000,
  ...overrides,
});

/** Helper: a valid choice answer. */
const answer = (choiceValue: string) => ({
  type: "choice",
  choice: choiceValue,
  confidence: 0.9,
});

type Impl = (
  req: JevSystemOneRequest,
  opts?: JevRequestOptions,
) => Promise<{ answers?: Record<string, unknown> }>;

/** Helper: injectable deps whose factory records calls; zero network. */
function depsWith(
  impl: Impl,
  apiKey = "test-key",
): {
  deps: JevClassifierDeps;
  calls: JevSystemOneRequest[];
  opts: JevRequestOptions[];
  factoryCalls: () => number;
} {
  const calls: JevSystemOneRequest[] = [];
  const opts: JevRequestOptions[] = [];
  let factoryCalls = 0;
  const deps: JevClassifierDeps = {
    apiKey,
    log: () => {},
    clientFactory: (): JevClientLike => {
      factoryCalls += 1;
      return {
        systemOne: async (req, requestOpts) => {
          calls.push(req);
          if (requestOpts) opts.push(requestOpts);
          return impl(req, requestOpts);
        },
      };
    },
  };
  return { deps, calls, opts, factoryCalls: () => factoryCalls };
}

// ─── Realistic fixtures ───────────────────────────────────────────────────────

const BUN_ALL_PASS = `bun test v1.1.20 (abc123)

src/math.test.ts:
(pass) adds numbers [0.12ms]
(pass) subtracts numbers [0.05ms]
(pass) handles zero [0.02ms]

 3 pass
 0 fail
 0 skip
Ran 3 tests across 1 file. [12.00ms]
`;

const BUN_ONE_FAIL = `bun test v1.1.20 (abc123)

src/math.test.ts:
(pass) adds numbers [0.12ms]
(fail) divides by zero [0.08ms]

 1 pass
 1 fail
 0 skip
Ran 2 tests across 1 file. [10.00ms]
`;

const BUN_WITH_SKIP = `bun test v1.1.20 (abc123)

src/math.test.ts:
(pass) adds numbers [0.12ms]
(pass) subtracts numbers [0.05ms]
(skip) windows-only path

 2 pass
 0 fail
 1 skip
Ran 3 tests across 1 file. [11.00ms]
`;

const VITEST_ALL_PASS = ` RUN  v4.0.0 /repo

 ✓ test/math.test.ts (3 tests) 8ms
   ✓ adds
   ✓ subtracts
   ✓ handles zero

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  10:00:00
   Duration  120ms
`;

const VITEST_FAILED = ` RUN  v4.0.0 /repo

 ✓ test/math.test.ts (2 tests) 5ms
   ✓ works
   × breaks

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
`;

const JEST_MIXED = `PASS src/a.test.ts
FAIL src/b.test.ts
  ✓ a works
  ✗ b breaks
  ○ b skipped

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 1 passed, 1 skipped, 3 total
Snapshots:   0 total
`;

const PYTEST_FAILED = `============================= test session starts ==============================
collected 3 items

tests/test_math.py::test_add PASSED
tests/test_math.py::test_sub FAILED
tests/test_math.py::test_mul PASSED

=================================== FAILURES ===================================
_________________________________ test_sub _________________________________

    assert 1 == 2
E   assert 1 == 2

========================= 1 failed, 2 passed in 0.05s =========================
`;

const PYTEST_ALL_PASS = `============================= test session starts ==============================
collected 3 items

tests/test_math.py::test_add PASSED
tests/test_math.py::test_sub PASSED
tests/test_math.py::test_mul PASSED

============================== 3 passed in 0.05s ==============================
`;

const GO_ALL_PASS = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSub
--- PASS: TestSub (0.00s)
PASS
ok  \texample.com/math\t0.005s
`;

const GO_FAILED = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestSub
--- FAIL: TestSub (0.00s)
FAIL
FAIL\texample.com/math\t0.006s
`;

const GARBAGE = `some random log output
nothing test-like here
still no summary
`;

beforeEach(() => {
  resetJevWarningState();
});

// ─── Deterministic parser (short-circuit, no JEV) ─────────────────────────────

describe("classifyTestsWithJev: conclusive parser path", () => {
  test("1. bun all-pass exit 0 → green, source parser, conclusive, no JEV call", async () => {
    const { deps, factoryCalls } = depsWith(async () => ({
      answers: { verdict: answer("red") },
    }));
    const decision = await classifyTestsWithJev(
      { output: BUN_ALL_PASS, exitCode: 0, runner: "bun" },
      cfg(),
      deps,
    );
    expect(decision.verdict).toBe("green");
    expect(decision.source).toBe("parser");
    expect(decision.runner).toBe("bun");
    expect(decision.counts).toEqual({ total: 3, pass: 3, fail: 0, skip: 0, unresolved: 0 });
    expect(decision.results).toHaveLength(3);
    expect(factoryCalls()).toBe(0);
  });

  test("2. bun 1 fail exit 1 → red, conclusive without JEV", async () => {
    const { deps, factoryCalls } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev(
      { output: BUN_ONE_FAIL, exitCode: 1, runner: "bun" },
      cfg(),
      deps,
    );
    expect(decision.verdict).toBe("red");
    expect(decision.source).toBe("parser");
    expect(decision.counts.fail).toBe(1);
    expect(decision.results).toContainEqual({ name: "divides by zero", status: "fail" });
    expect(factoryCalls()).toBe(0);
  });

  test("3. bun summary with skip → green (skips allowed)", async () => {
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev(
      { output: BUN_WITH_SKIP, exitCode: 0, runner: "bun" },
      cfg(),
      deps,
    );
    expect(decision.verdict).toBe("green");
    expect(decision.counts).toEqual({ total: 3, pass: 2, fail: 0, skip: 1, unresolved: 0 });
  });

  test("4. vitest 'Tests  3 passed (3)' exit 0 → green", async () => {
    const { deps, factoryCalls } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev(
      { output: VITEST_ALL_PASS, exitCode: 0 },
      cfg(),
      deps,
    );
    expect(decision.verdict).toBe("green");
    expect(decision.runner).toBe("vitest");
    expect(decision.source).toBe("parser");
    expect(factoryCalls()).toBe(0);
  });

  test("5. vitest failed → red", async () => {
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev(
      { output: VITEST_FAILED, exitCode: 1 },
      cfg(),
      deps,
    );
    expect(decision.verdict).toBe("red");
    expect(decision.counts.fail).toBe(1);
  });

  test("6. jest mixed summary → red and counts are correct", async () => {
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev({ output: JEST_MIXED, exitCode: 1 }, cfg(), deps);
    expect(decision.runner).toBe("jest");
    expect(decision.verdict).toBe("red");
    expect(decision.counts).toEqual({ total: 3, pass: 1, fail: 1, skip: 1, unresolved: 0 });
  });

  test("7. pytest FAILED + summary → red with the failed test in results", async () => {
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev(
      { output: PYTEST_FAILED, exitCode: 1 },
      cfg(),
      deps,
    );
    expect(decision.runner).toBe("pytest");
    expect(decision.verdict).toBe("red");
    expect(decision.counts).toEqual({ total: 3, pass: 2, fail: 1, skip: 0, unresolved: 0 });
    expect(decision.results).toContainEqual({
      name: "tests/test_math.py::test_sub",
      status: "fail",
    });
  });

  test("8. pytest all passed → green", async () => {
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev(
      { output: PYTEST_ALL_PASS, exitCode: 0 },
      cfg(),
      deps,
    );
    expect(decision.runner).toBe("pytest");
    expect(decision.verdict).toBe("green");
    expect(decision.counts).toEqual({ total: 3, pass: 3, fail: 0, skip: 0, unresolved: 0 });
  });

  test("9. go --- PASS + ok footer exit 0 → green", async () => {
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev({ output: GO_ALL_PASS, exitCode: 0 }, cfg(), deps);
    expect(decision.runner).toBe("go");
    expect(decision.verdict).toBe("green");
    expect(decision.results).toContainEqual({ name: "TestAdd", status: "pass" });
  });

  test("10. go --- FAIL + FAIL footer → red", async () => {
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev({ output: GO_FAILED, exitCode: 1 }, cfg(), deps);
    expect(decision.runner).toBe("go");
    expect(decision.verdict).toBe("red");
    expect(decision.results).toContainEqual({ name: "TestSub", status: "fail" });
  });
});

// ─── Ambiguity → JEV ──────────────────────────────────────────────────────────

describe("classifyTestsWithJev: ambiguous path uses JEV", () => {
  test("11. garbage output + JEV mock → source jev, verdict green", async () => {
    const { deps, calls } = depsWith(async () => ({
      answers: {
        test_0: answer("pass"),
        test_1: answer("pass"),
        verdict: answer("green"),
      },
    }));
    const decision = await classifyTestsWithJev(
      { output: GARBAGE, expectedTests: ["alpha", "beta"] },
      cfg(),
      deps,
    );
    expect(decision.source).toBe("jev");
    expect(decision.verdict).toBe("green");
    expect(decision.results).toEqual([
      { name: "alpha", status: "pass" },
      { name: "beta", status: "pass" },
    ]);
    expect(calls).toHaveLength(1);
  });

  test("12. exitCode contradicts parsed pass → !conclusive; JEV disabled → fallback mixed", async () => {
    const { deps, factoryCalls } = depsWith(async () => ({ answers: {} }));
    const parsed = parseTestOutput({ output: BUN_ALL_PASS, exitCode: 1, runner: "bun" });
    expect(parsed.conclusive).toBe(false);

    const decision = await classifyTestsWithJev(
      { output: BUN_ALL_PASS, exitCode: 1, runner: "bun" },
      cfg({ enabled: false }),
      deps,
    );
    expect(decision.source).toBe("fallback");
    expect(decision.verdict).toBe("mixed");
    expect(decision.warnings.some((w) => w.includes("fallback"))).toBe(true);
    expect(factoryCalls()).toBe(0);
  });

  test("13. unresolved expected test resolved by JEV → red, bar added to results", async () => {
    const { deps } = depsWith(async () => ({
      answers: { test_0: answer("fail"), verdict: answer("red") },
    }));
    const parsed = parseTestOutput({
      output: "(pass) foo\n 1 pass\n 0 fail\n 0 skip\nRan 1 tests across 1 file.\n",
      runner: "bun",
      expectedTests: ["foo", "bar"],
    });
    expect(parsed.unresolved).toEqual(["bar"]);

    const decision = await classifyTestsWithJev(
      {
        output: "(pass) foo\n 1 pass\n 0 fail\n 0 skip\nRan 1 tests across 1 file.\n",
        runner: "bun",
        expectedTests: ["foo", "bar"],
      },
      cfg(),
      deps,
    );
    expect(decision.source).toBe("jev");
    expect(decision.verdict).toBe("red");
    expect(decision.results).toContainEqual({ name: "bar", status: "fail" });
    expect(decision.counts.unresolved).toBe(0);
  });

  test("14. 25 unresolved → at most 20 test_* questions (+ warning)", async () => {
    const expected = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const { deps, calls } = depsWith(async () => ({ answers: {} }));
    const decision = await classifyTestsWithJev(
      { output: GARBAGE, expectedTests: expected },
      cfg(),
      deps,
    );
    expect(calls).toHaveLength(1);
    const questions = calls[0]?.questions ?? {};
    const keys = Object.keys(questions);
    expect(keys.length).toBeLessThanOrEqual(MAX_JEV_TEST_QUESTIONS + 1);
    expect(keys.filter((k) => k.startsWith("test_"))).toHaveLength(MAX_JEV_TEST_QUESTIONS);
    expect(decision.warnings.some((w) => w.includes("cap"))).toBe(true);
  });

  test("15. caps: raw output 70KB truncated, expectedTests 60 capped to 50", () => {
    const junk = "noise ".repeat(12 * 1024); // ~72 KB of leading noise
    const output = `${junk}\n 3 pass\n 0 fail\n 0 skip\nRan 3 tests across 1 file.\n`;
    const expected = Array.from({ length: 60 }, (_, i) => `case_${i}`);
    const parsed = parseTestOutput({ output, expectedTests: expected, runner: "bun" });
    expect(parsed.warnings.some((w) => w.includes("truncated"))).toBe(true);
    expect(parsed.warnings.some((w) => w.includes("expectedTests"))).toBe(true);
    // Tail was kept: the bun summary survived truncation.
    expect(parsed.counts.total).toBe(3);
    expect(parsed.unresolved).toHaveLength(EXPECTED_TESTS_MAX);
  });

  test("16. blank apiKey / enabled=false with ambiguity → fallback, factory never called", async () => {
    const blank = depsWith(async () => ({ answers: { verdict: answer("green") } }), "");
    const blankDecision = await classifyTestsWithJev(
      { output: GARBAGE, expectedTests: ["a"] },
      cfg(),
      blank.deps,
    );
    expect(blankDecision.source).toBe("fallback");
    expect(blankDecision.verdict).toBe("none");
    expect(blank.factoryCalls()).toBe(0);

    const disabled = depsWith(async () => ({ answers: { verdict: answer("green") } }));
    const disabledDecision = await classifyTestsWithJev(
      { output: GARBAGE, expectedTests: ["a"] },
      cfg({ enabled: false }),
      disabled.deps,
    );
    expect(disabledDecision.source).toBe("fallback");
    expect(disabled.factoryCalls()).toBe(0);
  });

  test("17. JEV error/timeout → never throws, deterministic fallback + warnings", async () => {
    const { deps } = depsWith(async () => {
      throw new Error("API down");
    });
    const decision = await classifyTestsWithJev(
      { output: BUN_ALL_PASS, exitCode: 1, runner: "bun", expectedTests: ["missing"] },
      cfg(),
      deps,
    );
    expect(decision.source).toBe("fallback");
    expect(decision.verdict).toBe("mixed");
    expect(decision.warnings.some((w) => w.includes("fallback"))).toBe(true);
  });
});

// ─── Parser internals ─────────────────────────────────────────────────────────

describe("parseTestOutput: runner detection", () => {
  test("18. detects each runner from its signature markers", () => {
    expect(parseTestOutput({ output: BUN_ALL_PASS }).runner).toBe("bun");
    expect(parseTestOutput({ output: VITEST_ALL_PASS }).runner).toBe("vitest");
    expect(parseTestOutput({ output: JEST_MIXED }).runner).toBe("jest");
    expect(parseTestOutput({ output: PYTEST_FAILED }).runner).toBe("pytest");
    expect(parseTestOutput({ output: GO_ALL_PASS }).runner).toBe("go");
    expect(parseTestOutput({ output: GARBAGE }).runner).toBe("unknown");
  });

  test("18b. explicit runner overrides auto-detection", () => {
    const parsed = parseTestOutput({ output: GARBAGE, runner: "vitest" });
    expect(parsed.runner).toBe("vitest");
  });

  test("18c. RAW_OUTPUT_MAX_BYTES is 64 KiB", () => {
    expect(RAW_OUTPUT_MAX_BYTES).toBe(64 * 1024);
  });
});
