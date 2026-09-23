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
  buildRiskState,
  classifyCodeRiskWithJev,
  MAX_JEV_RISK_FINDINGS,
  TRAFFIC_LIGHTS,
} from "./jev-risk.ts";
import type { RiskFinding } from "./risk-patterns.ts";

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

// ─── Synthetic unified diffs ──────────────────────────────────────────────────

/** Hunk with only benign code. */
const benignDiff = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  " export { a };",
].join("\n");

/** Hunk introducing a high-severity injection pattern. */
const evalDiff = ["@@ -1,2 +1,3 @@", " const x = 1;", '+const y = eval("1 + 1");'].join("\n");

/** Hunk introducing a medium-severity test-suppression pattern. */
const mediumDiff = [
  "@@ -1,3 +1,4 @@",
  ' describe("suite", () => {',
  '-  test("works", () => {});',
  '+  test.skip("works", () => {});',
  " });",
].join("\n");

/** Hunk introducing a low-severity insecure-URL pattern. */
const lowDiff = [
  "@@ -1,2 +1,3 @@",
  ' const secure = "https://example.com";',
  '+const insecure = "http://insecure.example.com";',
].join("\n");

/** Not a unified diff at all (no hunk header). */
const garbageDiff = "this is not a diff at all\njust random text\n";

const emptyDiff = "   \n\t\n";

/** Benign diff larger than the scanner's 100 KiB cap. */
const bigBenignDiff = [
  "diff --git a/a.txt b/a.txt",
  "@@ -1,1 +1,2 @@",
  " line",
  `+${"x".repeat(110_000)}`,
].join("\n");

const mediumAnswer = { answers: { light: answer("yellow") } };

beforeEach(() => {
  resetJevWarningState();
});

describe("classifyCodeRiskWithJev — deterministic rules", () => {
  test("empty diff → none, source rules, JEV never called", async () => {
    const { deps, factoryCalls } = depsWith(async () => mediumAnswer);
    const decision = await classifyCodeRiskWithJev({ diff: emptyDiff }, cfg(), deps);
    expect(decision.light).toBe("none");
    expect(decision.source).toBe("rules");
    expect(decision.findings).toEqual([]);
    expect(decision.maxSeverity).toBeUndefined();
    expect(factoryCalls()).toBe(0);
  });

  test("unreadable diff (no hunk header) → none, JEV never called", async () => {
    const { deps, factoryCalls } = depsWith(async () => mediumAnswer);
    const decision = await classifyCodeRiskWithJev({ diff: garbageDiff }, cfg(), deps);
    expect(decision.light).toBe("none");
    expect(decision.source).toBe("rules");
    expect(factoryCalls()).toBe(0);
  });

  test("hunk with only benign code → green, no JEV", async () => {
    const { deps, factoryCalls } = depsWith(async () => mediumAnswer);
    const decision = await classifyCodeRiskWithJev({ diff: benignDiff }, cfg(), deps);
    expect(decision.light).toBe("green");
    expect(decision.source).toBe("rules");
    expect(decision.findings).toEqual([]);
    expect(factoryCalls()).toBe(0);
  });

  test("high-severity pattern (eval) → red, source rules, no JEV", async () => {
    const { deps, factoryCalls } = depsWith(async () => ({ answers: { light: answer("green") } }));
    const decision = await classifyCodeRiskWithJev({ diff: evalDiff }, cfg(), deps);
    expect(decision.light).toBe("red");
    expect(decision.source).toBe("rules");
    expect(decision.maxSeverity).toBe("high");
    expect(decision.findings.some((f) => f.severity === "high")).toBe(true);
    expect(factoryCalls()).toBe(0);
  });
});

