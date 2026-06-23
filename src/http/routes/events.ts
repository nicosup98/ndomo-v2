// ─── SSE Events Route ────────────────────────────────────────────────────────
/**
 * GET /api/events — Server-Sent Events stream bridging OpenCode SDK events.
 *
 * Auth: inherited from apiProtected sub-app (httpBasicAuth).
 *
 * Query params:
 *   ?types=session.idle,session.error  — comma-separated event type filter (default: all)
 *
 * Behavior:
 * - 503 if SDK client is null (server reachable but SDK unreachable)
 * - Sends `hello` event on connection establish (client can detect connect)
 * - Streams events from `sdkClient.event.subscribe()` as SSE
 * - Keepalive comment every 30s to prevent proxy timeouts
 * - Cleanup on client disconnect (abort signal)
 * - On SDK error, sends `error` event then closes stream
 *
 * SSE spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { Elysia, t } from "elysia";
import { createSseWriter } from "../sse.ts";

const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * Create the SSE events route.
 *
 * @param sdkClient - OpenCode SDK client (may be null if SDK unreachable)
 */
export function eventsRoute(sdkClient: OpencodeClient | null) {
  return new Elysia({ name: "events" }).get(
    "/api/events",
    async ({ request, query, set }) => {
      // 503 if SDK client is null (server reachable but no client)
      if (!sdkClient) {
        set.status = 503;
        return {
          error: "sdk_unavailable",
          message: "OpenCode SDK client not initialized",
        };
      }

      // Parse optional event type filter
      const filterTypes = query.types
        ? new Set(
            query.types
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        : null; // null = all events

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const signal = request.signal;
          const writer = createSseWriter(controller, signal);

          // Keepalive timer — prevents proxy/load-balancer timeouts
          const keepaliveTimer = setInterval(() => writer.writeKeepalive(), KEEPALIVE_INTERVAL_MS);
          writer.onCleanup(() => clearInterval(keepaliveTimer));

          try {
            // Hello event — client can detect connection established
            writer.write("hello", { timestamp: Date.now() });

            // Subscribe to SDK events (async generator)
            const result = await sdkClient.event.subscribe();

            for await (const event of result.stream) {
              if (signal.aborted) break;
              // Apply type filter if specified
              if (filterTypes && event.type && !filterTypes.has(event.type)) continue;
              const eventName = event.type ?? "message";
              writer.write(eventName, event);
            }
          } catch (err) {
            // On SDK error, send a final error event then end
            writer.write("error", {
              message: err instanceof Error ? err.message : String(err),
              code: "sdk_subscribe_failed",
            });
          } finally {
            clearInterval(keepaliveTimer);
            writer.end();
          }
        },
      });

      // SSE response headers
      set.headers["Content-Type"] = "text/event-stream";
      set.headers["Cache-Control"] = "no-cache, no-transform";
      set.headers["Connection"] = "keep-alive";
      set.headers["X-Accel-Buffering"] = "no"; // disable nginx buffering

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    },
    {
      query: t.Object({
        types: t.Optional(t.String()), // comma-separated event type filter
      }),
    },
  );
}
