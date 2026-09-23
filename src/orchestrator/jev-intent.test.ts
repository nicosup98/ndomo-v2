import { beforeEach, describe, expect, test } from "bun:test";
import type { JevConfig } from "../config/schema.ts";
import type {
  JevClassifierDeps,
  JevClientLike,
  JevRequestOptions,
  JevSystemOneRequest,
} from "./jev.ts";
import { resetJevWarningState } from "./jev.ts";
import { classifyIntentWithJev, JEV_FLOWS, JEV_INTENTS } from "./jev-intent.ts";

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

const input = { prompt: "fix the null pointer when the parser sees EOF" };

beforeEach(() => {
  resetJevWarningState();
});

describe("classifyIntentWithJev", () => {
  test("happy path: both valid choices → {intent, flow, warnings: []}", async () => {
    const { deps } = depsWith(async () => ({
      answers: { intent: answer("bugfix"), flow: answer("adhoc") },
    }));
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision).toEqual({ intent: "bugfix", flow: "adhoc", warnings: [] });
  });

  test("invalid flow → intent kept, flow undefined, no null", async () => {
    const { deps } = depsWith(async () => ({
      answers: { intent: answer("feature"), flow: answer("nonsense") },
    }));
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision).toEqual({ intent: "feature", warnings: [] });
    expect(decision?.flow).toBeUndefined();
  });

  test("invalid intent → flow kept", async () => {
    const { deps } = depsWith(async () => ({
      answers: { intent: answer("not-an-intent"), flow: answer("plan") },
    }));
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision).toEqual({ flow: "plan", warnings: [] });
    expect(decision?.intent).toBeUndefined();
  });

  test("both invalid → null", async () => {
    const { deps } = depsWith(async () => ({
      answers: { intent: answer("nope"), flow: answer("also-nope") },
    }));
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision).toBeNull();
  });

  test("answers missing entirely ({}) → null", async () => {
    const { deps } = depsWith(async () => ({}));
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision).toBeNull();
  });

  test("API error (throw) → null, never throws", async () => {
    const { deps } = depsWith(async () => {
      throw new Error("API down");
    });
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision).toBeNull();
  });

  test("timeout → null and resolves before the slow response", async () => {
    const { deps } = depsWith(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ answers: { intent: answer("feature") } }), 50),
        ),
    );
    const started = Date.now();
    const decision = await classifyIntentWithJev(input, cfg({ timeoutMs: 10 }), deps);
    expect(decision).toBeNull();
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("missing API key → null and factory is never called", async () => {
    const { deps, factoryCalls } = depsWith(
      async () => ({
        answers: { intent: answer("feature"), flow: answer("plan") },
      }),
      "",
    );
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision).toBeNull();
    expect(factoryCalls()).toBe(0);
  });

  test("enabled=false → null and factory is never called", async () => {
    const { deps, factoryCalls } = depsWith(async () => ({
      answers: { intent: answer("feature"), flow: answer("plan") },
    }));
    const decision = await classifyIntentWithJev(input, cfg({ enabled: false }), deps);
    expect(decision).toBeNull();
    expect(factoryCalls()).toBe(0);
  });

  test("state: prompt only without context; prompt+context with one; blank context omitted", async () => {
    const withCtx = depsWith(async () => ({ answers: { intent: answer("other") } }));
    await classifyIntentWithJev({ prompt: "p", context: "  ctx  " }, cfg(), withCtx.deps);
    expect(withCtx.calls[0]?.state).toEqual({ prompt: "p", context: "ctx" });

    const withoutCtx = depsWith(async () => ({ answers: { intent: answer("other") } }));
    await classifyIntentWithJev({ prompt: "p" }, cfg(), withoutCtx.deps);
    expect(withoutCtx.calls[0]?.state).toEqual({ prompt: "p" });

    const blankCtx = depsWith(async () => ({ answers: { intent: answer("other") } }));
    await classifyIntentWithJev({ prompt: "p", context: "   " }, cfg(), blankCtx.deps);
    expect(blankCtx.calls[0]?.state).toEqual({ prompt: "p" });
  });

  test("questions keys = [flow, intent] and cfg model is sent", async () => {
    const { deps, calls } = depsWith(async () => ({
      answers: { intent: answer("refactor"), flow: answer("plan") },
    }));
    await classifyIntentWithJev(input, cfg({ model: "custom-model" }), deps);
    expect(calls).toHaveLength(1);
    const req = calls[0];
    if (!req) throw new Error("expected one captured request");
    expect(Object.keys(req.questions).sort()).toEqual(["flow", "intent"]);
    expect(req.model).toBe("custom-model");
  });

  test("mismatch: intent question + flow plan → warning, both fields kept", async () => {
    const { deps } = depsWith(async () => ({
      answers: { intent: answer("question"), flow: answer("plan") },
    }));
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision?.intent).toBe("question");
    expect(decision?.flow).toBe("plan");
    expect(decision?.warnings.length).toBeGreaterThan(0);
  });

  test("escape: intent other / flow none are valid without mismatch warnings", async () => {
    const { deps } = depsWith(async () => ({
      answers: { intent: answer("other"), flow: answer("none") },
    }));
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision).toEqual({ intent: "other", flow: "none", warnings: [] });
  });

  test("inverse mismatch: intent bugfix + flow answer → warning, both fields kept", async () => {
    const { deps } = depsWith(async () => ({
      answers: { intent: answer("bugfix"), flow: answer("answer") },
    }));
    const decision = await classifyIntentWithJev(input, cfg(), deps);
    expect(decision?.intent).toBe("bugfix");
    expect(decision?.flow).toBe("answer");
    expect(decision?.warnings.length).toBeGreaterThan(0);
  });

  test("enums are exposed with the expected members", () => {
    expect([...JEV_INTENTS]).toEqual([
      "bugfix",
      "feature",
      "refactor",
      "question",
      "other",
      "none",
    ]);
    expect([...JEV_FLOWS]).toEqual(["answer", "adhoc", "plan", "none"]);
  });
});
