/**
 * Tests for SSE events route (src/http/routes/events.ts) + sse helpers.
 *
 * Validates:
 * - formatSseEvent / formatKeepalive (unit)
 * - GET /api/events → 200 with Content-Type: text/event-stream
 * - Events streamed as `data: {json}\n\n` format
 * - Cleanup on client disconnect (abort signal)
 * - Type filter via ?types=plan.created,task.updated
 * - SDK events forwarded when sdkClient provided
 * - NO 503 when SDK client is null (route still works via bus-only)
 * - /api/events is EXEMPT from Basic Auth (browser EventSource can't send
 *   Authorization headers; route is read-only)
 * - bus.onAny events (plan.created, task.updated, session.*) reach the SSE
 *   stream — the live-reactivity core of this feature
 *
 * Mocks SDK client with a simple async generator.
 * Mocks bus by using a local createBus() instance via direct module access
 * (the route uses the singleton, so we emit on that singleton from tests).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HttpConfig } from "../../config/schema.ts";
import { runMigrations } from "../../db/migrations.ts";
import { bus } from "../../events/bus.ts";
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
  // Make sure no listeners leak between tests
  bus.removeAllListeners();
});

afterEach(() => {
  if (savedPassword === undefined) {
    delete process.env.OPENCODE_SERVER_PASSWORD;
  } else {
    process.env.OPENCODE_SERVER_PASSWORD = savedPassword;
  }
  bus.removeAllListeners();
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

    // Cleanup: cancel reader so the stream unblocks.
    if (res.body) await res.body.cancel();
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

    // Read bounded chunks — stream stays open for bus+keepalive,
    // so we can't wait for done. SDK events appear within first few chunks.
    let fullOutput = "";
    for (let i = 0; i < 10; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      fullOutput += decoder.decode(value);
      // Early exit once both SDK events seen
      if (fullOutput.includes("session.idle") && fullOutput.includes("session.error")) break;
    }

    reader.cancel();

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

    // Bounded reads — stream stays open, SDK events appear within first few chunks
    let fullOutput = "";
    for (let i = 0; i < 10; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      fullOutput += decoder.decode(value);
      if (fullOutput.includes("session.idle") && fullOutput.includes("session.error")) break;
    }

    reader.cancel();

    // Should contain filtered events
    expect(fullOutput).toContain("event: session.idle");
    expect(fullOutput).toContain("event: session.error");

    // Should NOT contain non-matching event
    expect(fullOutput).not.toContain("task.complete");
  });

  // ── Updated behavior: route does NOT return 503 when SDK client is null ──
  // The previous behavior returned 503 because the route required the SDK
  // stream. New behavior: the route works off the in-process event bus
  // (always available). SDK client is optional overlay.
  test("does NOT return 503 when SDK client is not provided (bus-only mode)", async () => {
    // Omit sdkClient entirely — the route must still work via the bus.
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
    });

    const req = new Request("http://localhost/api/events", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // Confirm the stream actually flows: read the hello event
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const chunk = decoder.decode(value);
    expect(chunk).toContain("event: hello");
    reader.cancel();
  });

  // ── Updated behavior: /api/events is EXEMPT from Basic Auth ──
  // Browser EventSource cannot send custom Authorization headers. The route
  // is read-only (no mutations), so it must be reachable without credentials.
  test("/api/events is exempt from Basic Auth — accessible without credentials", async () => {
    const sdkClient = mockSdkClient([]);
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
      sdkClient,
    });

    // No Authorization header — request must succeed.
    const res = await app.handle(new Request("http://localhost/api/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // Confirm the stream flows
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    expect(decoder.decode(value)).toContain("event: hello");
    reader.cancel();
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

    // Bounded reads — stream stays open for bus, SDK error appears within first few chunks
    let fullOutput = "";
    for (let i = 0; i < 10; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      fullOutput += decoder.decode(value);
      if (fullOutput.includes("sdk_subscribe_failed")) break;
    }

    reader.cancel();

    // Should contain hello event first
    expect(fullOutput).toContain("event: hello");

    // Should contain error event with SDK error message
    expect(fullOutput).toContain("event: error");
    expect(fullOutput).toContain("connection refused");
    expect(fullOutput).toContain("sdk_subscribe_failed");
  });
});

// ─── Bus-driven events (live-reactivity core of this feature) ───────────────

describe("GET /api/events — bus events", () => {
  test("bus-emitted plan.created reaches SSE client", async () => {
    // Build app with NO SDK client — bus is the only source.
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
    });

    const req = new Request("http://localhost/api/events", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the hello chunk first
    const helloChunk = decoder.decode((await reader.read()).value);
    expect(helloChunk).toContain("event: hello");

    // Now emit a bus event — should appear in the next chunk
    bus.emit({
      type: "plan.created",
      planId: "p_new",
      slug: "live-plan",
      title: "Live Plan",
      status: "draft",
      priority: 2,
      timestamp: Date.now(),
    });

    // Read up to ~5 more chunks looking for the plan.created event
    let found = false;
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      if (chunk.includes("event: plan.created")) {
        expect(chunk).toContain('"planId":"p_new"');
        expect(chunk).toContain('"slug":"live-plan"');
        found = true;
        break;
      }
    }
    expect(found).toBe(true);

    reader.cancel();
  });

  test("bus-emitted task.updated reaches SSE client with filter", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
    });

    // Filter ONLY task.updated (plan.created should be filtered out)
    const req = new Request(
      "http://localhost/api/events?types=task.updated",
      {
        headers: { Authorization: basicAuthHeader("test-password") },
      },
    );
    const res = await app.handle(req);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the hello chunk
    decoder.decode((await reader.read()).value);

    // Emit two events — only task.updated should pass the filter
    bus.emit({
      type: "plan.created",
      planId: "p1",
      slug: "x",
      title: "X",
      status: "draft",
      priority: 2,
      timestamp: Date.now(),
    });
    bus.emit({
      type: "task.updated",
      taskId: "t1",
      planId: "p1",
      agent: "craftsman",
      status: "done",
      timestamp: Date.now(),
    });

    // Read chunks: hello + (plan.created filtered) + task.updated
    let foundTask = false;
    let foundPlan = false;
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      if (chunk.includes("event: task.updated")) {
        expect(chunk).toContain('"taskId":"t1"');
        expect(chunk).toContain('"status":"done"');
        foundTask = true;
      }
      if (chunk.includes("event: plan.created")) {
        foundPlan = true;
      }
      // If we already saw task.updated and a keepalive or empty chunk
      // arrives, we can stop.
      if (foundTask) break;
    }
    expect(foundTask).toBe(true);
    expect(foundPlan).toBe(false); // filtered out

    reader.cancel();
  });

  test("bus-emitted session.* events reach SSE client", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
    });

    const req = new Request("http://localhost/api/events", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the hello chunk
    decoder.decode((await reader.read()).value);

    bus.emit({
      type: "session.started",
      sessionId: "s_live",
      planId: "p1",
      goal: "ship live reactivity",
      timestamp: Date.now(),
    });

    let found = false;
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      if (chunk.includes("event: session.started")) {
        expect(chunk).toContain('"sessionId":"s_live"');
        expect(chunk).toContain('"goal":"ship live reactivity"');
        found = true;
        break;
      }
    }
    expect(found).toBe(true);

    reader.cancel();
  });

  test("bus listener is unregistered on client disconnect", async () => {
    const { app } = await buildHttpServer({
      db,
      httpConfig: AUTH_CONFIG,
    });

    // Subscribe then immediately cancel — bus should drop the listener
    const req = new Request("http://localhost/api/events", {
      headers: { Authorization: basicAuthHeader("test-password") },
    });
    const res = await app.handle(req);

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    dec.decode((await reader.read()).value); // hello

    const listenersBefore = bus.listenerCount();
    await reader.cancel();
    // Give the cleanup microtasks a chance to run
    await new Promise((r) => setTimeout(r, 5));
    const listenersAfter = bus.listenerCount();
    expect(listenersAfter).toBeLessThan(listenersBefore);
  });
});