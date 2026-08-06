/**
 * Integration tests for HTTP REST endpoints (src/http/routes/*).
 *
 * Covers:
 * - GET /health → 200, status/version/uptime/dbHealthy
 * - GET /api/plans → 200, returns array (seeds test data)
 * - GET /api/plans/:id → 200 known / 404 unknown
 * - GET /api/tasks?planId=X → 200, filter works
 * - GET /api/tasks/:id → 200 / 404
 * - GET /api/sessions/active → 200, active sessions
 * - GET /api/sessions/:id → 200 / 404
 * - Auth enforcement: no auth → 401, valid auth → 200
 * - CORS preflight OPTIONS → 204 with headers
 * - Security headers present on all responses
 *
 * Uses in-memory SQLite via bun:sqlite. Each test suite gets a fresh DB.
 * Uses Elysia app.handle(new Request(...)) pattern.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HttpConfig } from "../../config/schema.ts";
import { runMigrations } from "../../db/migrations.ts";
import { createPlan } from "../../db/plans.ts";
import { startSession } from "../../db/sessions.ts";
import { createTasksBatch } from "../../db/tasks.ts";
import type { Plan } from "../../db/types.ts";
import { buildHttpServer } from "../server.ts";

let db: Database;

const AUTH_CONFIG: HttpConfig = {
  enabled: true,
  port: 4097,
  cors: { origins: ["*"] },
  auth: { required: true },
};

const NO_AUTH_CONFIG: HttpConfig = {
  enabled: true,
  port: 4097,
  cors: { origins: ["*"] },
  auth: { required: false },
};

const CORS_CONFIG: HttpConfig = {
  enabled: true,
  port: 4097,
  cors: { origins: ["https://example.com"] },
  auth: { required: false },
};

let savedPassword: string | undefined;

function basicAuthHeader(password: string): string {
  const encoded = Buffer.from(`user:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

function makePlan(overrides: Partial<Parameters<typeof createPlan>[1]> = {}): Plan {
  return createPlan(db, {
    id: crypto.randomUUID(),
    slug: "test-plan",
    title: "Test Plan",
    status: "draft",
    priority: 2,
    approvedAt: null,
    completedAt: null,
    sessionId: null,
    overview: "test overview",
    approach: null,
    complexity: 3,
    createdBy: "test",
    updatedBy: "test",
    sourceSessionId: null,
    sourceMessageId: null,
    category: null,
    owner: "foreman",
    metadata: {},
    archivedAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  savedPassword = process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_SERVER_PASSWORD = "test-password";
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  if (savedPassword === undefined) {
    delete process.env.OPENCODE_SERVER_PASSWORD;
  } else {
    process.env.OPENCODE_SERVER_PASSWORD = savedPassword;
  }
  db.close();
});

describe("GET /health", () => {
  test("returns 200 with status, version, uptime, dbHealthy", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: NO_AUTH_CONFIG });
    const res = await app.handle(new Request("http://localhost/health"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      version: string;
      uptime: number;
      timestamp: number;
      dbHealthy: boolean;
    };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.timestamp).toBe("number");
    expect(body.dbHealthy).toBe(true);
  });

  test("health is exempt from auth", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const res = await app.handle(new Request("http://localhost/health"));

    expect(res.status).toBe(200);
  });
});

describe("GET /api/plans", () => {
  test("returns 200 with array of plans", async () => {
    makePlan({ slug: "plan-1", title: "Plan One" });
    makePlan({ slug: "plan-2", title: "Plan Two" });

    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/plans", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
  });

  test("returns empty array when no plans", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/plans", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  test("requires auth → 401 without credentials", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const res = await app.handle(new Request("http://localhost/api/plans"));

    expect(res.status).toBe(401);
  });

  test("auth disabled → 200 without credentials", async () => {
    makePlan();
    const { app } = await buildHttpServer({ db, httpConfig: NO_AUTH_CONFIG });
    const res = await app.handle(new Request("http://localhost/api/plans"));

    expect(res.status).toBe(200);
  });
});

describe("GET /api/plans/:id", () => {
  test("returns 200 for known plan id", async () => {
    const plan = makePlan({ slug: "known-plan" });

    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request(`http://localhost/api/plans/${plan.id}`, {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; slug: string };
    expect(body.id).toBe(plan.id);
    expect(body.slug).toBe("known-plan");
  });

  test("returns 404 for unknown plan id", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/plans/nonexistent-id", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("GET /api/tasks", () => {
  test("returns tasks filtered by planId", async () => {
    const plan = makePlan();
    createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "task-1",
        agent: "test",
        files: [],
        complexity: 1,
        dependencies: [],
        createdBy: "test",
        updatedBy: "test",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
      {
        orderIndex: 1,
        description: "task-2",
        agent: "test",
        files: [],
        complexity: 1,
        dependencies: [],
        createdBy: "test",
        updatedBy: "test",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
    ]);

    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request(`http://localhost/api/tasks?planId=${plan.id}`, {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(2);
  });

  test("returns 422 without planId query param", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/tasks", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(422);
  });
});

describe("GET /api/tasks/:id", () => {
  test("returns 200 for known task id", async () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "known-task",
        agent: "test",
        files: [],
        complexity: 1,
        dependencies: [],
        createdBy: "test",
        updatedBy: "test",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
    ]);
    const taskId = tasks[0]?.id as string;

    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request(`http://localhost/api/tasks/${taskId}`, {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; description: string };
    expect(body.id).toBe(taskId);
    expect(body.description).toBe("known-task");
  });

  test("returns 404 for unknown task id", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/tasks/nonexistent", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(404);
  });
});

describe("GET /api/sessions", () => {
  test("returns sessions list", async () => {
    startSession(db, { id: "ses_test_1", goal: "test goal" });
    startSession(db, { id: "ses_test_2", goal: "test goal 2" });

    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/sessions", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(2);
  });
});

describe("GET /api/sessions/active", () => {
  test("returns only active sessions (endedAt === null)", async () => {
    startSession(db, { id: "ses_active_1", goal: "active goal" });
    startSession(db, { id: "ses_active_2", goal: "another active" });

    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/sessions/active", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(2);
    for (const session of body as Array<{ endedAt: number | null }>) {
      expect(session.endedAt).toBeNull();
    }
  });
});

describe("GET /api/sessions/:id", () => {
  test("returns 200 for known session id", async () => {
    startSession(db, { id: "ses_known", goal: "known goal" });

    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/sessions/ses_known", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("ses_known");
  });

  test("returns 404 for unknown session id", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/sessions/nonexistent", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(404);
  });
});

describe("CORS preflight", () => {
  test("OPTIONS → 204 with CORS headers", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: NO_AUTH_CONFIG });
    const req = new Request("http://localhost/api/plans", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBeDefined();
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  test("wildcard origins → ACAO: *", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: NO_AUTH_CONFIG });
    const req = new Request("http://localhost/api/plans", {
      headers: { Origin: "https://any-origin.com" },
    });
    const res = await app.handle(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("restricted origins → echoes matching origin", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: CORS_CONFIG });
    const req = new Request("http://localhost/api/plans", {
      headers: { Origin: "https://example.com" },
    });
    const res = await app.handle(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  test("restricted origins → no ACAO for non-matching origin", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: CORS_CONFIG });
    const req = new Request("http://localhost/api/plans", {
      headers: { Origin: "https://evil.com" },
    });
    const res = await app.handle(req);

    // No Access-Control-Allow-Origin for non-matching origins
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("Security headers", () => {
  test("responses include X-Content-Type-Options", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: NO_AUTH_CONFIG });
    const res = await app.handle(new Request("http://localhost/health"));

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("responses include X-Frame-Options", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: NO_AUTH_CONFIG });
    const res = await app.handle(new Request("http://localhost/health"));

    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("responses include X-Powered-By: ndomo", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: NO_AUTH_CONFIG });
    const res = await app.handle(new Request("http://localhost/health"));

    expect(res.headers.get("X-Powered-By")).toBe("ndomo");
  });

  test("responses include Referrer-Policy", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: NO_AUTH_CONFIG });
    const res = await app.handle(new Request("http://localhost/health"));

    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  test("security headers on API routes too", async () => {
    const { app } = await buildHttpServer({ db, httpConfig: AUTH_CONFIG });
    const req = new Request("http://localhost/api/plans", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
