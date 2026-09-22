import { describe, expect, test } from "bun:test";
import type { JevConfig } from "../config/schema.ts";
import type { JevClassifierDeps } from "./jev.ts";
import type { RoutedTask, RoutingDecision, TaskRequest } from "./scheduler.ts";
import { canRunParallel, routeTask } from "./scheduler.ts";

const mk = (overrides: Partial<TaskRequest> & Pick<TaskRequest, "type">): TaskRequest => ({
  description: "test task",
  risk: "low",
  ...overrides,
});

// ─── routeTask ────────────────────────────────────────────────────────

describe("routeTask", () => {
  describe("priority rules", () => {
    test("explore → scout", async () => {
      const d = await routeTask(mk({ type: "explore" }));
      expect(d.agent).toBe("scout");
      expect(d.parallel).toBe(true);
    });

    test("research → scribe", async () => {
      const d = await routeTask(mk({ type: "research" }));
      expect(d.agent).toBe("scribe");
      expect(d.parallel).toBe(true);
    });

    test("design + vue → painter", async () => {
      const d = await routeTask(mk({ type: "design", stack: "vue" }));
      expect(d.agent).toBe("painter");
      expect(d.parallel).toBe(true);
    });

    test("design + non-vue stack → smith (default)", async () => {
      const d = await routeTask(mk({ type: "design", stack: "js" }));
      expect(d.agent).toBe("smith");
    });

    test("audit → inspector", async () => {
      const d = await routeTask(mk({ type: "audit" }));
      expect(d.agent).toBe("inspector");
      expect(d.parallel).toBe(true);
    });

    test("document → chronicler", async () => {
      const d = await routeTask(mk({ type: "document" }));
      expect(d.agent).toBe("chronicler");
      expect(d.parallel).toBe(true);
    });

    test("debate → guild, not parallel", async () => {
      const d = await routeTask(mk({ type: "debate" }));
      expect(d.agent).toBe("guild");
      expect(d.parallel).toBe(false);
    });

    test("debug + high risk → sage, not parallel", async () => {
      const d = await routeTask(mk({ type: "debug", risk: "high" }));
      expect(d.agent).toBe("sage");
      expect(d.parallel).toBe(false);
    });

    test("debug + low risk → smith (default)", async () => {
      const d = await routeTask(mk({ type: "debug", risk: "low" }));
      expect(d.agent).toBe("smith");
    });

    test("implement + js → js-smith", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "js" }));
      expect(d.agent).toBe("js-smith");
      expect(d.parallel).toBe(true);
    });

    test("implement + go → go-smith", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "go" }));
      expect(d.agent).toBe("go-smith");
    });

    test("implement + python → python-smith", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "python" }));
      expect(d.agent).toBe("python-smith");
    });

    test("implement + zig → zig-smith", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "zig" }));
      expect(d.agent).toBe("zig-smith");
    });

    test("implement + vue → vue-smith", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "vue" }));
      expect(d.agent).toBe("vue-smith");
    });

    test("implement + generic → smith", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "generic" }));
      expect(d.agent).toBe("smith");
    });

    test("implement + unknown → smith", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "unknown" }));
      expect(d.agent).toBe("smith");
    });

    test("implement + no stack → smith", async () => {
      const d = await routeTask(mk({ type: "implement" }));
      expect(d.agent).toBe("smith");
    });
  });

  describe("dependencies semantics", () => {
    test("all routeTask results have empty dependencies (task IDs set externally)", async () => {
      const cases: TaskRequest[] = [
        mk({ type: "explore" }),
        mk({ type: "research" }),
        mk({ type: "design", stack: "vue" }),
        mk({ type: "audit" }),
        mk({ type: "document" }),
        mk({ type: "debate" }),
        mk({ type: "debug", risk: "high" }),
        mk({ type: "implement", stack: "js" }),
      ];
      for (const req of cases) {
        const d = await routeTask(req);
        expect(d.dependencies).toEqual([]);
      }
    });

    test("dependencies are task IDs, never agent names", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "js", risk: "high" }));
      // Bug was: dependencies: ["sage"] — agent name in task ID field
      expect(d.dependencies).toEqual([]);
      expect(d.dependencies).not.toContain("sage");
    });
  });

  describe("requiresReview (sage advisory)", () => {
    test("high-risk implement sets requiresReview to sage", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "js", risk: "high" }));
      expect(d.requiresReview).toBe("sage");
      expect(d.agent).toBe("js-smith");
      expect(d.parallel).toBe(true);
    });

    test("high-risk implement + go → go-smith with sage review", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "go", risk: "high" }));
      expect(d.agent).toBe("go-smith");
      expect(d.requiresReview).toBe("sage");
    });

    test("low-risk implement has no requiresReview", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "js" }));
      expect(d.requiresReview).toBeUndefined();
    });

    test("non-implement tasks have no requiresReview", async () => {
      const d = await routeTask(mk({ type: "explore", risk: "high" }));
      expect(d.requiresReview).toBeUndefined();
    });

    test("debug + high risk has no requiresReview (goes to sage directly)", async () => {
      const d = await routeTask(mk({ type: "debug", risk: "high" }));
      expect(d.requiresReview).toBeUndefined();
      expect(d.agent).toBe("sage");
    });
  });

  describe("hybrid routing (JEV)", () => {
    const jevCfg: JevConfig = { enabled: true, model: "jev-latest", timeoutMs: 1000 };
    const choice = (c: string) => ({ type: "choice", choice: c, confidence: 0.9 });
    const okDeps = (answers: Record<string, unknown>): JevClassifierDeps => ({
      apiKey: "test-key",
      log: () => {},
      clientFactory: () => ({ systemOne: async () => ({ answers }) }),
    });
    const failDeps = (): JevClassifierDeps => ({
      apiKey: "test-key",
      log: () => {},
      clientFactory: () => ({
        systemOne: async () => {
          throw new Error("JEV down");
        },
      }),
    });

    test("without jev option → pure heuristic with source rules", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "js" }));
      expect(d.agent).toBe("js-smith");
      expect(d.source).toBe("rules");
    });

    test("JEV agent overrides heuristic agent and marks source", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "js" }), {
        jev: jevCfg,
        jevDeps: okDeps({
          agent: choice("craftsman"),
          type: choice("implement"),
          risk: choice("low"),
        }),
      });
      expect(d.agent).toBe("craftsman");
      expect(d.source).toBe("jev");
      expect(d.parallel).toBe(true);
    });

    test("JEV type drives heuristic parallelism (debate → not parallel)", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "js" }), {
        jev: jevCfg,
        jevDeps: okDeps({ type: choice("debate") }),
      });
      expect(d.agent).toBe("guild");
      expect(d.parallel).toBe(false);
      expect(d.source).toBe("jev");
    });

    test("JEV risk drives sage review advisory", async () => {
      const d = await routeTask(mk({ type: "implement", stack: "js" }), {
        jev: jevCfg,
        jevDeps: okDeps({ risk: choice("high") }),
      });
      expect(d.agent).toBe("js-smith");
      expect(d.requiresReview).toBe("sage");
      expect(d.source).toBe("jev");
    });

    test("JEV failure falls back to identical heuristic result", async () => {
      const request = mk({ type: "implement", stack: "js", risk: "high" });
      const d = await routeTask(request, { jev: jevCfg, jevDeps: failDeps() });
      const baseline = await routeTask(request);
      expect(d).toEqual(baseline);
      expect(d.source).toBe("rules");
    });

    test("JEV disabled → rules source, factory never called", async () => {
      let called = 0;
      const deps: JevClassifierDeps = {
        apiKey: "test-key",
        log: () => {},
        clientFactory: () => {
          called += 1;
          return { systemOne: async () => ({ answers: {} }) };
        },
      };
      const d = await routeTask(mk({ type: "audit" }), {
        jev: { ...jevCfg, enabled: false },
        jevDeps: deps,
      });
      expect(d.source).toBe("rules");
      expect(called).toBe(0);
    });
  });
});

