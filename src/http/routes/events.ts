// ─── SSE Events Route ────────────────────────────────────────────────────────
/**
 * GET /api/events — Server-Sent Events stream bridging the in-process event
 * bus (`src/events/bus.ts`) and — when reachable — the OpenCode SDK.
 *
 * Auth: EXEMPT from Basic Auth (browser EventSource can't send custom
 * headers). See src/http/auth.ts. The route is a read-only push channel;
 * no mutations are accepted here.
 *
 * Query params:
 *   ?types=plan.created,task.updated  — comma-separated event type filter
 *                                        (default: ALL bus events + SDK events)
 *
 * Sources (fan-in):
 *   1. In-process bus (src/events/bus.ts) — emits plan.* / task.* / session.*
 *      from DB writers and tool wrappers. Always available.
 *   2. OpenCode SDK client (sdkClient.event.subscribe()) — emits session.* /
 *      message.* / tool.* events from the OpenCode runtime. Optional; if the
 *      SDK client is null we simply skip this source (no 503).
 *
 * Wire format (encoded by src/http/sse.ts):
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * Cleanup: every source is wired to the request AbortSignal so client
 * disconnects unregister bus listeners and close the SDK stream generator.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { Elysia, t } from "elysia";
import type { NdomoEvent } from "../../events/bus.ts";
import { bus } from "../../events/bus.ts";
import { formatKeepalive, formatSseEvent } from "../sse.ts";

const KEEPALIVE_INTERVAL_MS = 30_000;

interface EventsRouteOpts {
  /** OpenCode SDK client. If null/undefined, SDK events are silently skipped. */
  sdkClient?: OpencodeClient | null;
}

/**
 * Create the SSE events route. Subscribes to the bus + SDK (when available)
 * and streams events as `text/event-stream`.
 */
export function eventsRoute(opts: EventsRouteOpts = {}) {
  const sdkClient = opts.sdkClient ?? null;

  return new Elysia({ name: "events" }).get(
    "/api/events",
    ({ request, query }) => {
      // Parse optional event-type filter (?types=a,b,c). null = pass all.
      const filterTypes = query.types
        ? new Set(
            query.types
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        : null;

      // Track cleanup fns so both request.signal abort AND stream cancel
      // can trigger them. In test contexts (app.handle), reader.cancel()
      // closes the ReadableStream but does NOT fire request.signal — so
      // we must wire cleanup to the stream cancel callback as well.
      const cleanups: Array<() => void> = [];
      let cleanedUp = false;
      const runCleanups = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        for (const cb of cleanups) {
          try { cb(); } catch { /* ignore */ }
        }
      };

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const signal = request.signal;
          const encoder = new TextEncoder();

          // Keepalive timer — prevents proxy/load-balancer timeouts
          const keepaliveTimer = setInterval(
            () => {
              try { controller.enqueue(encoder.encode(formatKeepalive())); }
              catch { /* closed */ }
            },
            KEEPALIVE_INTERVAL_MS,
          );
          cleanups.push(() => clearInterval(keepaliveTimer));

          // Wire request.signal abort → cleanups
          signal.addEventListener("abort", runCleanups, { once: true });

          try {
            // Hello on connect — clients can use this to detect stream establish
            const helloChunk = formatSseEvent({ eventName: "hello", data: { timestamp: Date.now() } });
            controller.enqueue(encoder.encode(helloChunk));

            // ── Bus source (always) ────────────────────────────────────────
            const busHandler = (event: NdomoEvent): void => {
              if (signal.aborted) return;
              if (filterTypes && !filterTypes.has(event.type)) return;
              try {
                const chunk = formatSseEvent({ eventName: event.type, data: event });
                controller.enqueue(encoder.encode(chunk));
              } catch { /* closed */ }
            };
            bus.onAny(busHandler);
            cleanups.push(() => bus.offAny(busHandler));

            // ── SDK source (optional) ───────────────────────────────────────
            const sdkLoop = (async (): Promise<void> => {
              if (!sdkClient) return;
              try {
                const result = await sdkClient.event.subscribe();
                for await (const event of result.stream) {
                  if (signal.aborted) break;
                  const eventName =
                    (event as { type?: string })?.type ?? "message";
                  if (filterTypes && !filterTypes.has(eventName)) continue;
                  try {
                    const chunk = formatSseEvent({ eventName, data: event });
                    controller.enqueue(encoder.encode(chunk));
                  } catch { break; }
                }
              } catch (err) {
                if (signal.aborted) return;
                try {
                  const chunk = formatSseEvent({
                    eventName: "error",
                    data: {
                      message: err instanceof Error ? err.message : String(err),
                      code: "sdk_subscribe_failed",
                    },
                  });
                  controller.enqueue(encoder.encode(chunk));
                } catch { /* closed */ }
              }
            })();
            cleanups.push(() => { sdkLoop.catch(() => {}); });

            // ── Keep stream open until abort ───────────────────────────────
            await new Promise<void>((resolve) => {
              if (signal.aborted) { resolve(); return; }
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          } catch (err) {
            if (!signal.aborted) {
              try {
                const chunk = formatSseEvent({
                  eventName: "error",
                  data: {
                    message: err instanceof Error ? err.message : String(err),
                    code: "stream_failed",
                  },
                });
                controller.enqueue(encoder.encode(chunk));
              } catch { /* closed */ }
            }
          } finally {
            runCleanups();
            try { controller.close(); } catch { /* already closed */ }
          }
        },
        cancel() {
          // Stream cancelled (reader.cancel() or client disconnect).
          // In test context, request.signal may NOT fire — this is the
          // primary cleanup path for ReadableStream consumers.
          runCleanups();
        },
      });

      // SSE response headers
      setResponseHeaders();

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no", // disable nginx buffering
        },
      });
    },
    {
      query: t.Object({
        types: t.Optional(t.String()),
      }),
    },
  );
}

/**
 * Standalone helper exported so future routes can reuse the SSE header set.
 * Elysia mutates `set.headers` to apply response headers.
 */
function setResponseHeaders(): void {
  // no-op — handled inline above. Kept for future expansion.
}