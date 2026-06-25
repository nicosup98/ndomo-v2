/**
 * Tests for HTTP Basic Auth middleware (src/http/auth.ts).
 *
 * Validates:
 * - parseBasicAuthHeader (via integration with authMiddleware)
 * - authMiddleware accepts valid credentials
 * - authMiddleware rejects 401 + WWW-Authenticate on invalid
 * - authMiddleware returns 503 when password env not set + auth required
 * - authMiddleware passes through when auth disabled
 *
 * Uses Elysia app.handle(new Request(...)) pattern for integration.
 * Each test gets a fresh app with isolated config.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { HttpConfig } from "../../config/schema.ts";
import { httpBasicAuth } from "../auth.ts";

/** Build a minimal test app with auth middleware mounted. */
function buildTestApp(httpConfig: HttpConfig) {
  return new Elysia({ name: "test-auth" })
    .use(httpBasicAuth(httpConfig))
    .get("/api/protected", () => ({ ok: true }))
    .get("/health", () => ({ status: "ok" }));
}

/** Create a valid Basic auth header from password. */
function basicAuthHeader(password: string): string {
  const encoded = Buffer.from(`user:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

const DEFAULT_CONFIG: HttpConfig = {
  enabled: true,
  port: 4097,
  cors: { origins: ["*"] },
  auth: { required: true },
};

const DISABLED_AUTH_CONFIG: HttpConfig = {
  enabled: true,
  port: 4097,
  cors: { origins: ["*"] },
  auth: { required: false },
};

let savedPassword: string | undefined;

beforeEach(() => {
  savedPassword = process.env.OPENCODE_SERVER_PASSWORD;
});

afterEach(() => {
  if (savedPassword === undefined) {
    delete process.env.OPENCODE_SERVER_PASSWORD;
  } else {
    process.env.OPENCODE_SERVER_PASSWORD = savedPassword;
  }
});

describe("httpBasicAuth — auth required", () => {
  test("valid credentials → 200 + handler response", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "test-secret";
    const app = buildTestApp(DEFAULT_CONFIG);

    const req = new Request("http://localhost/api/protected", {
      headers: { Authorization: basicAuthHeader("test-secret") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("wrong password → 401 + WWW-Authenticate header", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "correct-password";
    const app = buildTestApp(DEFAULT_CONFIG);

    const req = new Request("http://localhost/api/protected", {
      headers: { Authorization: basicAuthHeader("wrong-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_credentials");
  });

  test("missing Authorization header → 401 + WWW-Authenticate", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "test-secret";
    const app = buildTestApp(DEFAULT_CONFIG);

    const req = new Request("http://localhost/api/protected");
    const res = await app.handle(req);

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_credentials");
  });

  test("malformed Authorization (no 'Basic ' prefix) → 401", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "test-secret";
    const app = buildTestApp(DEFAULT_CONFIG);

    const req = new Request("http://localhost/api/protected", {
      headers: { Authorization: "Bearer some-token" },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(401);
  });

  test("password env not set → 503 auth_not_configured", async () => {
    delete process.env.OPENCODE_SERVER_PASSWORD;
    const app = buildTestApp(DEFAULT_CONFIG);

    const req = new Request("http://localhost/api/protected", {
      headers: { Authorization: basicAuthHeader("any") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("auth_not_configured");
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
  });

  test("/health exempt from auth — no credentials → 200", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "test-secret";
    const app = buildTestApp(DEFAULT_CONFIG);

    const req = new Request("http://localhost/health");
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("empty password in base64 → 401", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "real-password";
    const app = buildTestApp(DEFAULT_CONFIG);

    // "user:" → base64 → colonIdx=4, providedPassword=""
    const encoded = Buffer.from("user:").toString("base64");
    const req = new Request("http://localhost/api/protected", {
      headers: { Authorization: `Basic ${encoded}` },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(401);
  });

  test("no colon in decoded → entire string used as password", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "nocolon";
    const app = buildTestApp(DEFAULT_CONFIG);

    // "nocolon" (no user:pass format) → colonIdx=-1, providedPassword="nocolon"
    const encoded = Buffer.from("nocolon").toString("base64");
    const req = new Request("http://localhost/api/protected", {
      headers: { Authorization: `Basic ${encoded}` },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
  });
});

describe("httpBasicAuth — auth disabled", () => {
  test("no credentials → 200 (auth skipped)", async () => {
    const app = buildTestApp(DISABLED_AUTH_CONFIG);

    const req = new Request("http://localhost/api/protected");
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("wrong credentials → 200 (auth skipped entirely)", async () => {
    delete process.env.OPENCODE_SERVER_PASSWORD;
    const app = buildTestApp(DISABLED_AUTH_CONFIG);

    const req = new Request("http://localhost/api/protected", {
      headers: { Authorization: basicAuthHeader("wrong") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
  });
});