// ─── canRunParallel ───────────────────────────────────────────────────

describe("canRunParallel", () => {
  const makeRouted = (
    id: string,
    agent: string,
    opts: Partial<Pick<RoutingDecision, "parallel" | "dependencies">> = {},
  ): RoutedTask => ({
    id,
    decision: {
      agent,
      reason: "test",
      parallel: opts.parallel ?? true,
      dependencies: opts.dependencies ?? [],
    },
  });

  test("all parallel, no deps → true", () => {
    expect(
      canRunParallel([
        makeRouted("t1", "scout"),
        makeRouted("t2", "scribe"),
        makeRouted("t3", "js-smith"),
      ]),
    ).toBe(true);
  });

  test("one non-parallel task → false", () => {
    expect(
      canRunParallel([makeRouted("t1", "scout"), makeRouted("t2", "guild", { parallel: false })]),
    ).toBe(false);
  });

  test("dependency on external task (not in batch) → true", () => {
    expect(
      canRunParallel([
        makeRouted("t1", "js-smith", { dependencies: ["t-external"] }),
        makeRouted("t2", "scout"),
      ]),
    ).toBe(true);
  });

  test("dependency on task in same batch → false", () => {
    expect(
      canRunParallel([
        makeRouted("t1", "scout"),
        makeRouted("t2", "js-smith", { dependencies: ["t1"] }),
      ]),
    ).toBe(false);
  });

  test("circular dependency in batch → false", () => {
    const result = canRunParallel([
      makeRouted("t1", "js-smith", { dependencies: ["t2"] }),
      makeRouted("t2", "scout", { dependencies: ["t1"] }),
    ]);
    expect(result).toBe(false);
  });

  test("empty batch → true", () => {
    expect(canRunParallel([])).toBe(true);
  });

  test("single task, parallel, no deps → true", () => {
    expect(canRunParallel([makeRouted("t1", "scout")])).toBe(true);
  });

  test("single task, non-parallel → false", () => {
    expect(canRunParallel([makeRouted("t1", "guild", { parallel: false })])).toBe(false);
  });

  test("multiple deps, only one in batch → false", () => {
    expect(
      canRunParallel([
        makeRouted("t1", "scout"),
        makeRouted("t2", "scribe"),
        makeRouted("t3", "js-smith", { dependencies: ["t-external", "t1"] }),
      ]),
    ).toBe(false);
  });

  test("requiresReview does not affect parallelism", () => {
    // sage review is advisory, not a blocking dependency
    const tasks: RoutedTask[] = [
      {
        id: "t1",
        decision: {
          agent: "js-smith",
          reason: "test",
          parallel: true,
          dependencies: [],
          requiresReview: "sage",
        },
      },
      makeRouted("t2", "scout"),
    ];
    expect(canRunParallel(tasks)).toBe(true);
  });
});

