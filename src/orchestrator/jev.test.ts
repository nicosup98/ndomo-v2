import { beforeEach, describe, expect, test } from "bun:test";
import type { JevConfig } from "../config/schema.ts";
import type {
  JevClassifierDeps,
  JevClientLike,
  JevRequestOptions,
  JevSystemOneRequest,
} from "./jev.ts";
import { classifyTaskWithJev, resetJevWarningState } from "./jev.ts";

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

const task = { description: "add a flag to the parser", files: ["src/parser.ts"], stack: "go" };

beforeEach(() => {
  resetJevWarningState();
});

describe("classifyTaskWithJev", () => {
  test("happy path: three valid choices → full decision", async () => {
    const { deps } = depsWith(async () => ({
      answers: {
        agent: answer("craftsman"),
        type: answer("implement"),
        risk: answer("high"),
      },
    }));
    const decision = await classifyTaskWithJev(task, cfg(), deps);
    expect(decision).toEqual({ agent: "craftsman", type: "implement", risk: "high" });
  });

  test("partial answers: keeps valid fields, drops invalid ones", async () => {
    const { deps } = depsWith(async () => ({
      answers: {
        agent: answer("ranger"),
        type: answer("not-a-type"),
        risk: { type: "choice" }, // no choice string
      },
    }));
    const decision = await classifyTaskWithJev(task, cfg(), deps);
    expect(decision).toEqual({ agent: "ranger" });
  });

  test("all answers invalid → null", async () => {
    const { deps } = depsWith(async () => ({
      answers: { agent: "craftsman", type: answer(42 as unknown as string), risk: null },
    }));
    const decision = await classifyTaskWithJev(task, cfg(), deps);
    expect(decision).toBeNull();
  });

  test("API error → null (never throws)", async () => {
    const { deps } = depsWith(async () => {
      throw new Error("API down");
    });
    const decision = await classifyTaskWithJev(task, cfg(), deps);
    expect(decision).toBeNull();
  });

  test("timeout → null via AbortSignal race", async () => {
    const { deps } = depsWith(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ answers: { agent: answer("warden") } }), 50),
        ),
    );
    const started = Date.now();
    const decision = await classifyTaskWithJev(task, cfg({ timeoutMs: 10 }), deps);
    expect(decision).toBeNull();
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("client factory throwing → null", async () => {
    const deps: JevClassifierDeps = {
      apiKey: "test-key",
      log: () => {},
      clientFactory: () => {
        throw new Error("bad client config");
      },
    };
    const decision = await classifyTaskWithJev(task, cfg(), deps);
    expect(decision).toBeNull();
  });

  test("missing API key → null and factory is never called", async () => {
    const { deps, factoryCalls } = depsWith(
      async () => ({
        answers: { agent: answer("ranger") },
      }),
      "",
    );
    const decision = await classifyTaskWithJev(task, cfg(), deps);
    expect(decision).toBeNull();
    expect(factoryCalls()).toBe(0);
  });

  test("enabled=false → null and factory is never called", async () => {
    const { deps, factoryCalls } = depsWith(async () => ({
      answers: { agent: answer("ranger") },
    }));
    const decision = await classifyTaskWithJev(task, cfg({ enabled: false }), deps);
    expect(decision).toBeNull();
    expect(factoryCalls()).toBe(0);
  });

  test("sends description/files/stack as state and model from config", async () => {
    const { deps, calls, opts } = depsWith(async () => ({
      answers: {
        agent: answer("ranger"),
        type: answer("explore"),
        risk: answer("low"),
      },
    }));
    await classifyTaskWithJev(task, cfg({ model: "custom-model", timeoutMs: 1234 }), deps);
    expect(calls).toHaveLength(1);
    const req = calls[0];
    if (!req) throw new Error("expected one captured request");
    expect(req.state).toEqual({
      description: "add a flag to the parser",
      files: ["src/parser.ts"],
      stack: "go",
    });
    expect(req.model).toBe("custom-model");
    expect(Object.keys(req.questions).sort()).toEqual(["agent", "risk", "type"]);
    expect(opts[0]?.timeout).toBe(1234);
    expect(opts[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("omits files when empty and stack when unknown", async () => {
    const { deps, calls } = depsWith(async () => ({
      answers: { type: answer("implement") },
    }));
    await classifyTaskWithJev(
      { description: "generic task", files: [], stack: "unknown" },
      cfg(),
      deps,
    );
    const req = calls[0];
    if (!req) throw new Error("expected one captured request");
    expect(req.state).toEqual({ description: "generic task" });
  });

  test("returns null when answers are missing entirely", async () => {
    const { deps } = depsWith(async () => ({}));
    const decision = await classifyTaskWithJev(task, cfg(), deps);
    expect(decision).toBeNull();
  });
});
