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
  analyzeTaskDependencies,
  DEP_CHOICES,
  DEP_KEYWORDS,
  MAX_DEP_PAIRS,
  MAX_DEPS_TASKS,
  type TaskDepInput,
} from "./jev-deps.ts";

/** Helper: build a JevConfig with defaults. */
const cfg = (overrides: Partial<JevConfig> = {}): JevConfig => ({
  enabled: true,
  model: "jev-latest",
  timeoutMs: 3000,
  ...overrides,
});

/** Helper: a valid choice answer. */
const answer = (choice: string) => ({ type: "choice", choice, confidence: 0.9 });

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

beforeEach(() => {
  resetJevWarningState();
});

describe("analyzeTaskDependencies — contract constants", () => {
  test("exposes the frozen enums and caps", () => {
    expect(DEP_CHOICES).toEqual(["a_first", "b_first", "independent", "none"]);
    expect(MAX_DEPS_TASKS).toBe(8);
    expect(MAX_DEP_PAIRS).toBe(28);
    expect(DEP_KEYWORDS).toContain("after");
    expect(DEP_KEYWORDS).toContain("builds on");
  });
});

describe("analyzeTaskDependencies — deterministic rules (no JEV)", () => {
  test("1. no candidates → rules, no factory call, one wave", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "write the parser", files: ["src/a.ts"] },
      { id: "b", description: "write the lexer", files: ["src/b.ts"] },
    ];
    const { deps, factoryCalls } = depsWith(async () => ({ answers: {} }));
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.source).toBe("rules");
    expect(factoryCalls()).toBe(0);
    expect(decision.pairs).toHaveLength(1);
    expect(decision.pairs[0]?.suggested).toBe("independent");
    expect(decision.edges).toEqual([]);
    expect(decision.waves).toEqual([["a", "b"]]);
    expect(decision.dropped).toEqual([]);
    expect(decision.truncated).toBe(false);
  });

  test("4. keyword on B with JEV disabled → a_first (rules)", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "implement core", files: ["src/a.ts"] },
      { id: "b", description: "add feature after core lands", files: ["src/b.ts"] },
    ];
    const { deps, factoryCalls } = depsWith(async () => ({ answers: {} }));
    const decision = await analyzeTaskDependencies(tasks, cfg({ enabled: false }), deps);

    expect(factoryCalls()).toBe(0);
    expect(decision.source).toBe("rules");
    expect(decision.pairs[0]?.suggested).toBe("a_first");
    expect(decision.pairs[0]?.hints).toContain("keyword on B: after");
    expect(decision.edges).toEqual([{ from: "a", to: "b" }]);
    expect(decision.warnings).toContain("JEV unavailable — rules-only dependency analysis");
  });

  test("5. keyword on A → b_first (rules)", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "do X after Y", files: ["src/a.ts"] },
      { id: "b", description: "prepare Y", files: ["src/b.ts"] },
    ];
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await analyzeTaskDependencies(tasks, cfg({ enabled: false }), deps);

    expect(decision.source).toBe("rules");
    expect(decision.pairs[0]?.suggested).toBe("b_first");
    expect(decision.edges).toEqual([{ from: "b", to: "a" }]);
  });

  test("6. keyword on both + overlap → none + dropped(none), no edge", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "step after setup", files: ["src/x.ts"] },
      { id: "b", description: "another after step", files: ["src/x.ts"] },
    ];
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await analyzeTaskDependencies(tasks, cfg({ enabled: false }), deps);

    expect(decision.source).toBe("rules");
    expect(decision.pairs[0]?.suggested).toBe("none");
    expect(decision.pairs[0]?.overlapFiles).toEqual(["src/x.ts"]);
    expect(decision.edges).toEqual([]);
    expect(decision.dropped).toEqual([{ a: "a", b: "b", reason: "none" }]);
  });

  test("7. no keyword + no overlap → independent, no dropped, one wave", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "first thing" },
      { id: "b", description: "second thing" },
    ];
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await analyzeTaskDependencies(tasks, cfg({ enabled: false }), deps);

    expect(decision.pairs[0]?.suggested).toBe("independent");
    expect(decision.dropped).toEqual([]);
    expect(decision.edges).toEqual([]);
    expect(decision.waves).toEqual([["a", "b"]]);
  });

  test("17. files undefined → no overlap, no crash", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "first" },
      { id: "b", description: "second", files: ["src/b.ts"] },
    ];
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await analyzeTaskDependencies(tasks, cfg({ enabled: false }), deps);

    expect(decision.source).toBe("rules");
    expect(decision.pairs[0]?.overlapFiles).toEqual([]);
    expect(decision.edges).toEqual([]);
  });
});