// ─── canRunParallel (legacy RoutingDecision[] path) ───────────────────

describe("canRunParallel (legacy RoutingDecision[])", () => {
  test("all parallel, no deps → true", () => {
    const decisions: RoutingDecision[] = [
      { agent: "scout", reason: "test", parallel: true, dependencies: [] },
      { agent: "scribe", reason: "test", parallel: true, dependencies: [] },
    ];
    expect(canRunParallel(decisions)).toBe(true);
  });

  test("one non-parallel → false", () => {
    const decisions: RoutingDecision[] = [
      { agent: "scout", reason: "test", parallel: true, dependencies: [] },
      { agent: "guild", reason: "test", parallel: false, dependencies: [] },
    ];
    expect(canRunParallel(decisions)).toBe(false);
  });

  test("agent-name dependency in batch → false (legacy semantic)", () => {
    const decisions: RoutingDecision[] = [
      { agent: "scout", reason: "test", parallel: true, dependencies: [] },
      { agent: "js-smith", reason: "test", parallel: true, dependencies: ["scout"] },
    ];
    expect(canRunParallel(decisions)).toBe(false);
  });

  test("agent-name dependency not in batch → true", () => {
    const decisions: RoutingDecision[] = [
      { agent: "js-smith", reason: "test", parallel: true, dependencies: ["sage"] },
    ];
    expect(canRunParallel(decisions)).toBe(true);
  });
});