describe("classifyCodeRiskWithJev — JEV refines low/medium", () => {
  test("medium findings + JEV yellow → source jev, light yellow, no advisory warning", async () => {
    const { deps, calls } = depsWith(async () => mediumAnswer);
    const decision = await classifyCodeRiskWithJev({ diff: mediumDiff }, cfg(), deps);
    expect(decision.light).toBe("yellow");
    expect(decision.source).toBe("jev");
    expect(decision.maxSeverity).toBe("medium");
    expect(decision.findings.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(decision.warnings.some((w) => w.includes("deterministic fallback expected"))).toBe(
      false,
    );
  });

  test("medium findings + JEV red → light red accepted with advisory warning", async () => {
    const { deps } = depsWith(async () => ({ answers: { light: answer("red") } }));
    const decision = await classifyCodeRiskWithJev({ diff: mediumDiff }, cfg(), deps);
    expect(decision.light).toBe("red");
    expect(decision.source).toBe("jev");
    expect(decision.warnings.length).toBeGreaterThan(0);
    expect(decision.warnings.some((w) => w.includes("expected"))).toBe(true);
  });

  test("low findings + JEV green → source jev, light green, advisory warning", async () => {
    const { deps } = depsWith(async () => ({ answers: { light: answer("green") } }));
    const decision = await classifyCodeRiskWithJev({ diff: lowDiff }, cfg(), deps);
    expect(decision.light).toBe("green");
    expect(decision.source).toBe("jev");
    expect(decision.maxSeverity).toBe("low");
    expect(decision.warnings.length).toBeGreaterThan(0);
  });

  test("JEV disabled → deterministic fallback yellow with warning", async () => {
    const { deps, factoryCalls } = depsWith(async () => mediumAnswer);
    const decision = await classifyCodeRiskWithJev(
      { diff: mediumDiff },
      cfg({ enabled: false }),
      deps,
    );
    expect(decision.light).toBe("yellow");
    expect(decision.source).toBe("fallback");
    expect(decision.maxSeverity).toBe("medium");
    expect(decision.warnings.some((w) => w.includes("fallback"))).toBe(true);
    expect(factoryCalls()).toBe(0);
  });

  test("missing API key → fallback yellow, factory never called", async () => {
    const { deps, factoryCalls } = depsWith(async () => mediumAnswer, "");
    const decision = await classifyCodeRiskWithJev({ diff: mediumDiff }, cfg(), deps);
    expect(decision.light).toBe("yellow");
    expect(decision.source).toBe("fallback");
    expect(factoryCalls()).toBe(0);
  });

  test("API error → fallback yellow (never throws)", async () => {
    const { deps } = depsWith(async () => {
      throw new Error("API down");
    });
    const decision = await classifyCodeRiskWithJev({ diff: mediumDiff }, cfg(), deps);
    expect(decision.light).toBe("yellow");
    expect(decision.source).toBe("fallback");
    expect(decision.warnings.some((w) => w.includes("fallback"))).toBe(true);
  });

  test("timeout → fallback yellow and resolves before the slow response", async () => {
    const { deps } = depsWith(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ answers: { light: answer("green") } }), 50),
        ),
    );
    const started = Date.now();
    const decision = await classifyCodeRiskWithJev(
      { diff: mediumDiff },
      cfg({ timeoutMs: 10 }),
      deps,
    );
    expect(decision.light).toBe("yellow");
    expect(decision.source).toBe("fallback");
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("invalid JEV answer → fallback yellow + warning", async () => {
    const { deps } = depsWith(async () => ({ answers: { light: answer("nonsense") } }));
    const decision = await classifyCodeRiskWithJev({ diff: mediumDiff }, cfg(), deps);
    expect(decision.light).toBe("yellow");
    expect(decision.source).toBe("fallback");
    expect(decision.warnings.some((w) => w.includes("invalid"))).toBe(true);
  });

  test("no answers at all → fallback yellow + warning", async () => {
    const { deps } = depsWith(async () => ({}));
    const decision = await classifyCodeRiskWithJev({ diff: mediumDiff }, cfg(), deps);
    expect(decision.light).toBe("yellow");
    expect(decision.source).toBe("fallback");
    expect(decision.warnings.length).toBeGreaterThan(0);
  });
});

