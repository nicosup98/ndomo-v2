/**
 * Tests for SPA static-file serving + client-side routing fallback.
 *
 * Uses a temp directory with a fake index.html + asset to avoid
 * depending on `bun run web:build` output in CI.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HttpConfig } from "../../config/schema.ts";
import { runMigrations } from "../../db/migrations.ts";
import { buildHttpServer } from "../server.ts";

let db: Database;
let webDir: string;
let savedPassword: string | undefined;

const AUTH_CONFIG: HttpConfig = {
  enabled: true,
  port: 4098,
  cors: { origins: ["*"] },
  auth: { required: true },
};

const NO_AUTH_CONFIG: HttpConfig = {
  enabled: true,
  port: 4098,
  cors: { origins: ["*"] },
  auth: { required: false },
};

function basicAuthHeader(password: string): string {
  const encoded = Buffer.from(`user:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

beforeEach(() => {
  savedPassword = process.env.OPENCODE_SERVER_PASSWORD;
  process.env.OPENCODE_SERVER_PASSWORD = "test-password";
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);

  // Create temp web dist with fake SPA files
  webDir = mkdtempSync(join(tmpdir(), "ndomo-spa-test-"));
  writeFileSync(
    join(webDir, "index.html"),
    '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
  );
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(
    join(webDir, "assets", "index-abc123.js"),
    'console.log("spa");',
  );
  writeFileSync(
    join(webDir, "assets", "index-abc123.css"),
    "body{margin:0}",
  );
});

afterEach(() => {
  if (savedPassword === undefined) {
    delete process.env.OPENCODE_SERVER_PASSWORD;
  } else {
    process.env.OPENCODE_SERVER_PASSWORD = savedPassword;
  }
  db.close();
  rmSync(webDir, { recursive: true, force: true });
});

describe("SPA root GET /", () => {
  test("returns 200 text/html with <div id='app'>", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: NO_AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(new Request("http://localhost/"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('<div id="app"></div>');
  });
});

describe("SPA client-side routing fallback", () => {
  test("unknown path returns index.html (SPA fallback)", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: NO_AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(new Request("http://localhost/some/spa/route"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('<div id="app"></div>');
  });
});

describe("SPA static assets", () => {
  test("serves JS asset with correct content type", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: NO_AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(
      new Request("http://localhost/assets/index-abc123.js"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/javascript");
    const body = await res.text();
    expect(body).toContain('console.log("spa")');
  });

  test("serves CSS asset with correct content type", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: NO_AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(
      new Request("http://localhost/assets/index-abc123.css"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
  });
});

describe("SPA does NOT swallow /api/*", () => {
  test("GET /health returns JSON (not SPA)", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: NO_AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(new Request("http://localhost/health"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("GET /api/plans without auth returns 401 (not SPA)", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(new Request("http://localhost/api/plans"));

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_credentials");
  });

  test("GET /api/plans with auth returns 200 JSON", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(
      new Request("http://localhost/api/plans", {
        headers: { Authorization: basicAuthHeader("test-password") },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("GET /api/plans/nonexistent returns 404 JSON (not SPA fallback)", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(
      new Request("http://localhost/api/plans/nonexistent-id", {
        headers: { Authorization: basicAuthHeader("test-password") },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("SPA path traversal defense", () => {
  test("path traversal attempt does not serve /etc/passwd", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: NO_AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(
      new Request("http://localhost/../../etc/passwd"),
    );

    // Must not serve /etc/passwd — either 200 (SPA fallback) or 400
    if (res.status === 200) {
      const body = await res.text();
      expect(body).toContain('<div id="app"></div>');
      expect(body).not.toContain("root:");
    } else {
      expect([400, 404]).toContain(res.status);
    }
  });
});

describe("SPA disabled when web dir missing", () => {
  test("returns 503 when webDistDir does not exist", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: NO_AUTH_CONFIG,
      webDistDir: "/nonexistent/path",
    });
    const res = await app.handle(new Request("http://localhost/"));

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("SPA not built");
  });
});

describe("SPA non-GET methods", () => {
  test("POST to SPA path returns 404 (Elysia GET handler does not match)", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: NO_AUTH_CONFIG,
      webDistDir: webDir,
    });
    const res = await app.handle(
      new Request("http://localhost/some/path", { method: "POST" }),
    );

    // Elysia .get() does not match POST → 404
    expect(res.status).toBe(404);
  });
});
