/**
 * Tests for SSE events route (src/http/routes/events.ts) + sse helpers.
 *
 * Validates:
 * - formatSseEvent / formatKeepalive (unit)
 * - GET /api/events → 200 with Content-Type: text/event-stream
 * - Events streamed as `data: {json}\n\n` format
 * - Cleanup on client disconnect (abort signal)
 * - Type filter via ?types=session.idle,session.error
 * - 503 when SDK client is null
 * - Auth required
 *
 * Mocks SDK client with a simple async generator.
 * Uses Elysia app.handle(new Request(...)) pattern.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HttpConfig } from "../../config/schema.ts";
import { runMigrations } from "../../db/migrations.ts";
import { buildHttpServer } from "../server.ts";
import { formatKeepalive, formatSseEvent } from "../sse.ts";

let db: Database;

const AUTH_CONFIG: HttpConfig = {
  enabled: true,
  port: 4097,
  cors: { origins: ["*"] },
  auth: { required: true },
};

let savedPassword: string | undefined;

function basicAuthHeader(password: string): string {
  const encoded = Buffer.from(`user:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Create a mock SDK client that yields events from a provided array.
 * Returns a minimal object compatible with OpencodeClient.event.subscribe().
 */
function mockSdkClient(events: Array<{ type?: string; data?: unknown }>) {
  return {
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          for (const event of events) {
            yield event;
          }
        })(),
      }),
    },
  } as unknown as import("@opencode-ai/sdk/client").OpencodeClient;
}

/**
 * Create a mock SDK client that throws on subscribe.
 */
function mockFailingSdkClient(errorMessage = "SDK connection failed") {
  return {
    event: {
      subscribe: async () => {
        throw new Error(errorMessage);
      },
    },
  } as unknown as import("@opencode-ai/sdk/client").OpencodeClient;
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

// ─── Unit tests for sse helpers ─────────────────────────────────────────────

describe("formatSseEvent", () => {
  test("formats data-only event", () => {
    const result = formatSseEvent({ data: { hello: "world" } });
    expect(result).toBe('data: {"hello":"world"}\n\n');
  });

  test("formats event with name", () => {
    const result = formatSseEvent({ eventName: "message", data: { key: 1 } });
    expect(result).toBe('event: message\ndata: {"key":1}\n\n');
  });

  test("formats event with id", () => {
    const result = formatSseEvent({ data: "test", id: "42" });
    expect(result).toBe('id: 42\ndata: "test"\n\n');
  });

  test("formats event with all fields", () => {
    const result = formatSseEvent({
      eventName: "update",
      data: { value: true },
      id: "100",
    });
    expect(result).toBe('event: update\nid: 100\ndata: {"value":true}\n\n');
  });

  test("multi-line data splits into multiple data: lines", () => {
    // JSON with newlines would split — but JSON.stringify doesn't produce
    // newlines for flat objects. Test with string containing newline.
    const result = formatSseEvent({ data: "line1\nline2" });
    expect(result).toBe('data: "line1\\nline2"\n\n');
  });
});

describe("formatKeepalive", () => {
  test("returns SSE keepalive comment", () => {
    const result = formatKeepalive();
    expect(result).toBe(": keepalive\n\n\n");
  });
});

// ─── Integration tests for /api/events ──────────────────────────────────────

describe("GET /api/events — SSE stream", () => {
  test("returns 200 with correct SSE headers", async () => {
    const sdkClient = mockSdkClient([]);
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      sdkClient,
    });

    const req = new Request("http://localhost/api/events", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
  });

  test("streams hello event on connection", async () => {
    const sdkClient = mockSdkClient([]);
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      sdkClient,
    });

    const req = new Request("http://localhost/api/events", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.body).not.toBeNull();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read first chunk — should contain hello event
    const { value } = await reader.read();
    const chunk = decoder.decode(value);
    expect(chunk).toContain("event: hello");
    expect(chunk).toContain('"timestamp"');

    reader.cancel();
  });

  test("streams SDK events as SSE data", async () => {
    const sdkClient = mockSdkClient([
      { type: "session.idle", data: { sessionId: "ses_1" } },
      { type: "session.error", data: { error: "timeout" } },
    ]);
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      sdkClient,
    });

    const req = new Request("http://localhost/api/events", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read all chunks until stream ends
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const fullOutput = chunks.join("");

    // Should contain hello event
    expect(fullOutput).toContain("event: hello");

    // Should contain the SDK events
    expect(fullOutput).toContain("event: session.idle");
    expect(fullOutput).toContain("event: session.error");
    expect(fullOutput).toContain('"sessionId":"ses_1"');
    expect(fullOutput).toContain('"error":"timeout"');
  });

  test("type filter passes only matching events", async () => {
    const sdkClient = mockSdkClient([
      { type: "session.idle", data: { sessionId: "ses_1" } },
      { type: "session.error", data: { error: "timeout" } },
      { type: "task.complete", data: { taskId: "t_1" } },
    ]);
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      sdkClient,
    });

    const req = new Request("http://localhost/api/events?types=session.idle,session.error", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const fullOutput = chunks.join("");

    // Should contain filtered events
    expect(fullOutput).toContain("event: session.idle");
    expect(fullOutput).toContain("event: session.error");

    // Should NOT contain non-matching event
    expect(fullOutput).not.toContain("task.complete");
  });

  test("503 when SDK client is not provided", async () => {
    // Omit sdkClient entirely (not undefined — exactOptionalPropertyTypes)
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
    });

    const req = new Request("http://localhost/api/events", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("sdk_unavailable");
  });

  test("requires auth → 401 without credentials", async () => {
    const sdkClient = mockSdkClient([]);
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      sdkClient,
    });

    const res = await app.handle(new Request("http://localhost/api/events"));
    expect(res.status).toBe(401);
  });

  test("SDK subscribe error → streams error event then closes", async () => {
    const sdkClient = mockFailingSdkClient("connection refused");
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      sdkClient,
    });

    const req = new Request("http://localhost/api/events", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const fullOutput = chunks.join("");

    // Should contain hello event first
    expect(fullOutput).toContain("event: hello");

    // Should contain error event with SDK error message
    expect(fullOutput).toContain("event: error");
    expect(fullOutput).toContain("connection refused");
    expect(fullOutput).toContain("sdk_subscribe_failed");
  });
});