describe("analyzeTaskDependencies — JEV answers", () => {
  test("2. keyword on B + JEV a_first → edge a→b, source jev", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "implement core", files: ["src/a.ts"] },
      { id: "b", description: "add feature after core lands", files: ["src/b.ts"] },
    ];
    const { deps, factoryCalls } = depsWith(async () => ({
      answers: { pair_0: answer("a_first") },
    }));
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(factoryCalls()).toBe(1);
    expect(decision.source).toBe("jev");
    expect(decision.pairs[0]?.source).toBe("jev");
    expect(decision.edges).toEqual([{ from: "a", to: "b" }]);
    expect(decision.waves).toEqual([["a"], ["b"]]);
  });

  test("3. overlap → hint shared files; JEV b_first → edge b→a", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "first change", files: ["src/x.ts"] },
      { id: "b", description: "second change", files: ["src/x.ts"] },
    ];
    const { deps } = depsWith(async () => ({
      answers: { pair_0: answer("b_first") },
    }));
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.source).toBe("jev");
    expect(decision.pairs[0]?.hints).toContain("shared files: src/x.ts");
    expect(decision.edges).toEqual([{ from: "b", to: "a" }]);
  });

  test("11. JEV choice none → dropped(none), no edge, source jev", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "implement core", files: ["src/a.ts"] },
      { id: "b", description: "add feature after core lands", files: ["src/b.ts"] },
    ];
    const { deps } = depsWith(async () => ({
      answers: { pair_0: answer("none") },
    }));
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.source).toBe("jev");
    expect(decision.pairs[0]?.suggested).toBe("none");
    expect(decision.edges).toEqual([]);
    expect(decision.dropped).toEqual([{ a: "a", b: "b", reason: "none" }]);
  });

  test("10. one invalid + one valid answer → hybrid + per-pair warning", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "start after setup", files: ["src/a.ts"] },
      { id: "b", description: "middle work", files: ["src/b.ts"] },
      { id: "c", description: "finish work", files: ["src/c.ts"] },
    ];
    const { deps } = depsWith(async () => ({
      answers: { pair_0: answer("b_first"), pair_1: answer("nonsense") },
    }));
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.source).toBe("hybrid");
    expect(decision.pairs[0]?.source).toBe("jev");
    expect(decision.pairs[1]?.source).toBe("rules");
    expect(decision.warnings).toContain(
      "pair a|c: JEV answer invalid/absent — deterministic fallback",
    );
  });

  test("12. cycle a→b→c→a → one edge dropped(cycle) + warning + all tasks in waves", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "alpha", files: ["src/x.ts"] },
      { id: "b", description: "beta", files: ["src/x.ts"] },
      { id: "c", description: "gamma", files: ["src/x.ts"] },
    ];
    const { deps } = depsWith(async () => ({
      answers: {
        pair_0: answer("a_first"), // a → b
        pair_1: answer("b_first"), // c → a
        pair_2: answer("a_first"), // b → c
      },
    }));
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.source).toBe("jev");
    const cycleDrops = decision.dropped.filter((drop) => drop.reason === "cycle");
    expect(cycleDrops).toEqual([{ a: "b", b: "c", reason: "cycle" }]);
    expect(decision.edges).toHaveLength(2);
    expect(decision.waves.flat().sort()).toEqual(["a", "b", "c"]);
    expect(decision.warnings.some((w) => w.includes("cycle detected"))).toBe(true);
  });

  test("14. chain a→b→c + independent d → waves [[a,d],[b],[c]]", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "build core", files: ["src/a.ts"], orderIndex: 0 },
      { id: "b", description: "feature after core", files: ["src/b.ts"], orderIndex: 1 },
      { id: "c", description: "docs after feature", files: ["src/c.ts"], orderIndex: 2 },
      { id: "d", description: "unrelated note", files: ["src/d.ts"], orderIndex: 3 },
    ];
    const { deps } = depsWith(async () => ({
      answers: {
        pair_0: answer("a_first"), // a → b
        pair_1: answer("independent"), // a, c
        pair_3: answer("a_first"), // b → c
        pair_4: answer("independent"), // b, d (keyword on b)
        pair_5: answer("independent"), // c, d (keyword on c)
      },
    }));
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.source).toBe("jev");
    expect(decision.waves).toEqual([["a", "d"], ["b"], ["c"]]);
  });

  test("16. suggestions map dependents to unique from-ids", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "alpha", files: ["src/x.ts"] },
      { id: "b", description: "beta", files: ["src/x.ts"] },
      { id: "c", description: "gamma", files: ["src/x.ts"] },
    ];
    const { deps } = depsWith(async () => ({
      answers: {
        pair_0: answer("independent"), // a, b
        pair_1: answer("a_first"), // a → c
        pair_2: answer("a_first"), // b → c
      },
    }));
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.suggestions.c).toEqual(["a", "b"]);
    expect(new Set(decision.suggestions.c).size).toBe(decision.suggestions.c?.length ?? 0);
    expect(decision.suggestions.a).toBeUndefined();
    expect(decision.suggestions.b).toBeUndefined();
  });

  test("15. state/questions keys, task+pair payloads, model propagated, description capped", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: `${"x".repeat(350)} after`, files: ["src/a.ts"] },
      { id: "b", description: "second", files: ["src/b.ts"] },
    ];
    const { deps, calls } = depsWith(async () => ({
      answers: { pair_0: answer("a_first") },
    }));
    await analyzeTaskDependencies(tasks, cfg({ model: "custom-model" }), deps);

    expect(calls).toHaveLength(1);
    const req = calls[0];
    if (!req) throw new Error("expected one captured request");
    const state = req.state as {
      tasks: Array<{ id: string; description: string; files: string[] }>;
      pairs: Array<{ key: string }>;
    };
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks[0]?.description.length).toBe(300);
    expect(state.tasks[0]?.files).toEqual(["src/a.ts"]);
    expect(state.pairs).toHaveLength(1);
    expect(state.pairs[0]?.key).toBe("pair_0");
    expect(Object.keys(req.questions)).toEqual(["pair_0"]);
    expect(req.model).toBe("custom-model");
  });
});