describe("classifyCodeRiskWithJev — state, findings and truncation", () => {
  test("findings carry file/line and truncated is false for a normal diff", async () => {
    const { deps } = depsWith(async () => mediumAnswer);
    const decision = await classifyCodeRiskWithJev({ diff: mediumDiff }, cfg(), deps);
    expect(decision.truncated).toBe(false);
    for (const finding of decision.findings) {
      expect(typeof finding.file).toBe("string");
      expect(typeof finding.line).toBe("number");
    }
  });

  test("truncated is propagated for a diff over the byte cap", async () => {
    const { deps, factoryCalls } = depsWith(async () => mediumAnswer);
    const decision = await classifyCodeRiskWithJev({ diff: bigBenignDiff }, cfg(), deps);
    expect(decision.truncated).toBe(true);
    expect(decision.warnings.length).toBeGreaterThan(0);
    // No findings in the oversized benign diff → deterministic green, no JEV.
    expect(decision.light).toBe("green");
    expect(factoryCalls()).toBe(0);
  });

  test("state has diff + findings and omits empty context; questions keys = [light]", async () => {
    const { deps, calls } = depsWith(async () => mediumAnswer);
    await classifyCodeRiskWithJev({ diff: mediumDiff }, cfg({ model: "custom-model" }), deps);
    expect(calls).toHaveLength(1);
    const req = calls[0];
    if (!req) throw new Error("expected one captured request");
    const state = req.state as Record<string, unknown>;
    expect(state.diff).toBe(mediumDiff);
    expect(Array.isArray(state.findings)).toBe(true);
    expect((state.findings as unknown[]).length).toBeLessThanOrEqual(MAX_JEV_RISK_FINDINGS);
    expect(state.context).toBeUndefined();
    expect(req.model).toBe("custom-model");
    expect(Object.keys(req.questions)).toEqual(["light"]);
  });

  test("state includes trimmed context when present", async () => {
    const { deps, calls } = depsWith(async () => mediumAnswer);
    await classifyCodeRiskWithJev({ diff: mediumDiff, context: "  PR #42  " }, cfg(), deps);
    const state = calls[0]?.state as Record<string, unknown>;
    expect(state.context).toBe("PR #42");

    const blank = depsWith(async () => mediumAnswer);
    await classifyCodeRiskWithJev({ diff: mediumDiff, context: "   " }, cfg(), blank.deps);
    const blankState = blank.calls[0]?.state as Record<string, unknown>;
    expect(blankState.context).toBeUndefined();
  });

  test("buildRiskState caps findings to MAX_JEV_RISK_FINDINGS with a warning", () => {
    const fake: RiskFinding[] = Array.from({ length: 35 }, (_, i) => ({
      patternId: `pattern-${i}`,
      category: "test",
      severity: "medium",
      file: "src/a.ts",
      line: i + 1,
      snippet: "danger",
      description: "synthetic",
    }));
    const { state, warning } = buildRiskState({ diff: mediumDiff }, fake);
    expect(warning).toBe(`state truncated to ${MAX_JEV_RISK_FINDINGS} findings`);
    const forwarded = state.findings as unknown[];
    expect(forwarded.length).toBe(MAX_JEV_RISK_FINDINGS);
    const first = forwarded[0] as Record<string, unknown>;
    expect(first.id).toBe("pattern-0");
    expect(first.severity).toBe("medium");
    expect(first.line).toBe(1);
  });

  test("buildRiskState forwards everything when under the cap", () => {
    const fake: RiskFinding[] = [
      {
        patternId: "p1",
        category: "test",
        severity: "low",
        file: "b.ts",
        line: 7,
        snippet: "s",
        description: "d",
      },
    ];
    const { state, warning } = buildRiskState({ diff: mediumDiff }, fake);
    expect(warning).toBeUndefined();
    expect((state.findings as unknown[]).length).toBe(1);
  });

  test("enum is exposed with the expected members", () => {
    expect([...TRAFFIC_LIGHTS]).toEqual(["green", "yellow", "red", "none"]);
  });
});