describe("analyzeTaskDependencies — never-throw fallbacks", () => {
  test("8. JEV client throws → source rules, never throws", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "implement core", files: ["src/a.ts"] },
      { id: "b", description: "add feature after core lands", files: ["src/b.ts"] },
    ];
    const { deps } = depsWith(async () => {
      throw new Error("API down");
    });
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.source).toBe("rules");
    expect(decision.warnings).toContain("JEV unavailable — rules-only dependency analysis");
    expect(decision.edges).toEqual([{ from: "a", to: "b" }]);
  });

  test("9. JEV timeout → source rules", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "implement core", files: ["src/a.ts"] },
      { id: "b", description: "add feature after core lands", files: ["src/b.ts"] },
    ];
    const { deps } = depsWith(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ answers: { pair_0: answer("a_first") } }), 50),
        ),
    );
    const started = Date.now();
    const decision = await analyzeTaskDependencies(tasks, cfg({ timeoutMs: 10 }), deps);

    expect(decision.source).toBe("rules");
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("missing API key → source rules, factory never called", async () => {
    const tasks: TaskDepInput[] = [
      { id: "a", description: "implement core", files: ["src/a.ts"] },
      { id: "b", description: "add feature after core lands", files: ["src/b.ts"] },
    ];
    const { deps, factoryCalls } = depsWith(async () => ({ answers: {} }), "");
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.source).toBe("rules");
    expect(factoryCalls()).toBe(0);
  });
});

describe("analyzeTaskDependencies — caps", () => {
  test("13. 9 tasks → truncated, warning, 28 pairs, first 8 by orderIndex", async () => {
    const tasks: TaskDepInput[] = Array.from({ length: 9 }, (_, k) => {
      const n = 8 - k; // input order reversed: t8 first, t0 last
      return { id: `t${n}`, description: `task ${n}`, files: [`src/t${n}.ts`], orderIndex: n };
    });
    const { deps } = depsWith(async () => ({ answers: {} }));
    const decision = await analyzeTaskDependencies(tasks, cfg(), deps);

    expect(decision.truncated).toBe(true);
    expect(decision.warnings).toContain("analyzed first 8 of 9 tasks");
    expect(decision.pairs).toHaveLength(MAX_DEP_PAIRS);
    expect(decision.pairs.every((pair) => pair.a !== "t8" && pair.b !== "t8")).toBe(true);
    const ids = new Set(decision.pairs.flatMap((pair) => [pair.a, pair.b]));
    expect(ids.has("t0")).toBe(true);
    expect(ids.has("t7")).toBe(true);
    expect(ids.has("t8")).toBe(false);
  });
});
